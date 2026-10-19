/**
 * Cria o único administrador. Uso (no servidor, nunca exposto via HTTP):
 *   ADMIN_EMAIL=... ADMIN_PASSWORD_FILE=/run/secrets/admin_password node apps/api/src/cli/bootstrap-admin.ts
 * Alternativa interativa: ADMIN_EMAIL=... node ... (a senha é pedida no terminal, sem eco).
 * O segredo TOTP e os códigos de recuperação são exibidos UMA única vez.
 */
import { readFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { Writable } from 'node:stream';
import { createPool, migrate } from '@ipl/database';
import { loadConfig, parseEncryptionKey } from '@ipl/shared';
import { bootstrapAdmin } from '../auth.ts';

function promptHidden(question: string): Promise<string> {
  return new Promise((resolve) => {
    let muted = false;
    const out = new Writable({
      write(chunk, _enc, cb) {
        if (!muted) process.stdout.write(chunk);
        cb();
      },
    });
    const rl = createInterface({ input: process.stdin, output: out, terminal: true });
    rl.question(question, (answer) => {
      rl.close();
      process.stdout.write('\n');
      resolve(answer);
    });
    muted = true;
    process.stdout.write(question);
  });
}

async function main(): Promise<void> {
  const config = loadConfig();
  const email = process.env.ADMIN_EMAIL ?? (await promptHidden('E-mail do administrador: '));
  let password: string;
  if (process.env.ADMIN_PASSWORD_FILE) password = readFileSync(process.env.ADMIN_PASSWORD_FILE, 'utf8').trim();
  else if (process.env.ADMIN_PASSWORD) password = process.env.ADMIN_PASSWORD; // menos seguro (aparece no ambiente do processo); prefira o prompt ou _FILE
  else password = await promptHidden('Senha (mín. 12 caracteres): ');

  const pool = createPool(config.DATABASE_URL, { max: 2 });
  try {
    await migrate(pool);
    const res = await bootstrapAdmin(pool, parseEncryptionKey(config.TOTP_ENCRYPTION_KEY), email, password);
    console.log('\nAdministrador criado.\n');
    console.log('1) Cadastre o MFA no seu aplicativo autenticador (URI otpauth):');
    console.log(`   ${res.otpauthUri}`);
    console.log(`   Segredo manual: ${res.totpSecret}`);
    console.log('\n2) Guarde os códigos de recuperação (uso único). Não serão exibidos novamente:');
    for (const c of res.recoveryCodes) console.log(`   ${c}`);
    console.log('\nNo primeiro login, o MFA é confirmado com um código de 6 dígitos do aplicativo.');
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error(`Erro: ${(err as Error).message}`);
  process.exit(1);
});
