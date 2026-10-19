import net from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DASH_HOST, SHORT_HOST, makeLink, startTestApp, type Session, type TestApp } from '../integration/helpers.ts';

let t: TestApp;
let s: Session;

beforeAll(async () => {
  t = await startTestApp({
    ABUSEIPDB_ENABLED: 'true',
    ABUSEIPDB_API_KEY: 'chave-super-secreta-abuse-123',
    GREYNOISE_API_KEY: 'chave-super-secreta-grey-456',
    PRIVACY_CONTROLLER_NAME: '<script>alert(1)</script>Empresa',
  });
  s = await t.login();
  await makeLink(t, s);
});
afterAll(async () => {
  await t.close();
});

const get = (url: string, headers: Record<string, string> = {}, remoteAddress = '198.51.100.9') =>
  t.app.inject({ method: 'GET', url, headers: { host: SHORT_HOST, ...headers }, remoteAddress });

describe('injeção SQL', () => {
  it('parâmetros hostis em filtros/rotas não causam erro de banco nem vazam dados', async () => {
    const payloads = ["' OR 1=1--", "'; DROP TABLE short_links;--", '1 UNION SELECT password_hash FROM accounts'];
    for (const p of payloads) {
      const enc = encodeURIComponent(p);
      const ev = await t.app.inject({ method: 'GET', url: `/api/v1/events?ip=${enc}`, headers: s.headers() });
      expect(ev.statusCode).toBe(400);
      const q = await t.app.inject({ method: 'GET', url: `/api/v1/links?q=${enc}`, headers: s.headers() });
      expect(q.statusCode).toBe(200);
      expect(q.json().items).toHaveLength(0);
      expect((await t.app.inject({ method: 'GET', url: `/api/v1/ips/${enc}`, headers: s.headers() })).statusCode).toBe(400);
      expect((await get(`/${enc}`)).statusCode).toBe(404);
      const al = await t.app.inject({ method: 'GET', url: `/api/v1/alerts?type=${enc}`, headers: s.headers() });
      expect(al.statusCode).toBe(200);
    }
    const { rows } = await t.ctx.pool.query('SELECT count(*)::int AS n FROM short_links');
    expect(rows[0].n).toBeGreaterThanOrEqual(1);
    const ad = await t.ctx.pool.query('SELECT count(*)::int AS n FROM accounts');
    expect(ad.rows[0].n).toBe(1);
  });

  it('LIKE com curingas literais é escapado (q=%)', async () => {
    const r = await t.app.inject({ method: 'GET', url: '/api/v1/links?q=%25', headers: s.headers() });
    expect(r.json().items).toHaveLength(0);
  });
});

describe('XSS e cabeçalhos de segurança', () => {
  it('/privacy escapa dados configuráveis e define CSP restritiva', async () => {
    const r = await get('/privacy');
    expect(r.body).not.toContain('<script>alert(1)</script>');
    expect(r.body).toContain('&lt;script&gt;alert(1)&lt;/script&gt;Empresa');
    expect(r.headers['content-security-policy']).toContain("default-src 'none'");
    expect(r.headers['x-content-type-options']).toBe('nosniff');
  });

  it('respostas incluem nosniff, referrer-policy, noindex e no-store', async () => {
    const r = await t.app.inject({ method: 'GET', url: '/api/v1/auth/me', headers: s.headers() });
    expect(r.headers['x-content-type-options']).toBe('nosniff');
    expect(r.headers['referrer-policy']).toBe('no-referrer');
    expect(r.headers['x-robots-tag']).toContain('noindex');
    expect(r.headers['cache-control']).toBe('no-store');
    expect((await get('/robots.txt')).body).toContain('Disallow: /');
  });
});

describe('cookies de sessão', () => {
  it('com COOKIE_SECURE usa prefixo __Host-, Secure, HttpOnly e SameSite=Strict', async () => {
    const t2 = await startTestApp({ COOKIE_SECURE: 'true' });
    try {
      const r1 = await t2.app.inject({ method: 'POST', url: '/api/v1/auth/login', headers: { host: DASH_HOST }, payload: { email: 'admin@example.org', password: 'Senha-Forte-#2026-xyz' } });
      const r2 = await t2.app.inject({
        method: 'POST', url: '/api/v1/auth/totp/verify', headers: { host: DASH_HOST },
        payload: { challenge: r1.json().challenge, code: t2.recoveryCodes[0] },
      });
      expect(r2.statusCode).toBe(200);
      const c = r2.cookies[0]!;
      expect(c.name).toBe('__Host-iplc_session');
      expect(c.secure).toBe(true);
      expect(c.httpOnly).toBe(true);
      expect(String(c.sameSite).toLowerCase()).toBe('strict');
      expect(c.path).toBe('/');
      expect(c.domain).toBeUndefined();
    } finally {
      await t2.close();
    }
    // reabre o banco para o restante da suíte (startTestApp reseta as tabelas)
    t = await startTestApp({ ABUSEIPDB_API_KEY: 'chave-super-secreta-abuse-123', GREYNOISE_API_KEY: 'chave-super-secreta-grey-456' });
    s = await t.login();
    await makeLink(t, s);
  });
});

describe('segredos nunca expostos', () => {
  it('respostas administrativas não contêm chaves de API, segredo TOTP, hash de senha ou chave de cifra', async () => {
    const secrets = ['chave-super-secreta-abuse-123', 'chave-super-secreta-grey-456', t.ctx.config.TOTP_ENCRYPTION_KEY, t.ctx.config.SESSION_SECRET, t.totpSecret, 'argon2'];
    const paths = ['/settings', '/integrations/status', '/dashboard/summary', '/links', '/events', '/alerts', '/audit', '/auth/me'];
    for (const p of paths) {
      const r = await t.app.inject({ method: 'GET', url: `/api/v1${p}`, headers: s.headers() });
      expect(r.statusCode).toBe(200);
      for (const sec of secrets) expect(r.body).not.toContain(sec);
    }
  });
});

describe('erros e limites', () => {
  it('erro interno não vaza stack trace nem detalhes do banco', async () => {
    const original = t.ctx.pool.query.bind(t.ctx.pool);
    (t.ctx.pool as unknown as { query: unknown }).query = (sql: unknown, ...rest: unknown[]) => {
      if (typeof sql === 'string' && sql.includes('FROM short_links l')) return Promise.reject(new Error('relation "short_links" does not exist at /app/secret/path.ts:99'));
      return (original as (...a: unknown[]) => unknown)(sql, ...rest);
    };
    try {
      const r = await t.app.inject({ method: 'GET', url: '/api/v1/links', headers: s.headers() });
      expect(r.statusCode).toBe(500);
      expect(r.body).not.toMatch(/short_links|secret|\.ts|stack/);
      expect(r.json().error.code).toBe('internal_error');
    } finally {
      (t.ctx.pool as unknown as { query: unknown }).query = original;
    }
  });

  it('corpo acima de 64 KB é recusado', async () => {
    const r = await t.app.inject({ method: 'POST', url: '/api/v1/auth/login', headers: { host: DASH_HOST, 'content-type': 'application/json' }, payload: JSON.stringify({ email: 'a@b.co', password: 'x'.repeat(70_000) }) });
    expect(r.statusCode).toBe(413);
  });

  it('JSON malformado e campos inesperados retornam 400 sem detalhes internos', async () => {
    const r = await t.app.inject({ method: 'POST', url: '/api/v1/auth/login', headers: { host: DASH_HOST, 'content-type': 'application/json' }, payload: '{"email": ' });
    expect(r.statusCode).toBe(400);
    const r2 = await t.app.inject({ method: 'POST', url: '/api/v1/auth/login', headers: { host: DASH_HOST }, payload: { email: 'nao-e-email', password: 1 } });
    expect(r2.statusCode).toBe(400);
  });

  it('limitação de taxa no login (CA-12) responde 429 após exceder o limite', async () => {
    const statuses: number[] = [];
    for (let i = 0; i < 14; i++) {
      const r = await t.app.inject({ method: 'POST', url: '/api/v1/auth/login', headers: { host: DASH_HOST }, payload: { email: 'x@example.org', password: 'senha-errada-qualquer-1A' }, remoteAddress: '203.0.113.200' });
      statuses.push(r.statusCode);
    }
    expect(statuses).toContain(429);
    expect(statuses.slice(0, 5).every((c) => c === 401)).toBe(true);
  });
});

describe('open redirect e destino', () => {
  it('parâmetros de query/path nunca alteram o destino; Location vem sempre do cadastro', async () => {
    for (const url of ['/campanha-a1?next=https://evil.example', '/campanha-a1?url=//evil.example', '/campanha-a1/../../evil', '/campanha-a1%2F..%2Fevil']) {
      const r = await get(url);
      if (r.statusCode === 302) expect(r.headers.location).toBe('https://example.org/recurso');
      else expect(r.statusCode).toBe(404);
      expect(String(r.headers.location ?? '')).not.toContain('evil');
    }
  });

  it('destino adulterado diretamente no banco é revalidado antes de redirecionar (defesa em profundidade)', async () => {
    await t.ctx.pool.query("UPDATE short_links SET target_url = 'javascript:alert(1)' WHERE slug = 'campanha-a1'");
    t.ctx.linkCache.clear();
    const r = await get('/campanha-a1');
    expect(r.statusCode).toBe(404);
    expect(r.headers.location).toBeUndefined();
    await t.ctx.pool.query("UPDATE short_links SET target_url = 'https://example.org/recurso' WHERE slug = 'campanha-a1'");
    t.ctx.linkCache.clear();
  });
});

describe('cabeçalhos hostis em conexão real (CA-15)', () => {
  it('caracteres de controle em cabeçalhos são recusados pelo parser; CR/LF não permitem injetar cabeçalhos persistidos', async () => {
    await t.app.listen({ port: 0, host: '127.0.0.1' });
    const port = (t.app.server.address() as net.AddressInfo).port;
    const send = (raw: string) =>
      new Promise<string>((resolve) => {
        const sock = net.connect(port, '127.0.0.1', () => sock.write(raw));
        let data = '';
        sock.on('data', (d) => (data += d.toString('latin1')));
        sock.on('close', () => resolve(data));
        sock.on('error', () => resolve(data));
        setTimeout(() => sock.destroy(), 1500);
      });

    // 1) byte de controle dentro do valor do User-Agent
    const ctrl = await send(`GET /campanha-a1 HTTP/1.1\r\nHost: ${SHORT_HOST}\r\nUser-Agent: x\x01y\r\nConnection: close\r\n\r\n`);
    expect(ctrl.startsWith('HTTP/1.1 400')).toBe(true);

    // 2) tentativa de "injetar" cabeçalhos via CRLF no UA: vira cabeçalhos separados; nada sensível é persistido
    await t.ctx.pool.query('TRUNCATE access_events CASCADE');
    const inj = await send(`GET /campanha-a1 HTTP/1.1\r\nHost: ${SHORT_HOST}\r\nUser-Agent: Mozilla/5.0\r\nSet-Cookie: roubado=1\r\nAuthorization: Bearer TOKEN-SECRETO\r\nCookie: sessao=SEGREDO\r\nConnection: close\r\n\r\n`);
    expect(inj.startsWith('HTTP/1.1 302')).toBe(true);
    expect(inj).not.toContain('roubado');
    const { rows } = await t.ctx.pool.query('SELECT to_jsonb(e)::text AS j FROM access_events e');
    expect(rows).toHaveLength(1);
    for (const bad of ['TOKEN-SECRETO', 'SEGREDO', 'roubado']) expect(rows[0].j).not.toContain(bad);

    // 3) cabeçalhos gigantes (431) não derrubam o serviço
    const big = await send(`GET /campanha-a1 HTTP/1.1\r\nHost: ${SHORT_HOST}\r\nUser-Agent: ${'a'.repeat(40_000)}\r\nConnection: close\r\n\r\n`);
    expect(big).toMatch(/^HTTP\/1\.1 (431|400)/);
    expect((await get('/campanha-a1')).statusCode).toBe(302);
  });
});

describe('IPv6 e IPs especiais (CA-07 — armazenamento)', () => {
  it('registra IPv6 completo e IPv4-mapped como IPv4', async () => {
    await t.ctx.pool.query('TRUNCATE access_events CASCADE');
    await get('/campanha-a1', {}, '2001:db8:85a3::8a2e:370:7334');
    await get('/campanha-a1', {}, '::ffff:198.51.100.77');
    const { rows } = await t.ctx.pool.query('SELECT host(ip_address) AS ip FROM access_events ORDER BY ip');
    expect(rows.map((r) => r.ip)).toEqual(['198.51.100.77', '2001:db8:85a3::8a2e:370:7334']);
  });
});
