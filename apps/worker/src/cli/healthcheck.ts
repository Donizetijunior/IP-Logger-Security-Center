/** Healthcheck do container do worker: verifica o heartbeat gravado no banco (< 120 s). */
import { createPool } from '@ipl/database';

const url = process.env.DATABASE_URL;
if (!url) process.exit(1);
const pool = createPool(url, { max: 1, statementTimeoutMs: 5000 });
try {
  const { rows } = await pool.query<{ age: number }>(
    `SELECT EXTRACT(EPOCH FROM (now() - updated_at))::int AS age FROM job_state WHERE key = 'worker_heartbeat'`,
  );
  process.exitCode = rows[0] && rows[0].age < 120 ? 0 : 1;
} catch {
  process.exitCode = 1;
} finally {
  await pool.end();
}
