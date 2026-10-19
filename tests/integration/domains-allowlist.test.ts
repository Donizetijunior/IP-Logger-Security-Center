import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loginUser, nextIp, signup, startTestApp, type Session, type TestApp } from './helpers.ts';

let t: TestApp;
let admin: Session;
let other: Session;

const api = (s: Session, method: 'GET' | 'POST' | 'PATCH' | 'DELETE', url: string, payload?: unknown) =>
  t.app.inject({ method, url: `/api/v1${url}`, headers: s.headers(), payload: payload as object, remoteAddress: nextIp() });

beforeAll(async () => {
  t = await startTestApp({ SIGNUP_MODE: 'open', CUSTOM_DOMAINS_MODE: 'open', CUSTOM_DOMAINS_EMAILS: 'ADMIN@example.org' });
  admin = await t.login();
  await signup(t, 'outra@example.org');
  other = await loginUser(t, 'outra@example.org');
});
afterAll(async () => {
  await t.close();
});

describe('CUSTOM_DOMAINS_EMAILS', () => {
  it('só a conta listada usa domínios personalizados; as demais não os enxergam', async () => {
    const me = (await api(other, 'GET', '/auth/me')).json();
    expect(me.customDomains).toBe(false);
    const list = (await api(other, 'GET', '/domains')).json();
    expect(list.items).toEqual([]);
    expect(list.policy.canCreate).toBe(false);
    for (const [m, u] of [['POST', '/domains'], ['POST', '/domains/00000000-0000-4000-8000-000000000000/verify'], ['PATCH', '/domains/00000000-0000-4000-8000-000000000000'], ['DELETE', '/domains/00000000-0000-4000-8000-000000000000']] as const) {
      const r = await api(other, m, u, m === 'POST' || m === 'PATCH' ? { hostname: 'meu.example.net' } : undefined);
      expect(r.statusCode, `${m} ${u}`).toBe(403);
    }
  });

  it('a conta listada (sem diferenciar maiúsculas) segue com acesso', async () => {
    expect((await api(admin, 'GET', '/auth/me')).json().customDomains).toBe(true);
    const r = await api(admin, 'POST', '/domains', { hostname: 'meu.example.net' });
    expect(r.statusCode).toBe(201);
  });
});
