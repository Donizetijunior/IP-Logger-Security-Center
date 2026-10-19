import type { FastifyInstance } from 'fastify';
import { authenticator } from 'otplib';
import { createPool, migrate, type Pool } from '@ipl/database';
import { buildApp } from '../../apps/api/src/app.ts';
import { bootstrapAdmin } from '../../apps/api/src/auth.ts';
import { createContext } from '../../apps/api/src/create-context.ts';
import type { Ctx } from '../../apps/api/src/context.ts';
import type { RdapClient } from '../../apps/api/src/rdap.ts';
import type { Hop } from '../../apps/api/src/tools/safe-http.ts';
import { parseEncryptionKey } from '@ipl/shared';

export const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? 'postgresql://iplogger:test_only_password@127.0.0.1:55432/iplogger_test';
export const TEST_REDIS_URL = process.env.TEST_REDIS_URL ?? 'redis://127.0.0.1:56379';

export const SHORT_HOST = 'links.test';
export const DASH_HOST = 'painel.test';
export const ADMIN_EMAIL = 'admin@example.org';
export const ADMIN_PASSWORD = 'Senha-Forte-#2026-xyz';

export function testEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  return {
    NODE_ENV: 'test',
    DATABASE_URL: TEST_DATABASE_URL,
    REDIS_URL: TEST_REDIS_URL,
    SESSION_SECRET: 's'.repeat(48),
    TOTP_ENCRYPTION_KEY: 'ab'.repeat(32),
    PUBLIC_SHORT_BASE_URL: `http://${SHORT_HOST}`,
    PUBLIC_DASHBOARD_URL: `http://${DASH_HOST}`,
    TRUSTED_PROXY_CIDRS: '10.0.0.0/8',
    RDAP_ENABLED: 'false',
    LOG_LEVEL: 'silent',
    ...extra,
  };
}

export async function resetDatabase(pool: Pool): Promise<void> {
  await migrate(pool);
  await pool.query(`TRUNCATE accounts, short_links, access_events, ip_intelligence, alerts, audit_events, outbox_events,
    telemetry_counters, provider_quota, job_state, tor_exit_nodes, exports, risk_assessments CASCADE`);
}

export interface TestApp {
  app: FastifyInstance;
  ctx: Ctx;
  recoveryCodes: string[];
  totpSecret: string;
  close(): Promise<void>;
  login(): Promise<Session>;
}

export interface Session {
  cookie: string;
  csrf: string;
  headers(extra?: Record<string, string>): Record<string, string>;
}

export async function startTestApp(
  extraEnv: Record<string, string> = {},
  overrides: { rdap?: RdapClient; hop?: Hop } = {},
): Promise<TestApp> {
  const ctx = createContext(testEnv(extraEnv), overrides);
  await resetDatabase(ctx.pool);
  const admin = await bootstrapAdmin(ctx.pool, parseEncryptionKey(ctx.config.TOTP_ENCRYPTION_KEY), ADMIN_EMAIL, ADMIN_PASSWORD);
  const app = await buildApp(ctx, { logger: false });
  await app.ready();
  const codes = [...admin.recoveryCodes];

  const login = async (): Promise<Session> => {
    const r1 = await app.inject({
      method: 'POST', url: '/api/v1/auth/login', headers: { host: DASH_HOST }, payload: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD },
    });
    if (r1.statusCode !== 200) throw new Error(`login falhou: ${r1.statusCode} ${r1.body}`);
    const { challenge } = r1.json() as { challenge: string };
    const code = codes.shift();
    if (!code) throw new Error('sem códigos de recuperação de teste');
    const r2 = await app.inject({
      method: 'POST', url: '/api/v1/auth/totp/verify', headers: { host: DASH_HOST }, payload: { challenge, code },
    });
    if (r2.statusCode !== 200) throw new Error(`mfa falhou: ${r2.statusCode} ${r2.body}`);
    const setCookie = r2.cookies[0]!;
    const cookie = `${setCookie.name}=${setCookie.value}`;
    const csrf = (r2.json() as { csrfToken: string }).csrfToken;
    return {
      cookie,
      csrf,
      headers: (extra = {}) => ({ host: DASH_HOST, cookie, 'x-csrf-token': csrf, ...extra }),
    };
  };

  return {
    app, ctx, recoveryCodes: codes, totpSecret: admin.totpSecret,
    async close() {
      await app.close();
      await ctx.pool.end();
    },
    login,
  };
}

export function currentTotp(secret: string): string {
  return authenticator.generate(secret);
}

export async function makeLink(t: TestApp, s: Session, payload: Record<string, unknown> = {}) {
  const res = await t.app.inject({
    method: 'POST', url: '/api/v1/links', headers: s.headers(),
    payload: { slug: 'campanha-a1', targetUrl: 'https://example.org/recurso', label: 'Teste', ...payload },
  });
  return { res, body: res.json() as { id: string; slug: string; publicUrl: string } };
}

export function newPool(): Pool {
  return createPool(TEST_DATABASE_URL, { max: 3 });
}

export const USER_PASSWORD = 'Usuario-Forte-#2026-ab';
let ipCounter = 10;
/** IP de documentação único por chamada, para não esbarrar nos limites de taxa por IP. */
export const nextIp = () => `198.51.100.${(ipCounter = (ipCounter % 240) + 1)}`;

export async function signup(t: TestApp, email: string, password = USER_PASSWORD, acceptTerms: unknown = true) {
  return t.app.inject({
    method: 'POST', url: '/api/v1/auth/signup', headers: { host: DASH_HOST }, remoteAddress: nextIp(),
    payload: { email, password, acceptTerms },
  });
}

/** Login de conta sem MFA (usuário comum): uma única chamada cria a sessão. */
export async function loginUser(t: TestApp, email: string, password = USER_PASSWORD): Promise<Session> {
  const r = await t.app.inject({
    method: 'POST', url: '/api/v1/auth/login', headers: { host: DASH_HOST }, remoteAddress: nextIp(), payload: { email, password },
  });
  if (r.statusCode !== 200 || r.json().mfaRequired) throw new Error(`login de usuário falhou: ${r.statusCode} ${r.body}`);
  const c = r.cookies[0]!;
  const cookie = `${c.name}=${c.value}`;
  const csrf = r.json().csrfToken as string;
  return { cookie, csrf, headers: (extra = {}) => ({ host: DASH_HOST, cookie, 'x-csrf-token': csrf, ...extra }) };
}

export async function visit(t: TestApp, slug: string, ip: string, ua = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36') {
  return t.app.inject({ method: 'GET', url: `/${slug}`, headers: { host: SHORT_HOST, 'user-agent': ua }, remoteAddress: ip });
}
