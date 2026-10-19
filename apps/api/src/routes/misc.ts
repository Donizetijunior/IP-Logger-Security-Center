import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { DEFAULT_RISK_CONFIG, RISK_ENGINE_VERSION } from '@ipl/shared';
import type { Ctx } from '../context.ts';
import { decodeCursor, encodeCursor, iso, requireAdmin } from '../util.ts';

export function registerMisc(app: FastifyInstance, ctx: Ctx): void {
  const { pool, config } = ctx;

  app.get('/integrations/status', async (req) => {
    requireAdmin(req);
    const [quota, stats, jobs] = await Promise.all([
      pool.query<{ source: string; used: number }>(
        'SELECT source, used FROM provider_quota WHERE window_start = (now() AT TIME ZONE \'UTC\')::date',
      ),
      pool.query<{ source: string; status: string; n: number; last_checked: Date }>(
        `SELECT source, status, count(*)::int AS n, max(checked_at) AS last_checked
         FROM ip_intelligence WHERE checked_at > now() - interval '24 hours' GROUP BY source, status`,
      ),
      pool.query<{ key: string; value: Record<string, unknown>; updated_at: Date }>(
        `SELECT key, value, updated_at FROM job_state
         WHERE key IN ('worker_heartbeat', 'provider:abuseipdb', 'provider:greynoise', 'geoip', 'tor_list', 'purge', 'outbox')`,
      ),
    ]);
    const used = new Map(quota.rows.map((q) => [q.source, q.used]));
    const job = new Map(jobs.rows.map((j) => [j.key, j]));
    const byStatus = (source: string) =>
      Object.fromEntries(stats.rows.filter((s) => s.source === source).map((s) => [s.status, s.n]));
    const lastChecked = (source: string) => iso(stats.rows.filter((s) => s.source === source).map((s) => s.last_checked).sort().pop() ?? null);
    const provider = (source: 'abuseipdb' | 'greynoise', enabled: boolean, hasKey: boolean, dailyQuota: number) => ({
      source,
      enabled,
      configured: hasKey,
      state: !enabled ? 'disabled' : !hasKey ? 'missing_key' : 'active',
      dailyQuota,
      usedToday: used.get(source) ?? 0,
      circuit: job.get(`provider:${source}`)?.value ?? { state: 'closed' },
      last24h: byStatus(source),
      lastCheckedAt: lastChecked(source),
      cacheTtlHours: config.PROVIDER_CACHE_TTL_HOURS,
    });
    return {
      providers: [
        provider('abuseipdb', config.ABUSEIPDB_ENABLED, !!config.ABUSEIPDB_API_KEY, config.ABUSEIPDB_DAILY_QUOTA),
        provider('greynoise', config.GREYNOISE_ENABLED, !!config.GREYNOISE_API_KEY, config.GREYNOISE_DAILY_QUOTA),
        { ...(job.get('geoip')?.value ?? { state: 'unknown' }), source: 'geolite2', enabled: config.GEOLITE2_ENABLED },
        { ...(job.get('tor_list')?.value ?? { state: 'unknown' }), source: 'tor', enabled: config.TOR_EXIT_LIST_ENABLED, updatedAt: iso(job.get('tor_list')?.updated_at) },
        { source: 'rdap', enabled: config.RDAP_ENABLED },
      ],
      jobs: {
        workerHeartbeatAt: iso(job.get('worker_heartbeat')?.updated_at),
        worker: job.get('worker_heartbeat')?.value ?? null,
        outbox: job.get('outbox')?.value ?? null,
        lastPurge: job.get('purge')?.value ?? null,
      },
    };
  });

  app.get('/settings', async (req) => {
    requireAdmin(req);
    return {
    retentionDays: config.ANALYTICS_RETENTION_DAYS,
    retentionReadOnly: true,
    auditRetentionDays: config.AUDIT_RETENTION_DAYS,
    exportTtlMinutes: config.EXPORT_TTL_MINUTES,
    shortBaseUrl: config.PUBLIC_SHORT_BASE_URL,
    dashboardUrl: config.PUBLIC_DASHBOARD_URL,
    allowedTargetDomains: config.allowedDomains,
    trustedProxyConfigured: config.TRUSTED_PROXY_CIDRS.trim().length > 0,
    privacyUrl: `${config.PUBLIC_SHORT_BASE_URL.replace(/\/$/, '')}/privacy`,
    legalReviewAcknowledged: config.LEGAL_REVIEW_ACKNOWLEDGED,
    risk: { engineVersion: RISK_ENGINE_VERSION, config: DEFAULT_RISK_CONFIG },
    failOpenPolicy: 'Se o banco ficar indisponível, o redirect continua (fail-open) usando o cache de links; a perda de telemetria é contabilizada.',
    signupMode: config.SIGNUP_MODE,
    defaultLinkQuota: config.DEFAULT_LINK_QUOTA,
  };
  });

  const auditQuery = z.object({
    limit: z.coerce.number().int().min(1).max(200).default(50),
    cursor: z.string().max(300).optional(),
    action: z.string().max(80).optional(),
  });

  app.get('/audit', async (req) => {
    requireAdmin(req);
    const q = auditQuery.parse(req.query);
    const params: unknown[] = [];
    const where: string[] = [];
    if (q.action) { params.push(q.action); where.push(`action = $${params.length}`); }
    const cur = decodeCursor(q.cursor);
    if (cur) {
      params.push(cur.t, cur.id);
      where.push(`(at, id) < ($${params.length - 1}::timestamptz, $${params.length}::uuid)`);
    }
    params.push(q.limit + 1);
    const { rows } = await pool.query<{ id: string; account_id: string | null; action: string; resource: string | null; result: string; at_raw: string; metadata_redacted: unknown }>(
      `SELECT id, account_id, action, resource, result, to_char(at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS at_raw, metadata_redacted
       FROM audit_events ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY at DESC, id DESC LIMIT $${params.length}`,
      params,
    );
    const page = rows.slice(0, q.limit);
    const last = page[page.length - 1];
    return {
      items: page.map((r) => ({ id: r.id, accountId: r.account_id, action: r.action, resource: r.resource, result: r.result, at: r.at_raw, metadata: r.metadata_redacted })),
      nextCursor: rows.length > q.limit && last ? encodeCursor({ t: last.at_raw, id: last.id }) : null,
    };
  });
}
