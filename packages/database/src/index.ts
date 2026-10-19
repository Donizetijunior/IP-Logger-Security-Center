import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

export type { Pool, PoolClient, QueryResultRow } from 'pg';

// inet/uuid/etc. continuam como string; bigint (counts) como number seguro
pg.types.setTypeParser(20, (v) => Number(v));

export function createPool(connectionString: string, opts: { max?: number; statementTimeoutMs?: number } = {}): pg.Pool {
  const pool = new pg.Pool({
    connectionString,
    max: opts.max ?? 10,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 2_000,
    statement_timeout: opts.statementTimeoutMs ?? 15_000,
  });
  pool.on('error', () => {
    /* conexões ociosas podem cair; o pool reconecta sob demanda */
  });
  return pool;
}

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'migrations');

export async function migrate(pool: pg.Pool, dir = MIGRATIONS_DIR): Promise<string[]> {
  const client = await pool.connect();
  const applied: string[] = [];
  try {
    await client.query('SELECT pg_advisory_lock(727001)');
    await client.query(
      'CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())',
    );
    const done = new Set((await client.query<{ name: string }>('SELECT name FROM schema_migrations')).rows.map((r) => r.name));
    const files = readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();
    for (const f of files) {
      if (done.has(f)) continue;
      const sql = readFileSync(join(dir, f), 'utf8');
      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [f]);
        await client.query('COMMIT');
        applied.push(f);
      } catch (err) {
        await client.query('ROLLBACK');
        throw new Error(`Falha na migration ${f}: ${(err as Error).message}`);
      }
    }
  } finally {
    await client.query('SELECT pg_advisory_unlock(727001)').catch(() => undefined);
    client.release();
  }
  return applied;
}

/** Seed de desenvolvimento: apenas links e eventos com IPs reservados para documentação. */
export async function seedDevelopment(pool: pg.Pool): Promise<void> {
  await pool.query(
    `INSERT INTO short_links (slug, target_url, label) VALUES
       ('demo-docs', 'https://example.org/documentacao', 'Link de demonstração (seed)'),
       ('demo-campanha', 'https://example.org/campanha', 'Campanha de demonstração (seed)')
     ON CONFLICT (slug) DO NOTHING`,
  );
  const ips = ['192.0.2.10', '198.51.100.23', '203.0.113.42', '2001:db8::7'];
  for (const [i, ip] of ips.entries()) {
    await pool.query(
      `INSERT INTO access_events (short_link_id, slug, ip_address, method, http_status, user_agent, client_class, occurred_at)
       SELECT id, slug, $1, 'GET', 302, 'Seed/1.0 (dados de demonstração)', 'unknown', now() - ($2 || ' minutes')::interval
       FROM short_links WHERE slug = 'demo-docs'`,
      [ip, String((i + 1) * 7)],
    );
  }
}
