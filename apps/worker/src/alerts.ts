import { statfsSync } from 'node:fs';
import type { Pool } from '@ipl/database';
import { RISK_ENGINE_VERSION, type AppConfig } from '@ipl/shared';

export interface AlertInput {
  type: string;
  severity: 'info' | 'low' | 'medium' | 'high' | 'critical';
  title: string;
  ip?: string | null;
  linkId?: string | null;
  evidence: Record<string, unknown>;
  dedupeKey: string;
}

/** Cria o alerta ou agrega à ocorrência aberta com a mesma chave de deduplicação. */
export async function raiseAlert(pool: Pool, a: AlertInput): Promise<void> {
  await pool.query(
    `INSERT INTO alerts (type, severity, title, ip_address, short_link_id, evidence, dedupe_key, rule_version)
     VALUES ($1, $2, $3, $4::inet, $5, $6, $7, $8)
     ON CONFLICT (dedupe_key) WHERE status <> 'resolved'
     DO UPDATE SET occurrences = alerts.occurrences + 1, updated_at = now(), evidence = EXCLUDED.evidence, severity = EXCLUDED.severity`,
    [a.type, a.severity, a.title, a.ip ?? null, a.linkId ?? null, JSON.stringify(a.evidence), a.dedupeKey, RISK_ENGINE_VERSION],
  );
}

export interface QueueHealth {
  waiting: number;
  active: number;
  failed: number;
  oldestWaitingMs: number;
}

/** Avalia regras periódicas de alerta. Idempotente graças à deduplicação. */
export async function evaluateAlerts(pool: Pool, config: AppConfig, queue: QueueHealth | null): Promise<number> {
  let raised = 0;
  const raise = async (a: AlertInput) => {
    await raiseAlert(pool, a);
    raised += 1;
  };

  // 1) Taxa anômala por IP
  const rate = await pool.query<{ ip: string; n: number }>(
    `SELECT host(ip_address) AS ip, count(*)::int AS n FROM access_events
     WHERE occurred_at > now() - ($1 || ' minutes')::interval GROUP BY ip_address HAVING count(*) >= $2`,
    [String(config.RATE_ANOMALY_WINDOW_MIN), config.RATE_ANOMALY_THRESHOLD],
  );
  for (const r of rate.rows) {
    await raise({
      type: 'ip_rate_anomaly', severity: 'medium', ip: r.ip, dedupeKey: `rate:ip:${r.ip}`,
      title: `Taxa anômala de acessos do IP ${r.ip}`,
      evidence: { requests: r.n, windowMinutes: config.RATE_ANOMALY_WINDOW_MIN, threshold: config.RATE_ANOMALY_THRESHOLD },
    });
  }

  // 2) Pico por link vs. baseline das últimas 24 h (janelas de 5 min)
  const spikes = await pool.query<{ id: string; slug: string; recent: number; baseline: number }>(
    `WITH recent AS (
       SELECT short_link_id, count(*)::int AS n FROM access_events WHERE occurred_at > now() - interval '5 minutes' AND short_link_id IS NOT NULL GROUP BY 1
     ), base AS (
       SELECT short_link_id, (count(*)::float / 288.0) AS avg5 FROM access_events
       WHERE occurred_at BETWEEN now() - interval '24 hours' AND now() - interval '5 minutes' AND short_link_id IS NOT NULL GROUP BY 1
     )
     SELECT l.id, l.slug, r.n AS recent, COALESCE(b.avg5, 0) AS baseline
     FROM recent r JOIN short_links l ON l.id = r.short_link_id LEFT JOIN base b ON b.short_link_id = r.short_link_id
     WHERE r.n >= GREATEST(20, $1 * COALESCE(b.avg5, 0))`,
    [config.SPIKE_MULTIPLIER],
  );
  for (const s of spikes.rows) {
    await raise({
      type: 'link_traffic_spike', severity: 'medium', linkId: s.id, dedupeKey: `spike:link:${s.id}`,
      title: `Aumento anormal de acessos no link ${s.slug}`,
      evidence: { requestsLast5Min: s.recent, baselinePer5Min: Number(s.baseline.toFixed(2)), multiplier: config.SPIKE_MULTIPLIER },
    });
  }

  // 3) Mesmo IP em múltiplos links em período curto
  const multi = await pool.query<{ ip: string; links: number }>(
    `SELECT host(ip_address) AS ip, count(DISTINCT short_link_id)::int AS links FROM access_events
     WHERE occurred_at > now() - ($1 || ' minutes')::interval AND short_link_id IS NOT NULL
     GROUP BY ip_address HAVING count(DISTINCT short_link_id) >= $2`,
    [String(config.MULTI_LINK_WINDOW_MIN), config.MULTI_LINK_THRESHOLD],
  );
  for (const m of multi.rows) {
    await raise({
      type: 'ip_multi_link', severity: 'medium', ip: m.ip, dedupeKey: `multi:ip:${m.ip}`,
      title: `IP ${m.ip} acessou ${m.links} links diferentes em ${config.MULTI_LINK_WINDOW_MIN} min`,
      evidence: { distinctLinks: m.links, windowMinutes: config.MULTI_LINK_WINDOW_MIN, threshold: config.MULTI_LINK_THRESHOLD },
    });
  }

  // 4) Provedores: falhas persistentes e quota esgotada (apenas os habilitados)
  const providers: Array<{ source: 'abuseipdb' | 'greynoise'; enabled: boolean; quota: number }> = [
    { source: 'abuseipdb', enabled: config.ABUSEIPDB_ENABLED && !!config.ABUSEIPDB_API_KEY, quota: config.ABUSEIPDB_DAILY_QUOTA },
    { source: 'greynoise', enabled: config.GREYNOISE_ENABLED, quota: config.GREYNOISE_DAILY_QUOTA },
  ];
  for (const p of providers.filter((x) => x.enabled)) {
    const st = await pool.query<{ status: string; n: number }>(
      `SELECT status, count(*)::int AS n FROM ip_intelligence WHERE source = $1 AND checked_at > now() - interval '30 minutes' GROUP BY status`,
      [p.source],
    );
    const by = Object.fromEntries(st.rows.map((r) => [r.status, r.n])) as Record<string, number>;
    const ok = (by.ok ?? 0) + (by.no_data ?? 0);
    if ((by.unavailable ?? 0) >= 5 && ok === 0) {
      await raise({
        type: 'provider_unavailable', severity: 'high', dedupeKey: `provider:down:${p.source}`,
        title: `Falhas persistentes no provedor ${p.source}`, evidence: { last30min: by },
      });
    }
    const q = await pool.query<{ used: number }>(
      `SELECT used FROM provider_quota WHERE source = $1 AND window_start = (now() AT TIME ZONE 'UTC')::date`, [p.source],
    );
    if ((q.rows[0]?.used ?? 0) >= p.quota) {
      await raise({
        type: 'provider_quota_exhausted', severity: 'medium', dedupeKey: `provider:quota:${p.source}`,
        title: `Quota diária do provedor ${p.source} esgotada`, evidence: { used: q.rows[0]?.used, dailyQuota: p.quota },
      });
    }
  }

  // 5) Falhas de captura de telemetria (perda de eventos durante indisponibilidade)
  const cap = await pool.query<{ n: number }>(
    `SELECT COALESCE(sum(value), 0)::int AS n FROM telemetry_counters WHERE key = 'capture_failed' AND bucket > now() - interval '10 minutes'`,
  );
  if ((cap.rows[0]?.n ?? 0) > 0) {
    await raise({
      type: 'capture_failure', severity: 'high', dedupeKey: 'ops:capture_failure',
      title: 'Falha na captura de eventos de acesso (telemetria perdida)', evidence: { failedLast10Min: cap.rows[0]!.n },
    });
  }

  // 6) Outbox atrasada
  const ob = await pool.query<{ lag: number | null; pending: number }>(
    `SELECT EXTRACT(EPOCH FROM (now() - min(created_at)))::int AS lag, count(*)::int AS pending FROM outbox_events WHERE published_at IS NULL`,
  );
  if ((ob.rows[0]?.lag ?? 0) > 120) {
    await raise({
      type: 'outbox_lag', severity: 'high', dedupeKey: 'ops:outbox_lag',
      title: 'Outbox atrasada: eventos aguardando publicação na fila',
      evidence: { oldestSeconds: ob.rows[0]!.lag, pending: ob.rows[0]!.pending },
    });
  }

  // 7) Fila travada
  if (queue && (queue.waiting > 1000 || queue.oldestWaitingMs > 10 * 60_000)) {
    await raise({
      type: 'queue_stuck', severity: 'high', dedupeKey: 'ops:queue_stuck',
      title: 'Fila de enriquecimento acumulada ou travada', evidence: { ...queue },
    });
  }

  // 8) Armazenamento: tamanho do banco e espaço livre
  const size = await pool.query<{ bytes: number }>('SELECT pg_database_size(current_database())::bigint AS bytes');
  const maxBytes = Number(process.env.DB_SIZE_ALERT_BYTES ?? 10 * 1024 ** 3);
  if ((size.rows[0]?.bytes ?? 0) > maxBytes) {
    await raise({
      type: 'storage_critical', severity: 'critical', dedupeKey: 'ops:storage_db_size',
      title: 'Banco de dados acima do limite de armazenamento configurado', evidence: { bytes: size.rows[0]!.bytes, limit: maxBytes },
    });
  }
  try {
    const fs = statfsSync(process.env.DISK_CHECK_PATH ?? '/');
    const freeRatio = fs.bavail / fs.blocks;
    if (fs.blocks > 0 && freeRatio < 0.1) {
      await raise({
        type: 'storage_critical', severity: 'critical', dedupeKey: 'ops:storage_disk_free',
        title: 'Pouco espaço livre em disco', evidence: { freePercent: Number((freeRatio * 100).toFixed(1)) },
      });
    }
  } catch {
    // plataforma sem statfs: ignora
  }

  return raised;
}
