import { migrate } from '@ipl/database';
import { buildApp } from './app.ts';
import { createContext } from './create-context.ts';
import { startOpsMonitor } from './ops-alerts.ts';

async function main(): Promise<void> {
  const ctx = createContext();
  const migrated = await migrate(ctx.pool);
  if (migrated.length) console.log(JSON.stringify({ level: 'info', msg: 'migrations aplicadas', migrated }));
  const app = await buildApp(ctx);
  ctx.telemetry.start(ctx.pool);
  startOpsMonitor(ctx.pool);

  const shutdown = async (signal: string) => {
    app.log.info({ signal }, 'encerrando');
    ctx.telemetry.stop();
    await app.close();
    await ctx.telemetry.flush(ctx.pool);
    await ctx.pool.end();
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));

  await app.listen({ host: '0.0.0.0', port: ctx.config.API_PORT });
}

main().catch((err) => {
  console.error(`Falha ao iniciar a API: ${(err as Error).message}`);
  process.exit(1);
});
