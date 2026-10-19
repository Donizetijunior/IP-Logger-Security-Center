import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { HttpRdapClient } from '../../apps/api/src/rdap.ts';
import type { Hop, HopResult } from '../../apps/api/src/tools/safe-http.ts';
import { AbuseIpDbProvider, GreyNoiseCommunityProvider } from '../../apps/worker/src/providers.ts';
import { makeLink, startTestApp, type Session, type TestApp } from './helpers.ts';

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });

describe('AbuseIPDB (contrato da API v2)', () => {
  it('usa GET /check com ipAddress, maxAgeInDays=30, header Key e Accept; extrai e reduz o payload', async () => {
    const f = vi.fn(async () => json({ data: { ipAddress: '8.8.8.8', abuseConfidenceScore: 42, totalReports: 3, numDistinctUsers: 2, lastReportedAt: '2026-10-01T00:00:00+00:00', usageType: 'ISP', isp: 'X', domain: 'x.org', countryCode: 'BR', isWhitelisted: false, isTor: false, hostnames: ['segredo.interno'], ipVersion: 4 } }));
    const p = new AbuseIpDbProvider({ enabled: true, apiKey: 'k-123', dailyQuota: 10, fetchImpl: f as unknown as typeof fetch });
    const r = await p.query('8.8.8.8');
    expect(r.status).toBe('ok');
    const [url, init] = f.mock.calls[0] as unknown as [URL, RequestInit];
    expect(`${url.origin}${url.pathname}`).toBe('https://api.abuseipdb.com/api/v2/check');
    expect(url.searchParams.get('ipAddress')).toBe('8.8.8.8');
    expect(url.searchParams.get('maxAgeInDays')).toBe('30');
    expect(init.headers).toMatchObject({ Key: 'k-123', Accept: 'application/json' });
    expect(init.redirect).toBe('error');
    expect(r.data).toMatchObject({ abuseConfidenceScore: 42, totalReports: 3, countryCode: 'BR' });
    expect(JSON.stringify(r.data)).not.toContain('segredo.interno');
  });

  it('IP não público nunca chega ao provedor', async () => {
    const f = vi.fn();
    const p = new AbuseIpDbProvider({ enabled: true, apiKey: 'k', dailyQuota: 10, fetchImpl: f as unknown as typeof fetch });
    expect(p.supports('10.0.0.1')).toBe(false);
    expect((await p.query('10.0.0.1')).status).toBe('not_queried');
    expect(f).not.toHaveBeenCalled();
  });

  it.each([
    [429, 'rate_limited'], [401, 'unavailable'], [500, 'unavailable'],
  ])('HTTP %i => %s', async (code, status) => {
    const p = new AbuseIpDbProvider({ enabled: true, apiKey: 'k', dailyQuota: 10, fetchImpl: (async () => json({}, code as number, { 'retry-after': '120' })) as unknown as typeof fetch });
    const r = await p.query('8.8.8.8');
    expect(r.status).toBe(status);
    if (code === 429) expect(r.retryAfterSec).toBe(120);
  });

  it('timeout/erro de rede => unavailable; payload inválido => unavailable', async () => {
    const net = new AbuseIpDbProvider({ enabled: true, apiKey: 'k', dailyQuota: 10, fetchImpl: (async () => { throw new Error('ECONNRESET'); }) as unknown as typeof fetch });
    expect((await net.query('8.8.8.8')).errorCode).toBe('network_error');
    const bad = new AbuseIpDbProvider({ enabled: true, apiKey: 'k', dailyQuota: 10, fetchImpl: (async () => json({ data: {} })) as unknown as typeof fetch });
    expect((await bad.query('8.8.8.8')).errorCode).toBe('bad_payload');
  });

  it('sem chave configurada o provedor fica desabilitado (sem chamadas)', async () => {
    const f = vi.fn();
    const p = new AbuseIpDbProvider({ enabled: true, dailyQuota: 10, fetchImpl: f as unknown as typeof fetch });
    expect((await p.query('8.8.8.8')).status).toBe('disabled');
    expect(f).not.toHaveBeenCalled();
  });
});

describe('GreyNoise Community (contrato)', () => {
  it('GET /v3/community/{ip}; 404 = sem contexto (no_data), nunca "seguro"', async () => {
    const f = vi.fn(async () => json({ ip: '8.8.8.8', noise: false, riot: false, message: 'IP not observed scanning the internet or contained in RIOT data set.' }, 404));
    const p = new GreyNoiseCommunityProvider({ enabled: true, apiKey: 'g-1', dailyQuota: 50, fetchImpl: f as unknown as typeof fetch });
    const r = await p.query('8.8.8.8');
    expect(r.status).toBe('no_data');
    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://api.greynoise.io/v3/community/8.8.8.8');
    expect(init.headers).toMatchObject({ key: 'g-1' });
  });

  it('200 com classification malicious é interpretado; payload é reduzido', async () => {
    const p = new GreyNoiseCommunityProvider({ enabled: true, dailyQuota: 50, fetchImpl: (async () => json({ ip: '8.8.8.8', noise: true, riot: false, classification: 'malicious', name: 'unknown', link: 'https://viz', last_seen: '2026-10-18', message: 'Success' })) as unknown as typeof fetch });
    const r = await p.query('8.8.8.8');
    expect(r).toMatchObject({ status: 'ok', data: { noise: true, classification: 'malicious', lastSeen: '2026-10-18' } });
    expect(JSON.stringify(r.data)).not.toContain('viz');
  });

  it('IPv6 e IP privado não são consultados (somente IPv4 público roteável)', async () => {
    const f = vi.fn();
    const p = new GreyNoiseCommunityProvider({ enabled: true, dailyQuota: 50, fetchImpl: f as unknown as typeof fetch });
    expect(p.supports('2606:4700:4700::1111')).toBe(false);
    expect(p.supports('192.168.1.1')).toBe(false);
    expect(p.supports('1.1.1.1')).toBe(true);
    expect((await p.query('2606:4700:4700::1111')).errorCode).toBe('ipv6_unsupported');
    expect(f).not.toHaveBeenCalled();
  });

  it('429 => rate_limited', async () => {
    const p = new GreyNoiseCommunityProvider({ enabled: true, dailyQuota: 50, fetchImpl: (async () => json({}, 429)) as unknown as typeof fetch });
    expect((await p.query('8.8.8.8')).status).toBe('rate_limited');
  });
});

function fakeHop(routes: Record<string, (url: string) => Partial<HopResult> & { json?: unknown }>) {
  const calls: Array<{ url: string; method?: string }> = [];
  const hop: Hop = async (url, opts) => {
    calls.push({ url, method: opts?.method });
    const key = Object.keys(routes).find((k) => url.startsWith(k));
    if (!key) throw new Error(`rota inesperada: ${url}`);
    const r = routes[key]!(url);
    return {
      status: r.status ?? 200,
      headers: r.headers ?? {},
      body: r.json !== undefined ? Buffer.from(JSON.stringify(r.json)) : (r.body ?? null),
      ms: 1,
      tls: true,
    };
  };
  return { hop, calls };
}

describe('RDAP (anti-SSRF)', () => {
  it('segue o redirecionamento do bootstrap (rdap.org -> servidor autoritativo) e reduz o payload', async () => {
    const { hop, calls } = fakeHop({
      'https://rdap.org/ip/': () => ({ status: 302, headers: { location: 'https://rdap.arin.net/registry/ip/8.8.8.8' } }),
      'https://rdap.arin.net/': () => ({ json: { handle: 'NET-8-8-8-0', name: 'GOGL', country: 'US', startAddress: '8.8.8.0', endAddress: '8.8.8.255', type: 'DIRECT ALLOCATION', entities: [{ vcardArray: ['segredo'] }] } }),
    });
    const c = new HttpRdapClient('https://rdap.org/', hop);
    const r = await c.lookup('8.8.8.8');
    expect(r).toMatchObject({ handle: 'NET-8-8-8-0', country: 'US', fetchedFrom: 'rdap.org' });
    expect(JSON.stringify(r)).not.toContain('segredo');
    expect(calls.map((x) => x.url)).toEqual(['https://rdap.org/ip/8.8.8.8', 'https://rdap.arin.net/registry/ip/8.8.8.8']);
  });

  it('redirecionamento para HTTP (rebaixamento) ou laço infinito é recusado', async () => {
    const down = fakeHop({ 'https://rdap.org/': () => ({ status: 302, headers: { location: 'http://rdap.exemplo.org/x' } }) });
    await expect(new HttpRdapClient('https://rdap.org/', down.hop).lookup('8.8.8.8')).rejects.toThrow(/HTTPS/);
    const loop = fakeHop({ 'https://rdap.org/': () => ({ status: 302, headers: { location: 'https://rdap.org/ip/8.8.8.8' } }) });
    await expect(new HttpRdapClient('https://rdap.org/', loop.hop).lookup('8.8.8.8')).rejects.toThrow(/Redirecionamentos/);
  });

  it('IPs privados/reservados e entradas maliciosas nunca geram requisição', async () => {
    const { hop, calls } = fakeHop({});
    const c = new HttpRdapClient('https://rdap.org/', hop);
    for (const ip of ['127.0.0.1', '10.0.0.1', '169.254.169.254', '203.0.113.1', '8.8.8.8/../../admin', 'localhost', 'http://evil']) {
      expect(await c.lookup(ip)).toBeNull();
    }
    for (const d of ['localhost', '10.0.0.1', 'intranet.local', 'a_b.com', 'http://x', '', '-x.com', 'x'.repeat(300) + '.com']) {
      expect(await c.lookupDomain(d)).toBeNull();
    }
    expect(calls).toHaveLength(0);
  });

  it('domínio: extrai somente dados do registro (sem contatos de pessoas)', async () => {
    const { hop } = fakeHop({
      'https://rdap.org/domain/': () => ({
        json: {
          ldhName: 'exemplo.com.br', status: ['active'],
          events: [{ eventAction: 'registration', eventDate: '2020-01-01T00:00:00Z' }, { eventAction: 'expiration', eventDate: '2030-01-01T00:00:00Z' }, { eventAction: 'last changed', eventDate: '2026-01-01T00:00:00Z' }],
          nameservers: [{ ldhName: 'a.dns.exemplo.com.br' }, { ldhName: 'b.dns.exemplo.com.br' }],
          entities: [
            { roles: ['registrant'], vcardArray: ['vcard', [['fn', {}, 'text', 'Pessoa Física Secreta'], ['email', {}, 'text', 'pessoa@exemplo.com']]] },
            { roles: ['registrar'], handle: 'REG-1', vcardArray: ['vcard', [['fn', {}, 'text', 'Registrador Exemplo LTDA']]] },
          ],
        },
      }),
    });
    const r = await new HttpRdapClient('https://rdap.org/', hop).lookupDomain('https://EXEMPLO.com.br/caminho?x=1');
    expect(r).toMatchObject({ domain: 'exemplo.com.br', status: ['active'], registrar: 'Registrador Exemplo LTDA', registeredAt: '2020-01-01T00:00:00Z', expiresAt: '2030-01-01T00:00:00Z' });
    expect(r?.nameservers).toEqual(['a.dns.exemplo.com.br', 'b.dns.exemplo.com.br']);
    expect(JSON.stringify(r)).not.toMatch(/Secreta|pessoa@/);
  });

  it('404/sem corpo => null', async () => {
    const { hop } = fakeHop({ 'https://rdap.org/': () => ({ status: 404 }) });
    expect(await new HttpRdapClient('https://rdap.org/', hop).lookup('8.8.8.8')).toBeNull();
  });
});

describe('perfil de IP com RDAP sob demanda (API)', () => {
  let t: TestApp;
  let s: Session;
  const lookup = vi.fn(async (ip: string) => ({ handle: 'NET-TESTE', name: 'Rede de Teste', country: 'BR', startAddress: ip, endAddress: ip, type: 'ALLOCATION', fetchedFrom: 'rdap.org' }));
  beforeAll(async () => {
    t = await startTestApp({ RDAP_ENABLED: 'true' }, { rdap: { lookup, lookupDomain: async () => null } });
    s = await t.login();
    await makeLink(t, s);
    await t.ctx.pool.query("INSERT INTO access_events (slug, ip_address, method, http_status) VALUES ('campanha-a1', '8.8.8.8', 'GET', 302)");
  });
  afterAll(async () => {
    await t.close();
  });

  it('só consulta com rdap=true, grava em cache e reutiliza sem nova consulta', async () => {
    const a = (await t.app.inject({ method: 'GET', url: '/api/v1/ips/8.8.8.8', headers: s.headers() })).json();
    expect(a.rdap).toBeNull();
    expect(lookup).not.toHaveBeenCalled();
    const b = (await t.app.inject({ method: 'GET', url: '/api/v1/ips/8.8.8.8?rdap=true', headers: s.headers() })).json();
    expect(b.rdap.handle).toBe('NET-TESTE');
    expect(lookup).toHaveBeenCalledTimes(1);
    const c = (await t.app.inject({ method: 'GET', url: '/api/v1/ips/8.8.8.8', headers: s.headers() })).json();
    expect(c.rdap.handle).toBe('NET-TESTE');
    expect(c.intelligence.some((i: { source: string }) => i.source === 'rdap')).toBe(false);
  });
});
