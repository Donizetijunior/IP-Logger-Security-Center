import type { Pool } from '@ipl/database';

export interface PurgeResult {
  at: string;
  retentionDays: number;
  cutoff: string;
  deleted: Record<string, number>;
}

async function deleteBatched(pool: Pool, sql: string, params: unknown[], batch = 5000): Promise<number> {
  let total = 0;
  for (;;) {
    const { rowCount } = await pool.query(sql, [...params, batch]);
    const n = rowCount ?? 0;
    total += n;
    if (n < batch) return total;
  }
}

/**
 * Expurgo de dados analíticos identificáveis. Remove eventos mais antigos que a retenção e
 * tudo que preserve o vínculo com o IP: avaliações de risco (cascade), alertas com IP,
 * cache de inteligência, exportações e itens de outbox. Idempotente e em lotes.
 *
 * Observação: a retenção legal (art. 15 Marco Civil) NÃO é tratada aqui; se aplicável, deve
 * ser um armazenamento separado (ver docs/privacy-retention.md).
 */
export async function runPurge(pool: Pool, opts: { retentionDays: number; auditRetentionDays: number }): Promise<PurgeResult> {
  const d: Record<string, number> = {};
  const cutoffRes = await pool.query<{ cutoff: Date }>(`SELECT now() - ($1 || ' days')::interval AS cutoff`, [String(opts.retentionDays)]);
  const cutoff = cutoffRes.rows[0]!.cutoff;

  d.access_events = await deleteBatched(
    pool,
    `DELETE FROM access_events WHERE id IN (SELECT id FROM access_events WHERE occurred_at < $1 LIMIT $2)`, [cutoff],
  );
  d.alerts_with_ip = await deleteBatched(
    pool,
    `DELETE FROM alerts WHERE id IN (SELECT id FROM alerts WHERE created_at < $1 AND ip_address IS NOT NULL LIMIT $2)`, [cutoff],
  );
  d.alerts_resolved = await deleteBatched(
    pool,
    `DELETE FROM alerts WHERE id IN (SELECT id FROM alerts WHERE updated_at < $1 AND status = 'resolved' LIMIT $2)`, [cutoff],
  );
  // Alertas ativos que referenciam IPs sem nenhum evento remanescente deixam de ter lastro: anonimiza
  await pool.query(
    `UPDATE alerts SET ip_address = NULL, evidence = '{"redacted":"ip expurgado pela política de retenção"}'::jsonb
     WHERE ip_address IS NOT NULL AND NOT EXISTS (SELECT 1 FROM access_events e WHERE e.ip_address = alerts.ip_address)`,
  );
  // Cache de provedores: remove vencidos e os que não têm mais evento associado ao IP
  d.ip_intelligence = await deleteBatched(
    pool,
    `DELETE FROM ip_intelligence WHERE id IN (
       SELECT i.id FROM ip_intelligence i
       WHERE i.expires_at < now() - interval '1 day' OR i.checked_at < $1
          OR NOT EXISTS (SELECT 1 FROM access_events e WHERE e.ip_address = i.ip_address)
       LIMIT $2)`, [cutoff],
  );
  d.exports = (await pool.query(`DELETE FROM exports WHERE expires_at < now()`)).rowCount ?? 0;
  d.outbox_events = (await pool.query(`DELETE FROM outbox_events WHERE published_at IS NOT NULL AND published_at < now() - interval '7 days'`)).rowCount ?? 0;
  d.login_challenges = (await pool.query(`DELETE FROM login_challenges WHERE expires_at < now()`)).rowCount ?? 0;
  d.admin_sessions = (await pool.query(
    `DELETE FROM admin_sessions WHERE expires_at < now() - interval '7 days' OR revoked_at < now() - interval '7 days'`,
  )).rowCount ?? 0;
  d.telemetry_counters = (await pool.query(`DELETE FROM telemetry_counters WHERE bucket < now() - interval '90 days'`)).rowCount ?? 0;
  d.provider_quota = (await pool.query(`DELETE FROM provider_quota WHERE window_start < (now() - interval '90 days')::date`)).rowCount ?? 0;
  // Denúncias resolvidas contêm contato do denunciante: guarda por 180 dias
  d.abuse_reports = (await pool.query("DELETE FROM abuse_reports WHERE resolved_at < now() - interval '180 days'")).rowCount ?? 0;
  d.audit_events = (await pool.query(`DELETE FROM audit_events WHERE at < now() - ($1 || ' days')::interval`, [String(opts.auditRetentionDays)])).rowCount ?? 0;

  const result: PurgeResult = { at: new Date().toISOString(), retentionDays: opts.retentionDays, cutoff: cutoff.toISOString(), deleted: d };
  await pool.query(
    `INSERT INTO job_state (key, value, updated_at) VALUES ('purge', $1, now())
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
    [JSON.stringify(result)],
  );
  return result;
}
