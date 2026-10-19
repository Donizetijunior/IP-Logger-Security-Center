import { createPool, migrate, seedDevelopment } from './index.ts';

const cmd = process.argv[2];
const url = process.env.DATABASE_URL;
if (!url) {
  console.error('DATABASE_URL não definida');
  process.exit(1);
}
const pool = createPool(url, { max: 2 });
try {
  if (cmd === 'migrate') {
    const applied = await migrate(pool);
    console.log(applied.length ? `Migrations aplicadas: ${applied.join(', ')}` : 'Banco já está atualizado');
  } else if (cmd === 'seed') {
    if (process.env.NODE_ENV === 'production') throw new Error('Seed de desenvolvimento não roda em produção');
    await seedDevelopment(pool);
    console.log('Seed de desenvolvimento aplicado (IPs reservados de documentação)');
  } else {
    console.error('Uso: cli.ts migrate|seed');
    process.exitCode = 1;
  }
} catch (err) {
  console.error((err as Error).message);
  process.exitCode = 1;
} finally {
  await pool.end();
}
