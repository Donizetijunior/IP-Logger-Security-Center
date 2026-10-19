import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Ctx } from '../context.ts';
import { iso } from '../util.ts';

const PERIODS = {
  '24h': { interval: '24 hours', step: '1 hour' },
  '7d': { interval: '7 days', step: '6 hours' },
  '30d': { interval: '30 days', step: '1 day' },
} as const;

const periodQuery = z.object({ period: z.enum(['24h', '7d', '30d']).default('24h') });

export function registerDashboard(app: FastifyInstance, ctx: Ctx): void {
  const { pool } = ctx;

  app.get('/dashboard/summary', async (req) => {
    const { period } = periodQuery.parse(req.query);
    const { interval } = PERIODS[period];
    const [agg, links, alerts, capture, heartbeat] = await Promise.all([
      pool.query<Record<string, number>>(
        `SELECT count(*)::int AS requests_total,
                count(DISTINCT ip_address)::int AS unique_ips,
                count(*) FILTER (WHERE client_class = 'human_probable' AND method = 'GET')::int AS estimated_visits,
                count(*) FILTER (WHERE client_class = 'bot')::int AS bots,
                count(*) FILTER (WHERE client_class = 'preview')::int AS previews,
                count(*) FILTER (WHERE client_class = 'head_probe')::int AS head_probes,
                count(*) FILTER (WHERE risk_level = 'high')::int AS high_risk,
                count(*) FILTER (WHERE enrichment_status = 'failed')::int AS enrichment_failed,
                count(*) FILTER (WHERE enrichment_status = 'pending')::int AS enrichment_pending
         FROM access_events WHERE occurred_at >= now() - $1::interval`, [interval],
      ),
      pool.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM short_links WHERE deleted_at IS NULL AND is_active AND (expires_at IS NULL OR expires_at > now())`,
      ),
      pool.query<{ severity: string; n: number }>(
        `SELECT severity, count(*)::int AS n FROM alerts WHERE status <> 'resolved' GROUP BY severity`,
      ),
      pool.query<{ n: number | null }>(
        `SELECT COALESCE(sum(value), 0)::int AS n FROM telemetry_counters WHERE key = 'capture_failed' AND bucket >= now() - $1::interval`, [interval],
      ),
      pool.query<{ value: { at?: string }; updated_at: Date }>(`SELECT value, updated_at FROM job_state WHERE key = 'worker_heartbeat'`),
    ]);
    const a = agg.rows[0]!;
    const hb = heartbeat.rows[0];
    return {
      period,
      generatedAt: new Date().toISOString(),
      requestsTotal: a.requests_total,
      uniqueIps: a.unique_ips,
      estimatedVisits: a.estimated_visits,
      estimatedVisitsNote: 'Estimativa: GET com User-Agent de navegador convencional; não é clique humano confirmado. HEAD, bots e prévias são excluídos.',
      breakdown: { bots: a.bots, previews: a.previews, headProbes: a.head_probes },
      activeLinks: links.rows[0]!.n,
      highRiskEvents: a.high_risk,
      enrichmentFailures: a.enrichment_failed,
      enrichmentPending: a.enrichment_pending,
      captureFailures: capture.rows[0]?.n ?? 0,
      openAlerts: Object.fromEntries(alerts.rows.map((r) => [r.severity, r.n])),
      workerHeartbeatAt: hb ? iso(hb.updated_at) : null,
    };
  });

  app.get('/dashboard/timeseries', async (req) => {
    const { period } = periodQuery.parse(req.query);
    const { interval, step } = PERIODS[period];
    const { rows } = await pool.query<{ bucket: Date; total: number; human: number; bot: number; preview: number }>(
      `WITH series AS (
         SELECT generate_series(
           date_bin($2::interval, now() - $1::interval, TIMESTAMPTZ '2000-01-01'),
           date_bin($2::interval, now(), TIMESTAMPTZ '2000-01-01'),
           $2::interval) AS bucket
       ), counts AS (
         SELECT date_bin($2::interval, occurred_at, TIMESTAMPTZ '2000-01-01') AS bucket,
                count(*)::int AS total,
                count(*) FILTER (WHERE client_class = 'human_probable' AND method = 'GET')::int AS human,
                count(*) FILTER (WHERE client_class = 'bot')::int AS bot,
                count(*) FILTER (WHERE client_class = 'preview')::int AS preview
         FROM access_events WHERE occurred_at >= now() - $1::interval GROUP BY 1
       )
       SELECT s.bucket, COALESCE(c.total, 0) AS total, COALESCE(c.human, 0) AS human, COALESCE(c.bot, 0) AS bot, COALESCE(c.preview, 0) AS preview
       FROM series s LEFT JOIN counts c USING (bucket) ORDER BY s.bucket`,
      [interval, step],
    );
    return {
      period,
      step,
      points: rows.map((r) => ({ at: iso(r.bucket), total: r.total, estimatedVisits: r.human, bots: r.bot, previews: r.preview })),
    };
  });
}
