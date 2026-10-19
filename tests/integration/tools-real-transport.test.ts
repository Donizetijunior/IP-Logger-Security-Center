import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { nextIp, startTestApp, type Session, type TestApp } from './helpers.ts';

// Sem override de transporte: usa o safeHop de verdade (nada pode alcançar redes internas).
let t: TestApp;
let s: Session;

beforeAll(async () => {
  t = await startTestApp({ SIGNUP_MODE: 'open' });
  s = await t.login();
});
afterAll(async () => {
  await t.close();
});

describe('SSRF com o transporte real', () => {
  it('destinos internos, esquemas e portas proibidas nunca são contatados', async () => {
    for (const url of [
      'http://127.0.0.1/', 'http://localhost/', 'http://[::1]/', 'http://169.254.169.254/latest/meta-data/', 'http://10.0.0.5/',
      'http://192.168.0.1/admin', 'http://2130706433/', 'http://0x7f.1/', 'file:///etc/passwd', 'gopher://exemplo.org/', 'ftp://exemplo.org/',
      'http://exemplo.org:22/', 'http://exemplo.org:6379/', 'https://usuario:senha@exemplo.org/',
    ]) {
      const r = await t.app.inject({ method: 'POST', url: '/api/v1/tools/url-check', headers: s.headers(), payload: { url }, remoteAddress: nextIp() });
      expect(r.statusCode, url).toBe(200);
      expect(r.json().error?.code, url).toMatch(/blocked_url|blocked_port|blocked_address/);
      expect(r.json().finalStatus, url).toBeNull();
    }
  });
});

describe('RDAP desabilitado', () => {
  it('whois e rdap=true respondem 503', async () => {
    const o = await startTestApp({ RDAP_ENABLED: 'false' });
    try {
      const so = await o.login();
      expect((await o.app.inject({ method: 'GET', url: '/api/v1/tools/whois?q=exemplo.com', headers: so.headers() })).statusCode).toBe(503);
      expect((await o.app.inject({ method: 'GET', url: '/api/v1/tools/ip/8.8.8.8?rdap=true', headers: so.headers() })).statusCode).toBe(503);
    } finally {
      await o.close();
    }
  });
});
