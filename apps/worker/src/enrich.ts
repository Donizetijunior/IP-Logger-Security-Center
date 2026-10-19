import type { Pool } from '@ipl/database';
import {
  DEFAULT_RISK_CONFIG, computeRisk, isPublicIp, type AppConfig, type ProviderObservation, type RiskResult,
} from '@ipl/shared';
import { raiseAlert } from './alerts.ts';
import { reverseDns, type GeoService } from './geo.ts';
import type { IntelService } from './intel.ts';
import type { ReputationProvider } from './providers.ts';
import { torStatus } from './tor.ts';

export interface EnrichDeps {
  pool: Pool;
  config: AppConfig;
  geo: GeoService;
  intel: IntelService;
  abuse: ReputationProvider;
  grey: ReputationProvider;
  rdns?: (ip: string) => Promise<string | null>;
}

interface EventRow {
  id: string;
  ip: string;
  slug: string;
  short_link_id: string | null;
}

const UNHEALTHY = new Set(['unavailable', 'rate_limited']);

/**
 * Enriquece um evento. Idempotente: pode ser reexecutado (reprocessamento da outbox, retry).
 * Retorna o resultado de risco para testes/observabilidade.
 */
export async function enrichEvent(deps: EnrichDeps, eventId: string): Promise<RiskResult | null> {
  const { pool, config } = deps;
  const { rows } = await pool.query<EventRow>(
    'SELECT id, host(ip_address) AS ip, slug, short_link_id FROM access_events WHERE id = $1', [eventId],
  );
  const ev = rows[0];
  if (!ev) return null; // já expurgado (retenção) — nada a fazer

  // IP não público (loopback, RFC1918, reservado…): nunca consultado externamente (CA-07)
  if (!isPublicIp(ev.ip)) {
    await pool.query(
      `UPDATE access_events SET enrichment_status = 'skipped', enriched_at = now(), risk_score = NULL, risk_level = 'not_evaluated' WHERE id = $1`,
      [eventId],
    );
    return { score: null, level: 'not_evaluated', evidence: [], engineVersion: DEFAULT_RISK_CONFIG.version };
  }

  const geo = deps.geo.lookup(ev.ip);
  const rdns = await (deps.rdns ?? reverseDns)(ev.ip);
  const tor = config.TOR_EXIT_LIST_ENABLED ? await torStatus(pool, ev.ip) : 'unknown';

  const [abuse, grey] = await Promise.all([deps.intel.lookup(deps.abuse, ev.ip), deps.intel.lookup(deps.grey, ev.ip)]);

  const rateRes = await pool.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM access_events WHERE ip_address = $1::inet AND occurred_at > now() - ($2 || ' minutes')::interval`,
    [ev.ip, String(config.RATE_ANOMALY_WINDOW_MIN)],
  );

  const risk = computeRisk(
    {
      abuseipdb: abuse,
      greynoise: grey,
      torExit: tor,
      rate: { count: rateRes.rows[0]?.n ?? 0, windowMinutes: config.RATE_ANOMALY_WINDOW_MIN },
    },
    { ...DEFAULT_RISK_CONFIG, rateAnomalyThreshold: config.RATE_ANOMALY_THRESHOLD },
  );

  const enabled: ProviderObservation[] = [abuse, grey].filter((p) => p.status !== 'disabled' && p.status !== 'not_queried');
  const enrichmentStatus = enabled.some((p) => UNHEALTHY.has(p.status)) ? 'partial' : 'done';

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `UPDATE access_events SET country = $2, region = $3, city = $4, asn = $5, asn_org = $6, rdns = $7, tor_exit = $8,
         enrichment_status = $9, enriched_at = now(), risk_score = $10, risk_level = $11
       WHERE id = $1`,
      [eventId, geo.country, geo.region, geo.city, geo.asn, geo.asnOrg, rdns, String(tor), enrichmentStatus, risk.score, risk.level],
    );
    await client.query('DELETE FROM risk_assessments WHERE access_event_id = $1', [eventId]);
    await client.query(
      'INSERT INTO risk_assessments (access_event_id, score, level, evidence, engine_version) VALUES ($1, $2, $3, $4, $5)',
      [eventId, risk.score, risk.level, JSON.stringify(risk.evidence), risk.engineVersion],
    );
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }

  if (risk.level === 'high') {
    await raiseAlert(pool, {
      type: 'ip_high_risk', severity: 'high', ip: ev.ip, linkId: ev.short_link_id, dedupeKey: `risk:ip:${ev.ip}`,
      title: `IP ${ev.ip} com risco alto (score ${risk.score})`,
      evidence: { score: risk.score, level: risk.level, engineVersion: risk.engineVersion, rules: risk.evidence, eventId },
    });
  }
  return risk;
}

/** Marca como falha definitiva (após esgotar tentativas da fila). */
export async function markEnrichmentFailed(pool: Pool, eventId: string): Promise<void> {
  await pool.query(
    `UPDATE access_events SET enrichment_status = 'failed', enriched_at = now() WHERE id = $1 AND enrichment_status IN ('pending', 'partial')`,
    [eventId],
  );
}
