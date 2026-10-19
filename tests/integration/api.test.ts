import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  ADMIN_EMAIL, ADMIN_PASSWORD, DASH_HOST, SHORT_HOST, currentTotp, makeLink, startTestApp, type Session, type TestApp,
} from './helpers.ts';

const CHROME = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

let t: TestApp;
let s: Session;

beforeAll(async () => {
  t = await startTestApp();
  s = await t.login();
});
afterAll(async () => {
  await t.close();
});
beforeEach(async () => {
  await t.ctx.pool.query('TRUNCATE short_links, access_events, outbox_events, alerts, exports, telemetry_counters CASCADE');
  t.ctx.linkCache.clear();
});

const get = (url: string, headers: Record<string, string> = {}, remoteAddress = '198.51.100.9') =>
  t.app.inject({ method: 'GET', url, headers: { host: SHORT_HOST, ...headers }, remoteAddress });

describe('autenticação (CA-12, CA-13)', () => {
  it('rota protegida sem sessão retorna 401', async () => {
    const r = await t.app.inject({ method: 'GET', url: '/api/v1/links', headers: { host: DASH_HOST } });
    expect(r.statusCode).toBe(401);
  });

  it('senha incorreta: 401 genérico, sem cookie, sem credenciais no corpo', async () => {
    const r = await t.app.inject({
      method: 'POST', url: '/api/v1/auth/login', headers: { host: DASH_HOST }, payload: { email: ADMIN_EMAIL, password: 'errada-errada-1A!' },
    });
    expect(r.statusCode).toBe(401);
    expect(r.cookies).toHaveLength(0);
    expect(r.body).not.toContain('errada');
  });

  it('e-mail inexistente tem a mesma resposta', async () => {
    const r = await t.app.inject({
      method: 'POST', url: '/api/v1/auth/login', headers: { host: DASH_HOST }, payload: { email: 'nao@existe.org', password: 'qualquer-coisa-1A!' },
    });
    expect(r.statusCode).toBe(401);
    expect(r.json().error.code).toBe('invalid_credentials');
  });

  it('senha certa mas TOTP errado não cria sessão', async () => {
    const r1 = await t.app.inject({
      method: 'POST', url: '/api/v1/auth/login', headers: { host: DASH_HOST }, payload: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD },
    });
    const { challenge } = r1.json();
    const r2 = await t.app.inject({
      method: 'POST', url: '/api/v1/auth/totp/verify', headers: { host: DASH_HOST }, payload: { challenge, code: '000000' },
    });
    expect(r2.statusCode).toBe(401);
    expect(r2.cookies).toHaveLength(0);
  });

  it('TOTP válido cria sessão com cookie HttpOnly/SameSite=Strict; replay do mesmo código é rejeitado', async () => {
    const login = async (code: string) => {
      const r1 = await t.app.inject({
        method: 'POST', url: '/api/v1/auth/login', headers: { host: DASH_HOST }, payload: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD },
      });
      return t.app.inject({
        method: 'POST', url: '/api/v1/auth/totp/verify', headers: { host: DASH_HOST }, payload: { challenge: r1.json().challenge, code },
      });
    };
    const code = currentTotp(t.totpSecret);
    const ok = await login(code);
    expect(ok.statusCode).toBe(200);
    const cookie = ok.cookies[0]!;
    expect(cookie.httpOnly).toBe(true);
    expect(String(cookie.sameSite).toLowerCase()).toBe('strict');
    const replay = await login(code);
    expect(replay.statusCode).toBe(401);
  });

  it('logout revoga a sessão e a API passa a responder 401', async () => {
    const sess = await t.login();
    expect((await t.app.inject({ method: 'GET', url: '/api/v1/auth/me', headers: sess.headers() })).statusCode).toBe(200);
    const out = await t.app.inject({ method: 'POST', url: '/api/v1/auth/logout', headers: sess.headers() });
    expect(out.statusCode).toBe(200);
    expect((await t.app.inject({ method: 'GET', url: '/api/v1/auth/me', headers: sess.headers() })).statusCode).toBe(401);
  });

  it('mutação sem token CSRF é negada; origem divergente também', async () => {
    const noCsrf = await t.app.inject({
      method: 'POST', url: '/api/v1/links', headers: { host: DASH_HOST, cookie: s.cookie }, payload: { targetUrl: 'https://example.org/x' },
    });
    expect(noCsrf.statusCode).toBe(403);
    const badOrigin = await t.app.inject({
      method: 'POST', url: '/api/v1/links', headers: s.headers({ origin: 'https://evil.example' }), payload: { targetUrl: 'https://example.org/x' },
    });
    expect(badOrigin.statusCode).toBe(403);
  });

  it('API administrativa não responde no domínio de links', async () => {
    const r = await t.app.inject({ method: 'GET', url: '/api/v1/links', headers: { host: SHORT_HOST, cookie: s.cookie } });
    expect(r.statusCode).toBe(404);
  });

  it('Host desconhecido recebe 421', async () => {
    const r = await t.app.inject({ method: 'GET', url: '/qualquer', headers: { host: 'outro.example' } });
    expect(r.statusCode).toBe(421);
  });

  it('bloqueia a conta após falhas repetidas e audita sem credenciais', async () => {
    await t.ctx.pool.query('UPDATE admins SET failed_logins = 0, locked_until = NULL');
    for (let i = 0; i < 5; i++) {
      await t.app.inject({
        method: 'POST', url: '/api/v1/auth/login', headers: { host: DASH_HOST }, payload: { email: ADMIN_EMAIL, password: 'errada-errada-1A!' }, remoteAddress: `198.51.100.${20 + i}`,
      });
    }
    const locked = await t.app.inject({
      method: 'POST', url: '/api/v1/auth/login', headers: { host: DASH_HOST }, payload: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD }, remoteAddress: '198.51.100.99',
    });
    expect(locked.statusCode).toBe(429);
    const { rows } = await t.ctx.pool.query("SELECT metadata_redacted::text AS m FROM audit_events WHERE action = 'auth.login' AND result = 'failure'");
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) expect(r.m).not.toContain('errada');
    await t.ctx.pool.query('UPDATE admins SET failed_logins = 0, locked_until = NULL');
  });
});

describe('links (CA-01, CA-20)', () => {
  it('só admin autenticado cria link', async () => {
    const r = await t.app.inject({ method: 'POST', url: '/api/v1/links', headers: { host: DASH_HOST }, payload: { targetUrl: 'https://example.org/x' } });
    expect(r.statusCode).toBe(401);
  });

  it('cria com slug informado e gera URL pública', async () => {
    const { res, body } = await makeLink(t, s);
    expect(res.statusCode).toBe(201);
    expect(body.publicUrl).toBe(`http://${SHORT_HOST}/campanha-a1`);
  });

  it('gera slug aleatório único quando omitido', async () => {
    const a = await makeLink(t, s, { slug: undefined });
    const b = await makeLink(t, s, { slug: undefined });
    expect(a.res.statusCode).toBe(201);
    expect(a.body.slug).toMatch(/^[A-Za-z0-9]{8}$/);
    expect(a.body.slug).not.toBe(b.body.slug);
  });

  it('slug duplicado = 409; reservado/ inválido = 400', async () => {
    await makeLink(t, s);
    expect((await makeLink(t, s)).res.statusCode).toBe(409);
    expect((await makeLink(t, s, { slug: 'privacy' })).res.statusCode).toBe(400);
    expect((await makeLink(t, s, { slug: 'a b' })).res.statusCode).toBe(400);
  });

  it.each([
    'javascript:alert(1)', 'data:text/html,x', 'file:///etc/passwd', 'http://169.254.169.254/latest', 'http://localhost:8080', 'https://u:p@example.org',
  ])('destino malicioso é recusado: %s', async (targetUrl) => {
    const { res } = await makeLink(t, s, { slug: 'mal-' + Math.random().toString(36).slice(2, 8), targetUrl });
    expect(res.statusCode).toBe(400);
  });

  it('lista com paginação por cursor, edita, desativa e remove (soft delete)', async () => {
    for (let i = 0; i < 3; i++) await makeLink(t, s, { slug: `link-${i}-abc` });
    const p1 = (await t.app.inject({ method: 'GET', url: '/api/v1/links?limit=2', headers: s.headers() })).json();
    expect(p1.items).toHaveLength(2);
    expect(p1.nextCursor).toBeTruthy();
    const p2 = (await t.app.inject({ method: 'GET', url: `/api/v1/links?limit=2&cursor=${p1.nextCursor}`, headers: s.headers() })).json();
    expect(p2.items).toHaveLength(1);
    expect(p2.nextCursor).toBeNull();

    const id = p1.items[0].id;
    const patch = await t.app.inject({ method: 'PATCH', url: `/api/v1/links/${id}`, headers: s.headers(), payload: { label: 'Novo', isActive: false } });
    expect(patch.json()).toMatchObject({ label: 'Novo', isActive: false, status: 'inactive' });
    const bad = await t.app.inject({ method: 'PATCH', url: `/api/v1/links/${id}`, headers: s.headers(), payload: { targetUrl: 'javascript:1' } });
    expect(bad.statusCode).toBe(400);
    expect((await t.app.inject({ method: 'DELETE', url: `/api/v1/links/${id}`, headers: s.headers() })).statusCode).toBe(200);
    expect((await t.app.inject({ method: 'GET', url: `/api/v1/links/${id}`, headers: s.headers() })).statusCode).toBe(404);
  });

  it('ações geram auditoria', async () => {
    await makeLink(t, s);
    const r = (await t.app.inject({ method: 'GET', url: '/api/v1/audit?action=link.create', headers: s.headers() })).json();
    expect(r.items.length).toBeGreaterThan(0);
  });
});

describe('redirect (CA-02, CA-14, CA-21)', () => {
  it('GET => 302 com destino correto, no-store e evento + outbox gravados', async () => {
    await makeLink(t, s);
    const r = await get('/campanha-a1', { 'user-agent': CHROME, 'accept-language': 'pt-BR,pt;q=0.9', referer: 'https://exemplo.org/pagina?token=segredo#x' });
    expect(r.statusCode).toBe(302);
    expect(r.headers.location).toBe('https://example.org/recurso');
    expect(r.headers['cache-control']).toBe('no-store');
    const { rows } = await t.ctx.pool.query("SELECT host(ip_address) AS ip, method, http_status, referer_origin, client_class, enrichment_status FROM access_events");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ ip: '198.51.100.9', method: 'GET', http_status: 302, referer_origin: 'https://exemplo.org', client_class: 'human_probable', enrichment_status: 'pending' });
    const ob = await t.ctx.pool.query('SELECT type, published_at FROM outbox_events');
    expect(ob.rows).toEqual([{ type: 'access_event.enrich', published_at: null }]);
  });

  it('HEAD e prévias não contam como visita humana estimada', async () => {
    await makeLink(t, s);
    const head = await t.app.inject({ method: 'HEAD', url: '/campanha-a1', headers: { host: SHORT_HOST, 'user-agent': CHROME }, remoteAddress: '198.51.100.9' });
    expect(head.statusCode).toBe(302);
    await get('/campanha-a1', { 'user-agent': 'WhatsApp/2.23 A' });
    await get('/campanha-a1', { 'user-agent': 'curl/8.4.0' });
    await get('/campanha-a1', { 'user-agent': CHROME });
    const sum = (await t.app.inject({ method: 'GET', url: '/api/v1/dashboard/summary?period=24h', headers: s.headers() })).json();
    expect(sum.requestsTotal).toBe(4);
    expect(sum.estimatedVisits).toBe(1);
    expect(sum.breakdown).toEqual({ bots: 1, previews: 1, headProbes: 1 });
  });

  it('inexistente, desativado, expirado e removido respondem 404 igual, sem vazar destino', async () => {
    const a = await makeLink(t, s, { slug: 'ativo-1' });
    const off = await makeLink(t, s, { slug: 'desativado-1' });
    const exp = await makeLink(t, s, { slug: 'expirado-1' });
    const del = await makeLink(t, s, { slug: 'removido-1' });
    await t.app.inject({ method: 'PATCH', url: `/api/v1/links/${off.body.id}`, headers: s.headers(), payload: { isActive: false } });
    await t.ctx.pool.query("UPDATE short_links SET expires_at = now() - interval '1 minute' WHERE slug = 'expirado-1'");
    await t.app.inject({ method: 'DELETE', url: `/api/v1/links/${del.body.id}`, headers: s.headers() });
    t.ctx.linkCache.clear();

    const bodies = new Set<string>();
    for (const slug of ['nao-existe-1', 'desativado-1', 'expirado-1', 'removido-1']) {
      const r = await get(`/${slug}`);
      expect(r.statusCode).toBe(404);
      expect(r.headers.location).toBeUndefined();
      expect(r.body).not.toContain('example.org');
      bodies.add(r.body);
    }
    expect(bodies.size).toBe(1);
    expect((await get('/ativo-1')).statusCode).toBe(302);
    expect(a.res.statusCode).toBe(201);
  });

  it('link não resolve no domínio do painel; nomes reservados nunca redirecionam', async () => {
    await makeLink(t, s);
    const r = await t.app.inject({ method: 'GET', url: '/campanha-a1', headers: { host: DASH_HOST } });
    expect(r.statusCode).toBe(404);
    const priv = await get('/privacy');
    expect(priv.statusCode).toBe(200);
    expect(priv.headers['content-type']).toContain('text/html');
    expect(priv.body).toContain('Aviso de Privacidade');
  });

  it('desativar invalida o cache imediatamente', async () => {
    const { body } = await makeLink(t, s);
    expect((await get('/campanha-a1')).statusCode).toBe(302);
    await t.app.inject({ method: 'PATCH', url: `/api/v1/links/${body.id}`, headers: s.headers(), payload: { isActive: false } });
    expect((await get('/campanha-a1')).statusCode).toBe(404);
  });
});

describe('IP do cliente e spoofing (CA-06)', () => {
  it('conexão direta ignora X-Forwarded-For forjado', async () => {
    await makeLink(t, s);
    await get('/campanha-a1', { 'x-forwarded-for': '6.6.6.6' }, '198.51.100.9');
    const { rows } = await t.ctx.pool.query('SELECT host(ip_address) AS ip FROM access_events');
    expect(rows[0].ip).toBe('198.51.100.9');
  });

  it('via proxy confiável usa o IP adicionado pelo proxy e ignora o forjado à esquerda', async () => {
    await makeLink(t, s);
    await get('/campanha-a1', { 'x-forwarded-for': '6.6.6.6, 203.0.113.42' }, '10.1.2.3');
    const { rows } = await t.ctx.pool.query('SELECT host(ip_address) AS ip FROM access_events');
    expect(rows[0].ip).toBe('203.0.113.42');
  });

  it('IPv6 é armazenado corretamente', async () => {
    await makeLink(t, s);
    await get('/campanha-a1', {}, '2001:db8::7');
    const { rows } = await t.ctx.pool.query('SELECT host(ip_address) AS ip FROM access_events');
    expect(rows[0].ip).toBe('2001:db8::7');
  });
});

describe('sanitização e privacidade dos registros (CA-15)', () => {
  it('User-Agent é truncado/limpo e cookies/autorização nunca são persistidos', async () => {
    await makeLink(t, s);
    await get('/campanha-a1', {
      'user-agent': `Mozilla/5.0 \t X${'a'.repeat(900)}`,
      cookie: 'sessao=SEGREDO-COOKIE', authorization: 'Bearer SEGREDO-TOKEN',
    });
    const { rows } = await t.ctx.pool.query('SELECT to_jsonb(e)::text AS j FROM access_events e');
    expect(rows).toHaveLength(1);
    expect(rows[0].j).not.toContain('SEGREDO');
    const ua = (await t.ctx.pool.query('SELECT user_agent FROM access_events')).rows[0].user_agent as string;
    expect(ua.length).toBeLessThanOrEqual(512);
    expect(ua).not.toMatch(/[\r\n\t]/);
  });

  it('logs de requisição não contêm IP, slug, query nem cabeçalhos', async () => {
    const { buildApp } = await import('../../apps/api/src/app.ts');
    const lines: string[] = [];
    const ctx2 = { ...t.ctx, config: { ...t.ctx.config, LOG_LEVEL: 'info' as const } };
    const app2 = await buildApp(ctx2, { logStream: { write: (m: string) => void lines.push(m) } });
    await makeLink(t, s, { slug: 'slug-secreto-9' });
    const r = await app2.inject({
      method: 'GET', url: '/slug-secreto-9?token=SEGREDO-QUERY', headers: { host: SHORT_HOST, cookie: 'a=SEGREDO-COOKIE', 'user-agent': CHROME }, remoteAddress: '198.51.100.77',
    });
    expect(r.statusCode).toBe(302);
    await app2.close();
    const out = lines.join('');
    expect(out).toContain('/:slug');
    for (const forbidden of ['198.51.100.77', 'slug-secreto-9', 'SEGREDO', 'Mozilla']) expect(out).not.toContain(forbidden);
  });
});

describe('fail-open quando o banco cai (CA-05)', () => {
  it('redirect continua pelo cache e a falha de captura é contabilizada', async () => {
    await makeLink(t, s);
    expect((await get('/campanha-a1')).statusCode).toBe(302); // aquece o cache
    const original = t.ctx.pool.query.bind(t.ctx.pool);
    (t.ctx.pool as unknown as { query: unknown }).query = () => Promise.reject(new Error('banco indisponível'));
    // força expiração do TTL fresco, mantendo o cache "stale" utilizável
    (t.ctx.linkCache as unknown as { ttlMs: number }).ttlMs = 0;
    try {
      const r = await get('/campanha-a1');
      expect(r.statusCode).toBe(302);
      expect(r.headers.location).toBe('https://example.org/recurso');
      expect(t.ctx.telemetry.totals.get('capture_failed')).toBeGreaterThanOrEqual(1);
      // link nunca visto durante a queda => 503, sem vazar nada
      const unknown = await get('/nunca-visto-1');
      expect(unknown.statusCode).toBe(503);
    } finally {
      (t.ctx.pool as unknown as { query: unknown }).query = original;
      (t.ctx.linkCache as unknown as { ttlMs: number }).ttlMs = t.ctx.config.LINK_CACHE_TTL_MS;
    }
    // após a recuperação, a falha é gravada e visível no painel
    await t.ctx.telemetry.flush(t.ctx.pool);
    const sum = (await t.app.inject({ method: 'GET', url: '/api/v1/dashboard/summary', headers: s.headers() })).json();
    expect(sum.captureFailures).toBeGreaterThanOrEqual(1);
  });
});

describe('eventos, IP e filtros', () => {
  it('filtra por IP/classe/método e pagina com cursor estável', async () => {
    await makeLink(t, s);
    for (let i = 0; i < 5; i++) await get('/campanha-a1', { 'user-agent': CHROME }, `198.51.100.${10 + i}`);
    await get('/campanha-a1', { 'user-agent': 'curl/8' }, '203.0.113.42');
    const all1 = (await t.app.inject({ method: 'GET', url: '/api/v1/events?limit=4', headers: s.headers() })).json();
    expect(all1.items).toHaveLength(4);
    const all2 = (await t.app.inject({ method: 'GET', url: `/api/v1/events?limit=4&cursor=${all1.nextCursor}`, headers: s.headers() })).json();
    expect(all2.items).toHaveLength(2);
    const ids = new Set([...all1.items, ...all2.items].map((e: { id: string }) => e.id));
    expect(ids.size).toBe(6);

    const byIp = (await t.app.inject({ method: 'GET', url: '/api/v1/events?ip=203.0.113.42', headers: s.headers() })).json();
    expect(byIp.items).toHaveLength(1);
    const bots = (await t.app.inject({ method: 'GET', url: '/api/v1/events?clientClass=bot', headers: s.headers() })).json();
    expect(bots.items).toHaveLength(1);
    const badIp = await t.app.inject({ method: 'GET', url: '/api/v1/events?ip=nao-e-ip', headers: s.headers() });
    expect(badIp.statusCode).toBe(400);
  });

  it('perfil de IP valida o IP e resume atividade', async () => {
    await makeLink(t, s);
    await get('/campanha-a1', { 'user-agent': CHROME }, '203.0.113.42');
    const ok = (await t.app.inject({ method: 'GET', url: '/api/v1/ips/203.0.113.42', headers: s.headers() })).json();
    expect(ok.summary.totalEvents).toBe(1);
    expect(ok.links[0].slug).toBe('campanha-a1');
    expect(ok.notice).toMatch(/não permitem identificar uma pessoa/);
    expect((await t.app.inject({ method: 'GET', url: '/api/v1/ips/999.1.1.1', headers: s.headers() })).statusCode).toBe(400);
    expect((await t.app.inject({ method: 'GET', url: '/api/v1/ips/1.2.3.4%3Bdrop', headers: s.headers() })).statusCode).toBe(400);
  });

  it('detalhe do evento retorna estado de enriquecimento "pending" e risco não avaliado', async () => {
    await makeLink(t, s);
    await get('/campanha-a1', { 'user-agent': CHROME });
    const list = (await t.app.inject({ method: 'GET', url: '/api/v1/events', headers: s.headers() })).json();
    const ev = (await t.app.inject({ method: 'GET', url: `/api/v1/events/${list.items[0].id}`, headers: s.headers() })).json();
    expect(ev.enrichmentStatus).toBe('pending');
    expect(ev.risk).toEqual({ score: null, level: 'not_evaluated' });
  });
});

describe('endpoints internos', () => {
  it('/metrics e /readyz não são acessíveis via proxy público', async () => {
    const viaProxy = await t.app.inject({ method: 'GET', url: '/metrics', headers: { 'x-forwarded-for': '203.0.113.9' }, remoteAddress: '10.0.0.5' });
    expect(viaProxy.statusCode).toBe(404);
    const publicIp = await t.app.inject({ method: 'GET', url: '/readyz', remoteAddress: '8.8.8.8' });
    expect(publicIp.statusCode).toBe(404);
    const internal = await t.app.inject({ method: 'GET', url: '/readyz', remoteAddress: '10.0.0.5' });
    expect(internal.statusCode).toBe(200);
  });
});

describe('status das integrações', () => {
  it('cada fonte mantém seu próprio nome (regressão: o estado do job não pode sobrescrever source)', async () => {
    await t.ctx.pool.query("INSERT INTO job_state (key, value) VALUES ('tor_list', '{\"state\":\"ready\",\"count\":80,\"source\":\"https://check.torproject.org/exit-addresses\"}') ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value");
    const r = (await t.app.inject({ method: 'GET', url: '/api/v1/integrations/status', headers: s.headers() })).json();
    expect(r.providers.map((p: { source: string }) => p.source)).toEqual(['abuseipdb', 'greynoise', 'geolite2', 'tor', 'rdap']);
    expect(r.providers.find((p: { source: string }) => p.source === 'tor')).toMatchObject({ state: 'ready', count: 80 });
  });
});

describe('exportação (CA-17)', () => {
  it('exige reautenticação, cria exportação com TTL e audita', async () => {
    await makeLink(t, s);
    const sess = await t.login();
    const denied = await t.app.inject({ method: 'POST', url: '/api/v1/exports', headers: sess.headers(), payload: { format: 'csv' } });
    expect(denied.statusCode).toBe(403);
    expect(denied.json().error.code).toBe('reauth_required');

    const wrong = await t.app.inject({ method: 'POST', url: '/api/v1/auth/reauth', headers: sess.headers(), payload: { password: 'incorreta-1A!incorreta' } });
    expect(wrong.statusCode).toBe(401);
    const ok = await t.app.inject({ method: 'POST', url: '/api/v1/auth/reauth', headers: sess.headers(), payload: { password: ADMIN_PASSWORD } });
    expect(ok.statusCode).toBe(200);

    const created = await t.app.inject({ method: 'POST', url: '/api/v1/exports', headers: sess.headers(), payload: { format: 'csv', filters: { clientClass: 'bot' } } });
    expect(created.statusCode).toBe(202);
    const { id, expiresAt } = created.json();
    const ttl = Date.parse(expiresAt) - Date.now();
    expect(ttl).toBeGreaterThan(25 * 60_000);
    expect(ttl).toBeLessThanOrEqual(30 * 60_000 + 5_000);
    const audit = await t.ctx.pool.query("SELECT result FROM audit_events WHERE action = 'export.create' ORDER BY at");
    expect(audit.rows.map((r) => r.result)).toEqual(['denied', 'success']);
    const dl = await t.app.inject({ method: 'GET', url: `/api/v1/exports/${id}/download`, headers: sess.headers() });
    expect(dl.statusCode).toBe(409); // ainda não processada pelo worker
  });

  it('exportação de outro estado exige sessão', async () => {
    const r = await t.app.inject({ method: 'GET', url: '/api/v1/exports', headers: { host: DASH_HOST } });
    expect(r.statusCode).toBe(401);
  });
});
