import type { Pool } from '@ipl/database';

/**
 * Monitor do próprio serviço: como o worker é quem gera a maioria dos alertas, a API vigia o
 * heartbeat dele. Alertas ficam apenas no painel (sem notificações externas no MVP).
 */
export async function checkWorkerHeartbeat(pool: Pool, staleAfterSeconds = 180, graceSeconds = 120): Promise<boolean> {
  const { rows } = await pool.query<{ age: number | null }>(
    `SELECT EXTRACT(EPOCH FROM (now() - updated_at))::int AS age FROM job_state WHERE key = 'worker_heartbeat'`,
  );
  const age = rows[0]?.age ?? null;
  const uptime = process.uptime();
  // Sem heartbeat nenhum: só alerta depois de um período de carência desde o início da API
  const stale = age === null ? uptime > graceSeconds + staleAfterSeconds : age > staleAfterSeconds;
  if (!stale) return false;
  await pool.query(
    `INSERT INTO alerts (type, severity, title, evidence, dedupe_key)
     VALUES ('worker_down', 'critical', 'Worker de enriquecimento parado ou sem heartbeat', $1, 'ops:worker_down')
     ON CONFLICT (dedupe_key) WHERE status <> 'resolved'
     DO UPDATE SET occurrences = alerts.occurrences + 1, updated_at = now(), evidence = EXCLUDED.evidence`,
    [JSON.stringify({ heartbeatAgeSeconds: age })],
  );
  return true;
}

export function startOpsMonitor(pool: Pool, everyMs = 60_000): NodeJS.Timeout {
  const timer = setInterval(() => void checkWorkerHeartbeat(pool).catch(() => undefined), everyMs);
  timer.unref();
  return timer;
}
