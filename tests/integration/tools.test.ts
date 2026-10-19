import http from 'node:http';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { runPurge } from '../../apps/worker/src/purge.ts';
import { lookupMac } from '../../apps/api/src/tools/oui.ts';
import { SafeHttpError, guardedLookup, safeHop, type Hop, type HopResult } from '../../apps/api/src/tools/safe-http.ts';
import { checkUrl } from '../../apps/api/src/tools/url-check.ts';
import { DASH_HOST, USER_PASSWORD, loginUser, nextIp, signup, startTestApp, type Session, type TestApp } from './helpers.ts';

let t: TestApp;
let admin: Session;
let ana: Session;
let beto: Session;

const rdapIp = vi.fn(async (ip: string) => ({ handle: 'NET-TESTE', name: 'Rede de Teste', country: 'BR', startAddress: ip, endAddress: ip, type: 'ALLOCATION', fetchedFrom: 'rdap.org' }));
const rdapDomain = vi.fn(async (d: string) => ({ domain: d, status: ['active'], registrar: 'Registrador Teste', nameservers: ['ns1.teste.com'], registeredAt: '2020-01-01T00:00:00Z', expiresAt: null, changedAt: null, fetchedFrom: 'rdap.org' }));

let hopImpl: Hop = async () => {
  throw new SafeHttpError('network_error', 'sem rota');
};

beforeAll(async () => {
  t = await startTestApp(
    { SIGNUP_MODE: 'open', RDAP_ENABLED: 'true' },
    { rdap: { lookup: rdapIp, lookupDomain: rdapDomain }, hop: ((url, opts) => hopImpl(url, opts)) as Hop },
  );
  admin = await t.login();
  await signup(t, 'ana@example.org');
  await signup(t, 'beto@example.org');
  ana = await loginUser(t, 'ana@example.org');
  beto = await loginUser(t, 'beto@example.org');
});
afterAll(async () => {
  await t.close();
});
beforeEach(async () => {
  await t.ctx.pool.query('TRUNCATE private_notes');
  rdapIp.mockClear();
  rdapDomain.mockClear();
});

const get = (s: Session, url: string, remoteAddress = nextIp()) =>
  t.app.inject({ method: 'GET', url: `/api/v1${url}`, headers: s.headers(), remoteAddress });
const post = (s: Session, url: string, payload: unknown, remoteAddress = nextIp()) =>
  t.app.inject({ method: 'POST', url: `/api/v1${url}`, headers: s.headers(), payload: payload as object, remoteAddress });

const res = (status: number, headers: Record<string, string> = {}): HopResult => ({ status, headers, body: null, ms: 3, tls: true });

describe('acesso às ferramentas', () => {
  it('todas exigem login', async () => {
    const calls: Array<[string, string]> = [
      ['GET', '/tools/whoami'], ['GET', '/tools/ip/8.8.8.8'], ['GET', '/tools/whois?q=exemplo.com'], ['GET', '/tools/mac?q=286FB9'],
      ['POST', '/tools/url-check'], ['POST', '/tools/notes'], ['GET', '/tools/notes'],
    ];
    for (const [method, url] of calls) {
      const r = await t.app.inject({ method: method as 'GET', url: `/api/v1${url}`, headers: { host: DASH_HOST }, remoteAddress: nextIp(), payload: method === 'POST' ? {} : undefined });
      expect(r.statusCode, `${method} ${url}`).toBe(401);
    }
  });

  it('usuários comuns têm acesso (não é só do admin)', async () => {
    expect((await get(ana, '/tools/whoami')).statusCode).toBe(200);
    expect((await get(admin, '/tools/whoami')).statusCode).toBe(200);
  });
});

describe('meu IP e User-Agent', () => {
  it('mostra o IP visto pelo servidor e a classificação do navegador', async () => {
    const r = await t.app.inject({
      method: 'GET', url: '/api/v1/tools/whoami', remoteAddress: '198.51.100.77',
      headers: { ...ana.headers(), 'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36', 'accept-language': 'pt-BR' },
    });
    const b = r.json();
    expect(b).toMatchObject({ ip: '198.51.100.77', version: 'IPv4', browser: 'Chrome', os: 'Windows', acceptLanguage: 'pt-BR' });
    expect(b.range).toBe('reserved');
  });

  it('atrás de proxy confiável usa o IP encaminhado e ignora o forjado', async () => {
    const r = await t.app.inject({
      method: 'GET', url: '/api/v1/tools/whoami', remoteAddress: '10.1.1.1',
      headers: { ...ana.headers(), 'x-forwarded-for': '6.6.6.6, 8.8.4.4' },
    });
    expect(r.json().ip).toBe('8.8.4.4');
  });
});

describe('consulta de IP', () => {
  it('valida a entrada e nunca consulta nada externo para IP não público', async () => {
    expect((await get(ana, '/tools/ip/nao-ip')).statusCode).toBe(400);
    for (const ip of ['10.0.0.1', '127.0.0.1', '192.168.1.5', '169.254.169.254', '203.0.113.9', '::1']) {
      const r = (await get(ana, `/tools/ip/${encodeURIComponent(ip)}?rdap=true`)).json();
      expect(r.public).toBe(false);
      expect(r.rdap).toBeUndefined();
    }
    expect(rdapIp).not.toHaveBeenCalled();
  });

  it('IP público: classificação, Tor e RDAP sob demanda com cache', async () => {
    const plain = (await get(ana, '/tools/ip/8.8.8.8')).json();
    expect(plain).toMatchObject({ ip: '8.8.8.8', public: true, version: 'IPv4', range: 'unicast', rdap: null });
    expect(plain.geo.available).toBe(false); // sem bases GeoLite2 no ambiente de teste
    expect(rdapIp).not.toHaveBeenCalled();
    const a = (await get(ana, '/tools/ip/8.8.8.8?rdap=true')).json();
    expect(a.rdap.handle).toBe('NET-TESTE');
    await get(beto, '/tools/ip/8.8.8.8?rdap=true');
    expect(rdapIp).toHaveBeenCalledTimes(1);
  });

  it('tor: lista carregada identifica saída Tor', async () => {
    await t.ctx.pool.query(`INSERT INTO job_state (key, value) VALUES ('tor_list', '{"state":"ready"}') ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`);
    await t.ctx.pool.query("INSERT INTO tor_exit_nodes (ip_address) VALUES ('8.8.4.4') ON CONFLICT DO NOTHING");
    expect((await get(ana, '/tools/ip/8.8.4.4')).json().tor).toBe(true);
    expect((await get(ana, '/tools/ip/1.1.1.1')).json().tor).toBe(false);
    await t.ctx.pool.query("DELETE FROM tor_exit_nodes; DELETE FROM job_state WHERE key = 'tor_list'");
  });

  it('não revela se o IP já visitou links de outros usuários (sem inteligência cacheada)', async () => {
    await t.ctx.pool.query("INSERT INTO ip_intelligence (ip_address, source, status, data_redacted, expires_at) VALUES ('9.9.9.9', 'abuseipdb', 'ok', '{\"abuseConfidenceScore\": 99}', now() + interval '1 day') ON CONFLICT DO NOTHING");
    const r = (await get(ana, '/tools/ip/9.9.9.9')).json();
    expect(JSON.stringify(r)).not.toMatch(/abuse|99/i);
  });
});

describe('WHOIS / RDAP', () => {
  it('domínio: normaliza e consulta uma vez (cache)', async () => {
    const r = (await get(ana, `/tools/whois?q=${encodeURIComponent('https://EXEMPLO.com.br/caminho')}`)).json();
    expect(r).toMatchObject({ kind: 'domain', query: 'exemplo.com.br', result: { registrar: 'Registrador Teste' } });
    await get(beto, '/tools/whois?q=exemplo.com.br');
    expect(rdapDomain).toHaveBeenCalledTimes(1);
  });

  it('IP público aceito; IP privado, domínio inválido e hosts internos recusados', async () => {
    expect((await get(ana, '/tools/whois?q=8.8.8.8')).json().kind).toBe('ip');
    for (const q of ['10.0.0.1', 'localhost', 'intranet.local', 'http://127.0.0.1', 'a b.com', 'x']) {
      expect((await get(ana, `/tools/whois?q=${encodeURIComponent(q)}`)).statusCode, q).toBe(400);
    }
  });

  it('falha do serviço externo vira 502 sem detalhes internos', async () => {
    rdapDomain.mockRejectedValueOnce(new SafeHttpError('timeout', 'Tempo esgotado'));
    const r = await get(ana, '/tools/whois?q=falha-externa.com.br');
    expect(r.statusCode).toBe(502);
    expect(r.json().error.code).toBe('upstream_error');
  });
});

describe('fabricante pelo MAC (OUI)', () => {
  it('reconhece o prefixo, normaliza formatos e detecta MAC aleatório', async () => {
    const ok = (await get(ana, '/tools/mac?q=28-6F-B9-11-22-33')).json();
    expect(ok).toMatchObject({ valid: true, normalized: '28:6F:B9:11:22:33', matchedPrefix: '286FB9', locallyAdministered: false });
    expect(ok.vendor).toMatch(/Nokia/);
    expect((await get(ana, '/tools/mac?q=286f.b911.2233')).json().vendor).toMatch(/Nokia/);
    const rnd = (await get(ana, '/tools/mac?q=02:11:22:33:44:55')).json();
    expect(rnd.locallyAdministered).toBe(true);
    expect(rnd.notice).toMatch(/aleat/i);
  });

  it('entradas inválidas => 400', async () => {
    for (const q of ['zzzzzz', '12345', 'AA:BB:CC:DD:EE:FF:00', "00:1A:2B'; DROP TABLE x;--"]) {
      expect((await get(ana, `/tools/mac?q=${encodeURIComponent(q)}`)).statusCode, q).toBe(400);
    }
  });

  it('prefixos de 28/36 bits (MA-M/MA-S) têm prioridade sobre o de 24 bits', () => {
    const oui = { '001122': 'Genérico S.A.', '0011223': 'Específico MA-M Ltda', '001122334': 'Super-específico MA-S Ltda' };
    expect(lookupMac('00:11:22:33:44:55', oui).vendor).toBe('Super-específico MA-S Ltda');
    expect(lookupMac('00:11:22:40:00:00', oui).vendor).toBe('Genérico S.A.');
  });
});

describe('verificador de URL', () => {
  it('segue a cadeia, avisa sobre rebaixamento e múltiplos domínios', async () => {
    const seen: string[] = [];
    hopImpl = async (url) => {
      seen.push(url);
      if (url === 'https://curto.example.org/a') return res(301, { location: 'https://meio.example.org/b' });
      if (url === 'https://meio.example.org/b') return res(302, { location: 'http://final.example.net/c' });
      return res(200, { server: 'nginx', 'content-type': 'text/html' });
    };
    const r = (await post(ana, '/tools/url-check', { url: 'curto.example.org/a' })).json();
    expect(seen[0]).toBe('https://curto.example.org/a'); // esquema assumido
    expect(r.redirects).toBe(2);
    expect(r.finalUrl).toBe('http://final.example.net/c');
    expect(r.finalStatus).toBe(200);
    expect(r.warnings.join(' ')).toMatch(/Rebaixamento/);
    expect(r.warnings.join(' ')).toMatch(/3 domínios/);
    expect(r.hops).toHaveLength(3);
  });

  it('cai para GET quando o servidor rejeita HEAD', async () => {
    const methods: string[] = [];
    hopImpl = async (_u, opts) => {
      methods.push(opts?.method ?? 'HEAD');
      return opts?.method === 'GET' ? res(200) : res(405);
    };
    const r = (await post(ana, '/tools/url-check', { url: 'https://exemplo.example.org' })).json();
    expect(methods).toEqual(['HEAD', 'GET']);
    expect(r.finalStatus).toBe(200);
  });

  it('detecta laço e excesso de redirecionamentos', async () => {
    hopImpl = async (url) => res(302, { location: url.endsWith('/a') ? 'https://x.example.org/b' : 'https://x.example.org/a' });
    expect((await post(ana, '/tools/url-check', { url: 'https://x.example.org/a' })).json().error.code).toBe('redirect_loop');
    let n = 0;
    hopImpl = async () => res(302, { location: `https://x.example.org/${++n}` });
    expect((await post(ana, '/tools/url-check', { url: 'https://x.example.org/0' })).json().error.code).toBe('too_many_redirects');
  });

  it('erros de transporte aparecem no resultado sem derrubar a API', async () => {
    hopImpl = async () => {
      throw new SafeHttpError('blocked_address', 'O endereço de destino resolve para uma rede privada ou reservada');
    };
    const r = await post(ana, '/tools/url-check', { url: 'https://rebind.example.org' });
    expect(r.statusCode).toBe(200);
    expect(r.json().error.code).toBe('blocked_address');
  });
});

describe('cliente HTTP seguro (unidade)', () => {
  it('guardedLookup recusa nomes que resolvem para loopback/privado (anti DNS rebinding)', async () => {
    const r = await new Promise<NodeJS.ErrnoException | null>((resolve) => guardedLookup('localhost', { all: true }, (err) => resolve(err)));
    expect(r?.code).toBe('EBLOCKED');
  });

  it('safeHop rejeita IP/porta/esquema proibidos antes de abrir conexão', async () => {
    const server = http.createServer((_q, s) => s.end('segredo-interno'));
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const port = (server.address() as { port: number }).port;
    let hit = 0;
    server.on('request', () => hit++);
    try {
      await expect(safeHop(`http://127.0.0.1:${port}/`)).rejects.toMatchObject({ code: 'blocked_url' });
      await expect(safeHop(`http://localhost:${port}/`)).rejects.toMatchObject({ code: 'blocked_url' });
      await expect(safeHop('http://exemplo.org:8080/')).rejects.toMatchObject({ code: 'blocked_port' });
      await expect(safeHop('ftp://exemplo.org/')).rejects.toMatchObject({ code: 'blocked_url' });
      expect(hit).toBe(0);
    } finally {
      server.close();
    }
  });
});

describe('notas privadas autodestrutivas', () => {
  const payload = (extra: Record<string, unknown> = {}) => ({ ciphertext: 'QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVo', iv: 'MTIzNDU2Nzg5MDEy', ttlHours: 24, ...extra });

  it('cria (logado), lista, e o destinatário lê UMA vez sem conta; o servidor só guarda texto cifrado', async () => {
    const c = await post(ana, '/tools/notes', payload());
    expect(c.statusCode).toBe(201);
    const id = c.json().id as string;
    expect((await get(ana, '/tools/notes')).json().items.map((n: { id: string }) => n.id)).toContain(id);
    expect((await get(beto, '/tools/notes')).json().items).toHaveLength(0);

    const exists = await t.app.inject({ method: 'GET', url: `/api/v1/public/notes/${id}`, headers: { host: DASH_HOST }, remoteAddress: nextIp() });
    expect(exists.statusCode).toBe(200);
    expect(exists.json()).toMatchObject({ exists: true });
    expect(exists.body).not.toContain('QUJDREVG'); // checar existência não revela nem consome

    const read1 = await t.app.inject({ method: 'POST', url: `/api/v1/public/notes/${id}/read`, headers: { host: DASH_HOST }, remoteAddress: nextIp() });
    expect(read1.statusCode).toBe(200);
    expect(read1.json()).toEqual({ ciphertext: payload().ciphertext, iv: payload().iv });
    const read2 = await t.app.inject({ method: 'POST', url: `/api/v1/public/notes/${id}/read`, headers: { host: DASH_HOST }, remoteAddress: nextIp() });
    expect(read2.statusCode).toBe(404);
    expect((await get(ana, '/tools/notes')).json().items).toHaveLength(0);
  });

  it('leituras concorrentes entregam o conteúdo a no máximo UM leitor', async () => {
    const id = (await post(ana, '/tools/notes', payload())).json().id as string;
    const results = await Promise.all(
      Array.from({ length: 8 }, () => t.app.inject({ method: 'POST', url: `/api/v1/public/notes/${id}/read`, headers: { host: DASH_HOST }, remoteAddress: nextIp() })),
    );
    expect(results.filter((r) => r.statusCode === 200)).toHaveLength(1);
  });

  it('nota expirada some e o expurgo remove os resíduos', async () => {
    const id = (await post(ana, '/tools/notes', payload())).json().id as string;
    await t.ctx.pool.query("UPDATE private_notes SET expires_at = now() - interval '1 minute' WHERE id = $1", [id]);
    expect((await t.app.inject({ method: 'GET', url: `/api/v1/public/notes/${id}`, headers: { host: DASH_HOST }, remoteAddress: nextIp() })).statusCode).toBe(404);
    expect((await t.app.inject({ method: 'POST', url: `/api/v1/public/notes/${id}/read`, headers: { host: DASH_HOST }, remoteAddress: nextIp() })).statusCode).toBe(404);
    await runPurge(t.ctx.pool, { retentionDays: 30, auditRetentionDays: 365 });
    expect((await t.ctx.pool.query('SELECT 1 FROM private_notes WHERE id = $1', [id])).rowCount).toBe(0);
  });

  it('só o dono apaga; formato, tamanho e TTL são validados; origem divergente é recusada', async () => {
    const id = (await post(ana, '/tools/notes', payload())).json().id as string;
    expect((await t.app.inject({ method: 'DELETE', url: `/api/v1/tools/notes/${id}`, headers: beto.headers(), remoteAddress: nextIp() })).statusCode).toBe(404);
    expect((await t.app.inject({ method: 'DELETE', url: `/api/v1/tools/notes/${id}`, headers: ana.headers(), remoteAddress: nextIp() })).statusCode).toBe(200);
    expect((await post(ana, '/tools/notes', payload({ ciphertext: '<script>alert(1)</script>' }))).statusCode).toBe(400);
    expect((await post(ana, '/tools/notes', payload({ ciphertext: 'A'.repeat(50_000) }))).statusCode).toBe(400);
    expect((await post(ana, '/tools/notes', payload({ ttlHours: 1000 }))).statusCode).toBe(400);
    const id2 = (await post(ana, '/tools/notes', payload())).json().id as string;
    const bad = await t.app.inject({ method: 'POST', url: `/api/v1/public/notes/${id2}/read`, headers: { host: DASH_HOST, origin: 'https://evil.example' }, remoteAddress: nextIp() });
    expect(bad.statusCode).toBe(403);
    expect((await t.ctx.pool.query('SELECT 1 FROM private_notes WHERE id = $1', [id2])).rowCount).toBe(1);
  });

  it('limita o número de notas ativas por conta e apaga tudo ao excluir a conta', async () => {
    for (let i = 0; i < 50; i++) await t.ctx.pool.query("INSERT INTO private_notes (account_id, ciphertext, iv, expires_at) SELECT id, 'x', 'y', now() + interval '1 hour' FROM accounts WHERE email = 'beto@example.org'");
    const over = await post(beto, '/tools/notes', payload());
    expect(over.statusCode).toBe(403);
    expect(over.json().error.code).toBe('quota_exceeded');
    expect((await post(beto, '/auth/delete-account', { password: USER_PASSWORD })).statusCode).toBe(200);
    expect((await t.ctx.pool.query("SELECT count(*)::int AS n FROM private_notes pn JOIN accounts a ON a.id = pn.account_id WHERE a.email = 'beto@example.org'")).rows[0].n).toBe(0);
  });
});
