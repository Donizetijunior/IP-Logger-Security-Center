import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CURRENT_TERMS_VERSION } from '../../apps/api/src/legal.ts';
import { loginUser, nextIp, signup, startTestApp, type Session, type TestApp } from './helpers.ts';

let t: TestApp;
let user: Session;

const api = (s: Session, method: 'GET' | 'POST', url: string, payload?: unknown) =>
  t.app.inject({ method, url: `/api/v1${url}`, headers: s.headers(), payload: payload as object, remoteAddress: nextIp() });
const me = async (s: Session) => (await api(s, 'GET', '/auth/me')).json();

beforeAll(async () => {
  t = await startTestApp({ SIGNUP_MODE: 'open' });
  await signup(t, 'termos@example.org');
  user = await loginUser(t, 'termos@example.org');
});
afterAll(async () => {
  await t.close();
});

describe('versão dos Termos de Uso', () => {
  it('a versão da página de Termos e a da API são a mesma', () => {
    const page = readFileSync(new URL('../../apps/web/src/pages/Terms.tsx', import.meta.url), 'utf8');
    expect(page).toContain(`TERMS_VERSION = '${CURRENT_TERMS_VERSION}'`);
  });

  it('cadastro novo já registra a versão vigente e não mostra aviso', async () => {
    const row = (await t.ctx.pool.query("SELECT terms_version FROM accounts WHERE email = 'termos@example.org'")).rows[0];
    expect(row.terms_version).toBe(CURRENT_TERMS_VERSION);
    expect(await me(user)).toMatchObject({ termsOutdated: false, currentTermsVersion: CURRENT_TERMS_VERSION });
  });

  it('conta com versão anterior vê o aviso; aceitar registra a versão e some o aviso (auditado)', async () => {
    await t.ctx.pool.query("UPDATE accounts SET terms_version = '2026-10' WHERE email = 'termos@example.org'");
    expect((await me(user)).termsOutdated).toBe(true);
    const r = await api(user, 'POST', '/auth/accept-terms');
    expect(r.statusCode).toBe(200);
    expect(r.json().termsOutdated).toBe(false);
    expect((await me(user)).termsOutdated).toBe(false);
    const row = (await t.ctx.pool.query("SELECT terms_version FROM accounts WHERE email = 'termos@example.org'")).rows[0];
    expect(row.terms_version).toBe(CURRENT_TERMS_VERSION);
    const a = await t.ctx.pool.query("SELECT metadata_redacted FROM audit_events WHERE action = 'terms.accept'");
    expect(a.rows[0].metadata_redacted).toEqual({ version: CURRENT_TERMS_VERSION });
  });

  it('exige sessão para aceitar', async () => {
    const r = await t.app.inject({ method: 'POST', url: '/api/v1/auth/accept-terms', headers: { host: t.ctx.config.dashboardHost }, remoteAddress: nextIp() });
    expect(r.statusCode).toBe(401);
  });
});
