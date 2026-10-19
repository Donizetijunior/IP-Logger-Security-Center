import { Queue, Worker, type Job } from 'bullmq';
import { Redis } from 'ioredis';
import { createPool, migrate } from '@ipl/database';
import { loadConfig } from '@ipl/shared';
import { evaluateAlerts, type QueueHealth } from './alerts.ts';
import { enrichEvent, markEnrichmentFailed, type EnrichDeps } from './enrich.ts';
import { processPendingExports } from './exports.ts';
import { GeoService } from './geo.ts';
import { IntelService } from './intel.ts';
import { publishOutbox, requeuePartial } from './outbox.ts';
import { AbuseIpDbProvider, GreyNoiseCommunityProvider } from './providers.ts';
import { runPurge } from './purge.ts';
import { recordTorFailure, refreshTorList } from './tor.ts';

const QUEUE = 'enrich';

function log(level: 'info' | 'warn' | 'error', msg: string, extra: Record<string, unknown> = {}): void {
  console.log(JSON.stringify({ level, time: new Date().toISOString(), msg, ...extra }));
}

async function main(): Promise<void> {
  const config = loadConfig();
  const pool = createPool(config.DATABASE_URL, { max: 10 });
  await migrate(pool);

  // Conexão do produtor: falha rápida se o Redis cair (a outbox preserva os itens)
  const producerConn = new Redis(config.REDIS_URL, { maxRetriesPerRequest: 1, enableOfflineQueue: false, retryStrategy: (n) => Math.min(n * 500, 5000) });
  producerConn.on('error', () => undefined);
  const queue = new Queue(QUEUE, { connection: producerConn, defaultJobOptions: { attempts: 5, backoff: { type: 'exponential', delay: 5000 }, removeOnComplete: 1000, removeOnFail: 5000 } });
  queue.on('error', () => undefined);

  const geo = new GeoService(config.GEOIP_DIR, config.GEOLITE2_ENABLED);
  await geo.reload(pool);
  const intel = new IntelService(pool, { cacheTtlHours: config.PROVIDER_CACHE_TTL_HOURS, negativeTtlHours: config.PROVIDER_NEGATIVE_TTL_HOURS });
  const abuse = new AbuseIpDbProvider({ enabled: config.ABUSEIPDB_ENABLED && !!config.ABUSEIPDB_API_KEY, apiKey: config.ABUSEIPDB_API_KEY, dailyQuota: config.ABUSEIPDB_DAILY_QUOTA });
  const grey = new GreyNoiseCommunityProvider({ enabled: config.GREYNOISE_ENABLED, apiKey: config.GREYNOISE_API_KEY, dailyQuota: config.GREYNOISE_DAILY_QUOTA });
  if (config.ABUSEIPDB_ENABLED && !config.ABUSEIPDB_API_KEY) log('warn', 'ABUSEIPDB_ENABLED=true sem ABUSEIPDB_API_KEY: provedor desabilitado');
  const deps: EnrichDeps = { pool, config, geo, intel, abuse, grey };

  const workerConn = new Redis(config.REDIS_URL, { maxRetriesPerRequest: null });
  workerConn.on('error', () => undefined);
  const worker = new Worker<{ eventId: string }>(QUEUE, (job: Job<{ eventId: string }>) => enrichEvent(deps, job.data.eventId).then(() => undefined), {
    connection: workerConn,
    concurrency: 4,
  });
  worker.on('failed', (job, err) => {
    log('warn', 'falha no enriquecimento', { jobId: job?.id, attemptsMade: job?.attemptsMade, error: err.message.slice(0, 200) });
    if (job && job.attemptsMade >= (job.opts.attempts ?? 5)) void markEnrichmentFailed(pool, job.data.eventId);
  });
  worker.on('error', () => undefined);

  let queueHealth: QueueHealth | null = null;
  const timers: NodeJS.Timeout[] = [];
  const every = (ms: number, name: string, fn: () => Promise<unknown>, runNow = false) => {
    let running = false;
    const tick = async () => {
      if (running) return;
      running = true;
      try {
        await fn();
      } catch (err) {
        log('error', `tarefa ${name} falhou`, { error: (err as Error).message.slice(0, 200) });
      } finally {
        running = false;
      }
    };
    timers.push(setInterval(tick, ms));
    if (runNow) void tick();
  };

  every(2000, 'outbox', async () => {
    const res = await publishOutbox(pool, queue);
    if (res.published || res.failed) {
      const { rows } = await pool.query<{ pending: number; oldest: number | null }>(
        `SELECT count(*)::int AS pending, EXTRACT(EPOCH FROM (now() - min(created_at)))::int AS oldest FROM outbox_events WHERE published_at IS NULL`,
      );
      await pool.query(
        `INSERT INTO job_state (key, value, updated_at) VALUES ('outbox', $1, now()) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
        [JSON.stringify({ pending: rows[0]?.pending ?? 0, oldestSeconds: rows[0]?.oldest ?? 0, redisReachable: !res.failed })],
      );
    }
  });

  every(15_000, 'heartbeat', async () => {
    try {
      const counts = await queue.getJobCounts('waiting', 'active', 'failed');
      const waiting = await queue.getWaiting(0, 0);
      const oldest = waiting[0]?.timestamp ? Date.now() - waiting[0].timestamp : 0;
      queueHealth = { waiting: counts.waiting ?? 0, active: counts.active ?? 0, failed: counts.failed ?? 0, oldestWaitingMs: oldest };
    } catch {
      queueHealth = null;
    }
    await pool.query(
      `INSERT INTO job_state (key, value, updated_at) VALUES ('worker_heartbeat', $1, now()) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
      [JSON.stringify({ queue: queueHealth, redisReachable: queueHealth !== null })],
    );
  }, true);

  every(60_000, 'alertas', () => evaluateAlerts(pool, config, queueHealth), true);
  every(5000, 'exportações', () => processPendingExports(pool));
  every(10 * 60_000, 'reprocessamento', () => requeuePartial(pool));
  every(3600_000, 'geoip', () => geo.reload(pool));
  if (config.TOR_EXIT_LIST_ENABLED) {
    every(3 * 3600_000, 'tor', async () => {
      try {
        const r = await refreshTorList(pool, config.TOR_EXIT_LIST_URL);
        log('info', 'lista Tor atualizada', { count: r.count });
      } catch (err) {
        await recordTorFailure(pool, (err as Error).message);
        throw err;
      }
    }, true);
  }
  // Expurgo diário (e na inicialização se a última execução tiver mais de 24 h)
  every(3600_000, 'expurgo', async () => {
    const { rows } = await pool.query<{ age: number | null }>(`SELECT EXTRACT(EPOCH FROM (now() - updated_at)) AS age FROM job_state WHERE key = 'purge'`);
    const age = rows[0]?.age;
    if (age === undefined || age === null || Number(age) > 23 * 3600) {
      const r = await runPurge(pool, { retentionDays: config.ANALYTICS_RETENTION_DAYS, auditRetentionDays: config.AUDIT_RETENTION_DAYS });
      log('info', 'expurgo concluído', { deleted: r.deleted });
    }
  }, true);

  log('info', 'worker iniciado', { retentionDays: config.ANALYTICS_RETENTION_DAYS, abuseipdb: abuse.enabled, greynoise: grey.enabled, geolite2: config.GEOLITE2_ENABLED });

  const shutdown = async (signal: string) => {
    log('info', 'encerrando worker', { signal });
    for (const t of timers) clearInterval(t);
    await worker.close();
    await queue.close();
    producerConn.disconnect();
    workerConn.disconnect();
    await pool.end();
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

main().catch((err) => {
  console.error(`Falha ao iniciar o worker: ${(err as Error).message}`);
  process.exit(1);
});
