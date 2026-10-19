import type { Pool } from '@ipl/database';
import { isPublicIp, normalizeIp } from '@ipl/shared';

/** Extrai IPs de saída do formato oficial (linhas "ExitAddress <ip> <data>") ou lista simples de IPs. */
export function parseTorExitList(text: string): string[] {
  const ips = new Set<string>();
  for (const line of text.split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const parts = t.split(/\s+/);
    const candidate = parts[0] === 'ExitAddress' ? parts[1] : parts.length === 1 ? parts[0] : undefined;
    const ip = normalizeIp(candidate);
    if (ip && isPublicIp(ip)) ips.add(ip);
  }
  return [...ips];
}

export async function refreshTorList(
  pool: Pool,
  url: string,
  fetchImpl: typeof fetch = fetch,
): Promise<{ count: number }> {
  const res = await fetchImpl(url, { signal: AbortSignal.timeout(20_000), redirect: 'error', headers: { accept: 'text/plain' } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const text = await res.text();
  const ips = parseTorExitList(text);
  // Proteção contra lista truncada/vazia substituindo uma lista boa
  if (ips.length < 50) throw new Error(`lista Tor suspeita (${ips.length} entradas); mantendo a anterior`);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('TRUNCATE tor_exit_nodes');
    await client.query('INSERT INTO tor_exit_nodes (ip_address) SELECT x::inet FROM unnest($1::text[]) AS x ON CONFLICT DO NOTHING', [ips]);
    await client.query(
      `INSERT INTO job_state (key, value, updated_at) VALUES ('tor_list', $1, now())
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
      [JSON.stringify({ state: 'ready', count: ips.length, fetchedAt: new Date().toISOString(), source: url })],
    );
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
  return { count: ips.length };
}

export async function recordTorFailure(pool: Pool, message: string): Promise<void> {
  await pool.query(
    `INSERT INTO job_state (key, value, updated_at) VALUES ('tor_list', jsonb_build_object('state', 'error', 'error', $1::text), now())
     ON CONFLICT (key) DO UPDATE SET value = job_state.value || jsonb_build_object('state', 'error', 'error', $1::text), updated_at = now()`,
    [message.slice(0, 200)],
  );
}

/** 'unknown' se a lista nunca foi carregada; senão true/false. */
export async function torStatus(pool: Pool, ip: string): Promise<boolean | 'unknown'> {
  const state = await pool.query<{ ok: boolean }>(`SELECT (value->>'state' = 'ready') AS ok FROM job_state WHERE key = 'tor_list'`);
  if (!state.rows[0]?.ok) return 'unknown';
  const { rowCount } = await pool.query('SELECT 1 FROM tor_exit_nodes WHERE ip_address = $1::inet', [ip]);
  return rowCount === 1;
}
