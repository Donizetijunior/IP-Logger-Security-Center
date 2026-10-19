import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { challengeFor } from '../../apps/api/src/domains.ts';
import type { Hop, HopResult } from '../../apps/api/src/tools/safe-http.ts';
import { SafeHttpError } from '../../apps/api/src/tools/safe-http.ts';
import { DASH_HOST, SHORT_HOST, USER_PASSWORD, loginUser, makeLink, nextIp, signup, startTestApp, type Session, type TestApp } from './helpers.ts';

// "DNS" e "roteamento" controlados pelo teste
const txt = new Map<string, string[][]>();
const routing = { mode: 'ok' as 'ok' | 'wrong' | 'throw' | 'http404', token: '' };
const resolveTxt = async (name: string): Promise<string[][]> => {
  const r = txt.get(name);
  if (!r) throw Object.assign(new Error('ENODATA'), { code: 'ENODATA' });
  return r;
};
const hop: Hop = async (url) => {
  if (routing.mode === 'throw') throw new SafeHttpError('dns_error', 'Domínio não encontrado');
  const res = (status: number, body: unknown): HopResult => ({ status, headers: {}, body: Buffer.from(JSON.stringify(body)), ms: 1, tls: true });
  if (routing.mode === 'http404') return res(404, {});
  void url;
  return res(200, { ok: true, challenge: routing.mode === 'ok' ? challengeFor(routing.token) : 'errado' });
};

let t: TestApp;
let admin: Session;
let ana: Session;
let beto: Session;

const api = (s: Session, method: 'GET' | 'POST' | 'PATCH' | 'DELETE', url: string, payload?: unknown) =>
  t.app.inject({ method, url: `/api/v1${url}`, headers: s.headers(), payload: payload as object, remoteAddress: nextIp() });
const visit = (host: string, path: string, ip = nextIp()) =>
  t.app.inject({ method: 'GET', url: path, headers: { host, 'user-agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/124.0 Safari/537.36' }, remoteAddress: ip });

async function addDomain(s: Session, hostname: string, extra: Record<string, unknown> = {}) {
  const r = await api(s, 'POST', '/domains', { hostname, ...extra });
  return { res: r, body: r.json() as { id: string; hostname: string; status: string; dns: { txtName: string; txtValue: string } } };
}
const publishTxt = (d: { dns: { txtName: string; txtValue: string } }) => txt.set(d.dns.txtName, [[d.dns.txtValue]]);
const tokenOf = async (id: string) => (await t.ctx.pool.query('SELECT verification_token FROM custom_domains WHERE id = $1', [id])).rows[0].verification_token as string;

async function activate(s: Session, hostname: string) {
  const d = await addDomain(s, hostname);
  publishTxt(d.body);
  routing.mode = 'ok';
  routing.token = await tokenOf(d.body.id);
  const v = await api(s, 'POST', `/domains/${d.body.id}/verify`);
  return { id: d.body.id, verify: v.json(), status: v.json().domain?.status as string };
}

describe('domínios personalizados — modo approval', () => {
  beforeAll(async () => {
    t = await startTestApp({ SIGNUP_MODE: 'open', CUSTOM_DOMAINS_MODE: 'approval', CUSTOM_DOMAINS_MAX_PER_USER: '2' }, { resolveTxt, hop });
    admin = await t.login();
    await signup(t, 'ana@example.org');
    await signup(t, 'beto@example.org');
    ana = await loginUser(t, 'ana@example.org');
    beto = await loginUser(t, 'beto@example.org');
  });
  afterAll(async () => {
    await t.close();
  });

  it('valida o hostname e protege os domínios da própria plataforma', async () => {
    for (const bad of ['localhost', '10.0.0.1', '*.exemplo.org', 'intranet.local', 'a_b.com', 'x', SHORT_HOST, DASH_HOST, `www.${SHORT_HOST}`]) {
      const r = await addDomain(ana, bad);
      expect(r.res.statusCode, bad).toBe(400);
    }
    const norm = await addDomain(ana, 'https://Meu.Cliente.ORG/qualquer/coisa?x=1');
    expect(norm.res.statusCode).toBe(201);
    expect(norm.body.hostname).toBe('meu.cliente.org');
    expect(norm.body.status).toBe('pending_dns');
    expect((await addDomain(beto, 'MEU.cliente.org')).res.statusCode).toBe(409);
  });

  it('respeita o limite de domínios por usuário', async () => {
    expect((await addDomain(beto, 'um.beto.org')).res.statusCode).toBe(201);
    expect((await addDomain(beto, 'dois.beto.org')).res.statusCode).toBe(201);
    const over = await addDomain(beto, 'tres.beto.org');
    expect(over.res.statusCode).toBe(403);
    expect(over.res.json().error.code).toBe('quota_exceeded');
  });

  it('sem TXT não verifica; com TXT, usuário vai para aprovação e o admin ativa', async () => {
    txt.clear();
    const d = await addDomain(ana, 'go.ana.org');
    const fail = (await api(ana, 'POST', `/domains/${d.body.id}/verify`)).json();
    expect(fail.verified).toBe(false);
    expect(fail.message).toMatch(/TXT/);

    // TXT errado também não vale
    txt.set(d.body.dns.txtName, [['iplogger-verify=token-de-outro']]);
    expect((await api(ana, 'POST', `/domains/${d.body.id}/verify`)).json().verified).toBe(false);

    publishTxt(d.body);
    routing.mode = 'ok';
    routing.token = await tokenOf(d.body.id);
    const ok = (await api(ana, 'POST', `/domains/${d.body.id}/verify`)).json();
    expect(ok.verified).toBe(true);
    expect(ok.domain.status).toBe('pending_approval');
    expect(ok.domain.routingOk).toBe(true);

    // pendente de aprovação: ainda não serve redirecionamentos e não aceita links
    expect((await visit('go.ana.org', '/qualquer')).statusCode).toBe(421);
    const early = await makeLink(t, ana, { slug: 'cedo', domainId: d.body.id });
    expect(early.res.statusCode).toBe(400);
    expect(early.res.json().error.code).toBe('invalid_domain');

    // usuário comum não aprova
    expect((await api(ana, 'PATCH', `/domains/${d.body.id}`, { status: 'active' })).statusCode).toBe(403);
    const approved = await api(admin, 'PATCH', `/domains/${d.body.id}`, { status: 'active' });
    expect(approved.statusCode).toBe(200);
    expect(approved.json().status).toBe('active');
  });

  it('admin não consegue ativar domínio sem propriedade verificada', async () => {
    const d = await addDomain(beto, 'naoverificado.beto.org');
    expect(d.res.statusCode).toBe(403); // já no limite (2) — usa outro usuário
    const d2 = await addDomain(admin, 'naoverificado.exemplo.org');
    const r = await api(admin, 'PATCH', `/domains/${d2.body.id}`, { status: 'active' });
    expect(r.statusCode).toBe(409);
    expect(r.json().error.code).toBe('not_verified');
  });

  it('checagem de roteamento: sucesso, desafio errado, HTTP inesperado e falha de rede', async () => {
    const d = await addDomain(admin, 'rota.exemplo.org');
    publishTxt(d.body);
    routing.token = await tokenOf(d.body.id);
    for (const [mode, expectOk, pattern] of [
      ['ok', true, null], ['wrong', false, /não chegou/], ['http404', false, /HTTP 404/], ['throw', false, /Não foi possível acessar/],
    ] as const) {
      routing.mode = mode;
      const r = (await api(admin, 'POST', `/domains/${d.body.id}/verify`)).json();
      expect(r.domain.routingOk, mode).toBe(expectOk);
      if (pattern) expect(r.domain.lastCheckError, mode).toMatch(pattern);
    }
  });

  it('o endpoint de roteamento só devolve o hash do token, e só para domínios cadastrados', async () => {
    const d = await addDomain(admin, 'check.exemplo.org');
    const token = await tokenOf(d.body.id);
    const r = await visit('check.exemplo.org', '/.well-known/iplogger-check');
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({ ok: true, challenge: challengeFor(token) });
    expect(r.body).not.toContain(token);
    expect((await visit('desconhecido.exemplo.org', '/.well-known/iplogger-check')).statusCode).toBe(421);
    // domínio pendente responde SÓ a checagem de roteamento
    expect((await visit('check.exemplo.org', '/privacy')).statusCode).toBe(421);
    expect((await visit('check.exemplo.org', '/algum-slug')).statusCode).toBe(421);
  });

  it('o mesmo slug existe em domínios diferentes e cada link só responde no seu domínio', async () => {
    const a = await activate(admin, 'promo.exemplo.org');
    expect(a.status).toBe('active');
    const b = await activate(admin, 'oferta.exemplo.org');
    expect(b.status).toBe('active');

    const main = await makeLink(t, admin, { slug: 'black', targetUrl: 'https://example.org/principal' });
    const l1 = await makeLink(t, admin, { slug: 'black', targetUrl: 'https://example.org/promo', domainId: a.id });
    const l2 = await makeLink(t, admin, { slug: 'black', targetUrl: 'https://example.org/oferta', domainId: b.id });
    expect([main.res.statusCode, l1.res.statusCode, l2.res.statusCode]).toEqual([201, 201, 201]);
    expect((await makeLink(t, admin, { slug: 'black', domainId: a.id })).res.statusCode).toBe(409);
    expect((l1.res.json() as { publicUrl: string }).publicUrl).toBe('http://promo.exemplo.org/black');

    expect((await visit(SHORT_HOST, '/black')).headers.location).toBe('https://example.org/principal');
    expect((await visit('promo.exemplo.org', '/black')).headers.location).toBe('https://example.org/promo');
    expect((await visit('oferta.exemplo.org', '/black')).headers.location).toBe('https://example.org/oferta');
    expect((await visit('oferta.exemplo.org:8443', '/black')).headers.location).toBe('https://example.org/oferta');

    // link exclusivo de um domínio não vaza para os outros
    await makeLink(t, admin, { slug: 'so-promo', targetUrl: 'https://example.org/x', domainId: a.id });
    expect((await visit('promo.exemplo.org', '/so-promo')).statusCode).toBe(302);
    expect((await visit('oferta.exemplo.org', '/so-promo')).statusCode).toBe(404);
    expect((await visit(SHORT_HOST, '/so-promo')).statusCode).toBe(404);
  });

  it('eventos dos links em domínio personalizado são registrados com o IP real e isolados por dono', async () => {
    const a = await activate(admin, 'eventos.exemplo.org');
    const l = await makeLink(t, admin, { slug: 'ev1', targetUrl: 'https://example.org/e', domainId: a.id });
    expect(l.res.statusCode).toBe(201);
    expect((await visit('eventos.exemplo.org', '/ev1', '198.51.100.88')).statusCode).toBe(302);
    const ev = (await api(admin, 'GET', '/events?limit=1')).json().items[0];
    expect(ev).toMatchObject({ slug: 'ev1', ipAddress: '198.51.100.88' });
    expect((await api(ana, 'GET', '/events?limit=5')).json().items.some((e: { slug: string }) => e.slug === 'ev1')).toBe(false);
  });

  it('um usuário não usa o domínio de outro nem links em domínio inativo', async () => {
    const d = await addDomain(admin, 'alheio.exemplo.org');
    publishTxt(d.body);
    routing.mode = 'ok';
    routing.token = await tokenOf(d.body.id);
    await api(admin, 'POST', `/domains/${d.body.id}/verify`);
    expect((await makeLink(t, ana, { slug: 'invasor', domainId: d.body.id })).res.statusCode).toBe(400);
    // sem acesso ao registro de domínio alheio
    expect((await api(ana, 'POST', `/domains/${d.body.id}/verify`)).statusCode).toBe(404);
    expect((await api(ana, 'PATCH', `/domains/${d.body.id}`, { rootRedirectUrl: 'https://example.org' })).statusCode).toBe(404);
    expect((await api(ana, 'DELETE', `/domains/${d.body.id}`)).statusCode).toBe(404);
    // listagem: usuário vê só os seus
    const mine = (await api(ana, 'GET', '/domains')).json();
    expect(mine.items.every((x: { hostname: string }) => !x.hostname.endsWith('exemplo.org'))).toBe(true);
    expect(mine.policy).toMatchObject({ mode: 'approval', canCreate: true, max: 2 });
  });

  it('domínio desativado para de responder na hora (cache invalidado) e volta ao reativar', async () => {
    const d = await activate(admin, 'onoff.exemplo.org');
    await makeLink(t, admin, { slug: 'liga', targetUrl: 'https://example.org/l', domainId: d.id });
    expect((await visit('onoff.exemplo.org', '/liga')).statusCode).toBe(302);
    await api(admin, 'PATCH', `/domains/${d.id}`, { status: 'disabled' });
    expect((await visit('onoff.exemplo.org', '/liga')).statusCode).toBe(421);
    expect((await api(admin, 'POST', `/domains/${d.id}/verify`)).statusCode).toBe(409);
    await api(admin, 'PATCH', `/domains/${d.id}`, { status: 'active' });
    expect((await visit('onoff.exemplo.org', '/liga')).statusCode).toBe(302);
  });

  it('raiz do domínio: redireciona só se configurado e válido', async () => {
    const d = await activate(admin, 'raiz.exemplo.org');
    expect((await visit('raiz.exemplo.org', '/')).statusCode).toBe(404);
    expect((await api(admin, 'PATCH', `/domains/${d.id}`, { rootRedirectUrl: 'javascript:alert(1)' })).statusCode).toBe(400);
    expect((await api(admin, 'PATCH', `/domains/${d.id}`, { rootRedirectUrl: 'http://localhost/x' })).statusCode).toBe(400);
    expect((await api(admin, 'PATCH', `/domains/${d.id}`, { rootRedirectUrl: 'https://example.org/inicio' })).statusCode).toBe(200);
    const r = await visit('raiz.exemplo.org', '/');
    expect(r.statusCode).toBe(302);
    expect(r.headers.location).toBe('https://example.org/inicio');
    await api(admin, 'PATCH', `/domains/${d.id}`, { rootRedirectUrl: null });
    expect((await visit('raiz.exemplo.org', '/')).statusCode).toBe(404);
  });

  it('destino que aponta para um domínio personalizado do serviço é recusado (laço)', async () => {
    const r = await makeLink(t, ana, { slug: 'laco-dom', targetUrl: 'https://promo.exemplo.org/black' });
    expect(r.res.statusCode).toBe(400);
  });

  it('excluir o domínio exige remover os links antes e limpa o registro', async () => {
    const d = await activate(admin, 'apagar.exemplo.org');
    const l = await makeLink(t, admin, { slug: 'doomed', targetUrl: 'https://example.org/d', domainId: d.id });
    await visit('apagar.exemplo.org', '/doomed', '198.51.100.99');
    const blocked = await api(admin, 'DELETE', `/domains/${d.id}`);
    expect(blocked.statusCode).toBe(409);
    expect(blocked.json().error.code).toBe('domain_in_use');
    await api(admin, 'DELETE', `/links/${(l.res.json() as { id: string }).id}`);
    expect((await api(admin, 'DELETE', `/domains/${d.id}`)).statusCode).toBe(200);
    expect((await t.ctx.pool.query("SELECT 1 FROM short_links WHERE slug = 'doomed'")).rowCount).toBe(0);
    expect((await t.ctx.pool.query("SELECT 1 FROM access_events WHERE slug = 'doomed'")).rowCount).toBe(0);
    expect((await visit('apagar.exemplo.org', '/doomed')).statusCode).toBe(421);
  });

  it('denúncia com a URL completa encontra o link do domínio certo', async () => {
    const d = await activate(admin, 'denuncia.exemplo.org');
    const l = await makeLink(t, admin, { slug: 'golpe', targetUrl: 'https://example.org/g', domainId: d.id });
    await makeLink(t, admin, { slug: 'golpe', targetUrl: 'https://example.org/outro' }); // mesmo slug no domínio principal
    const rep = await t.app.inject({
      method: 'POST', url: '/api/v1/public/abuse-report', headers: { host: DASH_HOST }, remoteAddress: nextIp(),
      payload: { slug: 'http://denuncia.exemplo.org/golpe', reason: 'phishing_or_fraud' },
    });
    expect(rep.statusCode).toBe(201);
    const row = (await t.ctx.pool.query("SELECT slug, link_id FROM abuse_reports ORDER BY created_at DESC LIMIT 1")).rows[0];
    expect(row.link_id).toBe((l.res.json() as { id: string }).id);
    expect(row.slug).toBe('denuncia.exemplo.org/golpe');
  });

  it('suspender o dono desativa os domínios dele', async () => {
    const list = (await api(admin, 'GET', '/users')).json().items as Array<{ id: string; email: string }>;
    const anaId = list.find((u) => u.email === 'ana@example.org')!.id;
    expect((await t.ctx.pool.query("SELECT count(*)::int AS n FROM custom_domains WHERE owner_id = $1 AND status = 'active'", [anaId])).rows[0].n).toBe(1);
    await api(admin, 'PATCH', `/users/${anaId}`, { status: 'suspended' });
    expect((await t.ctx.pool.query("SELECT count(*)::int AS n FROM custom_domains WHERE owner_id = $1 AND status = 'active'", [anaId])).rows[0].n).toBe(0);
    expect((await visit('go.ana.org', '/qualquer')).statusCode).toBe(421);
    void USER_PASSWORD;
  });
});

describe('domínios personalizados — domínios da própria plataforma', () => {
  it('ninguém usa os hosts da plataforma; só o admin usa subdomínios deles', async () => {
    const o = await startTestApp(
      { SIGNUP_MODE: 'open', CUSTOM_DOMAINS_MODE: 'open', PUBLIC_SHORT_BASE_URL: 'http://iplogger.com.br', PUBLIC_DASHBOARD_URL: 'http://painel.iplogger.com.br' },
      { resolveTxt, hop },
    );
    try {
      const a = await o.login();
      await signup(o, 'user@example.org');
      const u = await loginUser(o, 'user@example.org');
      const add = (s: Session, hostname: string) =>
        o.app.inject({ method: 'POST', url: '/api/v1/domains', headers: s.headers(), payload: { hostname }, remoteAddress: nextIp() });
      for (const h of ['iplogger.com.br', 'painel.iplogger.com.br']) {
        expect((await add(u, h)).statusCode, `usuário ${h}`).toBe(400);
        expect((await add(a, h)).statusCode, `admin ${h}`).toBe(400);
      }
      for (const h of ['go.iplogger.com.br', 'evil.painel.iplogger.com.br']) {
        expect((await add(u, h)).statusCode, `usuário ${h}`).toBe(400);
      }
      expect((await add(a, 'go.iplogger.com.br')).statusCode).toBe(201);
      expect((await add(u, 'meuiplogger.com.br')).statusCode).toBe(201); // sufixo parecido, mas outro domínio
    } finally {
      await o.close();
    }
  });
});

describe('domínios personalizados — modos admin e open', () => {
  it('modo admin: usuários comuns não cadastram domínios; admin sim', async () => {
    const o = await startTestApp({ SIGNUP_MODE: 'open', CUSTOM_DOMAINS_MODE: 'admin' }, { resolveTxt, hop });
    try {
      const a = await o.login();
      await signup(o, 'user@example.org');
      const u = await loginUser(o, 'user@example.org');
      const denied = await o.app.inject({ method: 'POST', url: '/api/v1/domains', headers: u.headers(), payload: { hostname: 'x.exemplo.org' }, remoteAddress: nextIp() });
      expect(denied.statusCode).toBe(403);
      expect(denied.json().error.code).toBe('domains_admin_only');
      const list = (await o.app.inject({ method: 'GET', url: '/api/v1/domains', headers: u.headers(), remoteAddress: nextIp() })).json();
      expect(list.policy.canCreate).toBe(false);
      const ok = await o.app.inject({ method: 'POST', url: '/api/v1/domains', headers: a.headers(), payload: { hostname: 'x.exemplo.org' }, remoteAddress: nextIp() });
      expect(ok.statusCode).toBe(201);
    } finally {
      await o.close();
    }
  });

  it('modo open: usuário verificado ativa sozinho, sem aprovação', async () => {
    const o = await startTestApp({ SIGNUP_MODE: 'open', CUSTOM_DOMAINS_MODE: 'open' }, { resolveTxt, hop });
    try {
      await o.login();
      await signup(o, 'user@example.org');
      const u = await loginUser(o, 'user@example.org');
      const c = await o.app.inject({ method: 'POST', url: '/api/v1/domains', headers: u.headers(), payload: { hostname: 'livre.exemplo.org' }, remoteAddress: nextIp() });
      const d = c.json() as { id: string; dns: { txtName: string; txtValue: string } };
      txt.set(d.dns.txtName, [[d.dns.txtValue]]);
      routing.mode = 'ok';
      routing.token = (await o.ctx.pool.query('SELECT verification_token FROM custom_domains WHERE id = $1', [d.id])).rows[0].verification_token;
      const v = (await o.app.inject({ method: 'POST', url: `/api/v1/domains/${d.id}/verify`, headers: u.headers(), remoteAddress: nextIp() })).json();
      expect(v.domain.status).toBe('active');
    } finally {
      await o.close();
    }
  });
});
