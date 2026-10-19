/** Executa o expurgo uma vez. Usado após restaurar backups (CA-18) e para manutenção manual. */
import { createPool } from '@ipl/database';
import { loadConfig } from '@ipl/shared';
import { runPurge } from '../purge.ts';

const config = loadConfig();
const pool = createPool(config.DATABASE_URL, { max: 2, statementTimeoutMs: 600_000 });
try {
  const res = await runPurge(pool, { retentionDays: config.ANALYTICS_RETENTION_DAYS, auditRetentionDays: config.AUDIT_RETENTION_DAYS });
  console.log(JSON.stringify(res));
} catch (err) {
  console.error(`Falha no expurgo: ${(err as Error).message}`);
  process.exitCode = 1;
} finally {
  await pool.end();
}
