import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { generateExport } from '../../apps/worker/src/exports.ts';
import {
  ADMIN_EMAIL, DASH_HOST, SHORT_HOST, USER_PASSWORD, loginUser, makeLink, nextIp, signup, startTestApp, visit, type Session, type TestApp,
} from './helpers.ts';

let t: TestApp;
let admin: Session;
let alice: Session;
let bob: Session;
const ALICE = 'alice@example.org';
const BOB = 'bob@example.org';

async function openApp(env: Record<string, string> = {}) {
  const app = await startTestApp({ SIGNUP_MODE: 'open', DEFAULT_LINK_QUOTA: '5', ...env });
  const a = await app.login();
  return { app, a };
}

beforeAll(async () => {
  const o = await openApp();
  t = o.app;
  admin = o.a;
  expect((await signup(t, ALICE)).statusCode).toBe(201);
  expect((await signup(t, BOB)).statusCode).toBe(201);
  alice = await loginUser(t, ALICE);
  bob = await loginUser(t, BOB);
});
afterAll(async () => {
  await t.close();
});
beforeEach(async () => {
  await t.ctx.pool.query('TRUNCATE short_links, access_events, outbox_events, alerts, exports, abuse_reports CASCADE');
  t.ctx.linkCache.clear();
});

const get = (s: Session, url: string) => t.app.inject({ method: 'GET', url: `/api/v1${url}`, headers: s.headers() });
const send = (s: Session, method: 'POST' | 'PATCH' | 'DELETE', url: string, payload?: unknown) =>
  t.app.inject({ method, url: `/api/v1${url}`, headers: s.headers(), payload: payload as object });

describe('cadastro público', () => {
  it('modo open: cria conta ativa; e-mail duplicado (sem diferenciar maiúsculas) = 409', async () => {
    const r = await signup(t, 'carol@example.org');
    expect(r.statusCode).toBe(201);
    expect(r.json().status).toBe('active');
    expect((await signup(t, 'CAROL@example.org')).statusCode).toBe(409);
  });

  it('exige aceite dos termos e senha forte', async () => {
    expect((await signup(t, 'x1@example.org', USER_PASSWORD, false)).statusCode).toBe(400);
    expect((await signup(t, 'x2@example.org', USER_PASSWORD, 'sim')).statusCode).toBe(400);
    const weak = await signup(t, 'x3@example.org', 'senhafraca');
    expect(weak.statusCode).toBe(400);
    expect(weak.json().error.code).toBe('weak_password');
  });

  it('o papel nunca vem do cliente: campos extras não escalam privilégio', async () => {
    const r = await t.app.inject({
      method: 'POST', url: '/api/v1/auth/signup', headers: { host: DASH_HOST }, remoteAddress: nextIp(),
      payload: { email: 'hacker@example.org', password: USER_PASSWORD, acceptTerms: true, role: 'admin', status: 'active', linkQuota: 99999 },
    });
    expect(r.statusCode).toBe(201);
    const { rows } = await t.ctx.pool.query("SELECT role, link_quota FROM accounts WHERE email = 'hacker@example.org'");
    expect(rows[0]).toMatchObject({ role: 'user', link_quota: 5 });
  });

  it('limita cadastros por IP', async () => {
    const statuses: number[] = [];
    for (let i = 0; i < 8; i++) {
      const r = await t.app.inject({
        method: 'POST', url: '/api/v1/auth/signup', headers: { host: DASH_HOST }, remoteAddress: '203.0.113.150',
        payload: { email: `spam${i}@example.org`, password: USER_PASSWORD, acceptTerms: true },
      });
      statuses.push(r.statusCode);
    }
    expect(statuses.slice(0, 5).every((s) => s === 201)).toBe(true);
    expect(statuses).toContain(429);
  });

  it('modo approval: conta fica pendente, login só informa o estado com a senha correta; admin aprova', async () => {
    const o = await openApp({ SIGNUP_MODE: 'approval' });
    try {
      const r = await signup(o.app, 'pend@example.org');
      expect(r.json().status).toBe('pending');
      const wrong = await o.app.app.inject({ method: 'POST', url: '/api/v1/auth/login', headers: { host: DASH_HOST }, remoteAddress: nextIp(), payload: { email: 'pend@example.org', password: 'Errada-Errada-#1x' } });
      expect(wrong.statusCode).toBe(401);
      const right = await o.app.app.inject({ method: 'POST', url: '/api/v1/auth/login', headers: { host: DASH_HOST }, remoteAddress: nextIp(), payload: { email: 'pend@example.org', password: USER_PASSWORD } });
      expect(right.statusCode).toBe(403);
      expect(right.json().error.code).toBe('account_pending');
      const list = (await o.app.app.inject({ method: 'GET', url: '/api/v1/users?status=pending', headers: o.a.headers() })).json();
      expect(list.items).toHaveLength(1);
      await o.app.app.inject({ method: 'PATCH', url: `/api/v1/users/${list.items[0].id}`, headers: o.a.headers(), payload: { status: 'active' } });
      await loginUser(o.app, 'pend@example.org');
    } finally {
      await o.app.close();
    }
    // restaura o banco para o restante da suíte
    t = (await openApp()).app;
    admin = await t.login();
    await signup(t, ALICE);
    await signup(t, BOB);
    alice = await loginUser(t, ALICE);
    bob = await loginUser(t, BOB);
  });

  it('modo closed: cadastro público recusado', async () => {
    const o = await openApp({ SIGNUP_MODE: 'closed' });
    try {
      expect((await signup(o.app, 'nope@example.org')).statusCode).toBe(403);
      const cfg = (await o.app.app.inject({ method: 'GET', url: '/api/v1/public/config', headers: { host: DASH_HOST } })).json();
      expect(cfg.signupMode).toBe('closed');
    } finally {
      await o.app.close();
    }
    t = (await openApp()).app;
    admin = await t.login();
    await signup(t, ALICE);
    await signup(t, BOB);
    alice = await loginUser(t, ALICE);
    bob = await loginUser(t, BOB);
  });
});

describe('isolamento entre usuários', () => {
  it('cada usuário vê, edita e remove apenas os próprios links; o admin vê todos', async () => {
    const a = await makeLink(t, alice, { slug: 'link-da-alice' });
    const b = await makeLink(t, bob, { slug: 'link-do-bob' });
    const adm = await makeLink(t, admin, { slug: 'link-do-admin' });
    expect([a.res.statusCode, b.res.statusCode, adm.res.statusCode]).toEqual([201, 201, 201]);

    const mine = (await get(alice, '/links')).json().items.map((l: { slug: string }) => l.slug);
    expect(mine).toEqual(['link-da-alice']);
    const all = (await get(admin, '/links')).json().items;
    expect(all.map((l: { slug: string }) => l.slug).sort()).toEqual(['link-da-alice', 'link-do-admin', 'link-do-bob']);
    expect(all.find((l: { slug: string }) => l.slug === 'link-da-alice').owner.email).toBe(ALICE);

    expect((await get(alice, `/links/${b.body.id}`)).statusCode).toBe(404);
    expect((await send(alice, 'PATCH', `/links/${b.body.id}`, { label: 'invadido' })).statusCode).toBe(404);
    expect((await send(alice, 'DELETE', `/links/${b.body.id}`)).statusCode).toBe(404);
    expect((await visit(t, 'link-do-bob', nextIp())).statusCode).toBe(302);
  });

  it('eventos, detalhe, perfil de IP, painel e alertas ficam restritos aos links do dono', async () => {
    const a = await makeLink(t, alice, { slug: 'alice-link' });
    const b = await makeLink(t, bob, { slug: 'bob-link' });
    await visit(t, 'alice-link', '198.51.100.201');
    await visit(t, 'alice-link', '198.51.100.201');
    await visit(t, 'bob-link', '198.51.100.202');

    const aEvents = (await get(alice, '/events')).json().items;
    expect(aEvents).toHaveLength(2);
    expect(aEvents.every((e: { slug: string }) => e.slug === 'alice-link')).toBe(true);
    const bEvents = (await get(bob, '/events')).json().items;
    expect(bEvents).toHaveLength(1);
    expect((await get(admin, '/events')).json().items).toHaveLength(3);

    // detalhe de evento alheio
    expect((await get(alice, `/events/${bEvents[0].id}`)).statusCode).toBe(404);
    expect((await get(bob, `/events/${bEvents[0].id}`)).statusCode).toBe(200);
    // filtro por link alheio não vaza nada
    expect((await get(alice, `/events?linkId=${b.body.id}`)).json().items).toHaveLength(0);
    // perfil de IP: só IPs que acessaram os próprios links
    expect((await get(alice, '/ips/198.51.100.202')).statusCode).toBe(404);
    const own = (await get(alice, '/ips/198.51.100.201')).json();
    expect(own.summary.totalEvents).toBe(2);
    expect(own.links.map((l: { slug: string }) => l.slug)).toEqual(['alice-link']);

    // painel
    const sa = (await get(alice, '/dashboard/summary?period=24h')).json();
    expect(sa.requestsTotal).toBe(2);
    expect(sa.uniqueIps).toBe(1);
    expect(sa.activeLinks).toBe(1);
    expect(sa.workerHeartbeatAt).toBeNull();
    expect((await get(admin, '/dashboard/summary?period=24h')).json().requestsTotal).toBe(3);
    const ts = (await get(alice, '/dashboard/timeseries?period=24h')).json().points.reduce((n: number, p: { total: number }) => n + p.total, 0);
    expect(ts).toBe(2);

    // alertas
    await t.ctx.pool.query(
      `INSERT INTO alerts (type, severity, title, ip_address, short_link_id, dedupe_key) VALUES
       ('ip_high_risk', 'high', 'da alice', '198.51.100.201', $1, 'k-a'), ('ip_high_risk', 'high', 'do bob', '198.51.100.202', $2, 'k-b'),
       ('worker_down', 'critical', 'sistema', NULL, NULL, 'k-sys')`,
      [a.body.id, b.body.id],
    );
    const alRes = await get(alice, '/alerts');
    expect(alRes.statusCode, alRes.body).toBe(200);
    const al = alRes.json().items;
    expect(al.map((x: { title: string }) => x.title)).toEqual(['da alice']);
    expect((await get(admin, '/alerts')).json().items).toHaveLength(3);
    const bobAlert = (await get(bob, '/alerts')).json().items[0];
    expect((await send(alice, 'PATCH', `/alerts/${bobAlert.id}`, { status: 'resolved' })).statusCode).toBe(404);
    expect((await send(bob, 'PATCH', `/alerts/${bobAlert.id}`, { status: 'resolved' })).statusCode).toBe(200);
  });

  it('rotas administrativas retornam 403 para usuários comuns', async () => {
    for (const url of ['/settings', '/integrations/status', '/audit', '/users', '/reports']) {
      expect((await get(alice, url)).statusCode, url).toBe(403);
    }
    expect((await send(alice, 'POST', '/users', { email: 'x@example.org' })).statusCode).toBe(403);
    expect((await send(alice, 'PATCH', '/reports/00000000-0000-4000-8000-000000000000', { status: 'dismissed' })).statusCode).toBe(403);
    expect((await get(admin, '/settings')).statusCode).toBe(200);
  });

  it('exportação do usuário contém somente eventos dos seus links', async () => {
    await makeLink(t, alice, { slug: 'alice-exp' });
    await makeLink(t, bob, { slug: 'bob-exp' });
    await visit(t, 'alice-exp', '198.51.100.211');
    await visit(t, 'bob-exp', '198.51.100.212');
    await send(alice, 'POST', '/auth/reauth', { password: USER_PASSWORD });
    const ex = await send(alice, 'POST', '/exports', { format: 'csv', filters: {}, fullIp: true });
    expect(ex.statusCode).toBe(202);
    await generateExport(t.ctx.pool, ex.json().id);
    const dl = await t.app.inject({ method: 'GET', url: `/api/v1/exports/${ex.json().id}/download`, headers: alice.headers() });
    expect(dl.body).toContain('198.51.100.211');
    expect(dl.body).not.toContain('198.51.100.212');
    // outro usuário não baixa a exportação alheia
    expect((await t.app.inject({ method: 'GET', url: `/api/v1/exports/${ex.json().id}/download`, headers: bob.headers() })).statusCode).toBe(404);
  });
});

describe('cotas e regras de links', () => {
  it('respeita a cota de links por conta (DEFAULT_LINK_QUOTA=5)', async () => {
    for (let i = 0; i < 5; i++) expect((await makeLink(t, bob, { slug: `bob-cota-${i}` })).res.statusCode).toBe(201);
    const over = await makeLink(t, bob, { slug: 'bob-cota-6' });
    expect(over.res.statusCode).toBe(403);
    expect(over.res.json().error.code).toBe('quota_exceeded');
    // remover libera cota; admin pode ampliar
    const first = (await get(bob, '/links')).json().items[0];
    await send(bob, 'DELETE', `/links/${first.id}`);
    expect((await makeLink(t, bob, { slug: 'bob-cota-7' })).res.statusCode).toBe(201);
  });

  it('destino não pode apontar para os próprios domínios do serviço (laço de redirect)', async () => {
    expect((await makeLink(t, alice, { slug: 'laco-1', targetUrl: `http://${SHORT_HOST}/abc` })).res.statusCode).toBe(400);
    expect((await makeLink(t, alice, { slug: 'laco-2', targetUrl: `http://${DASH_HOST}/` })).res.statusCode).toBe(400);
  });

  it('raiz do domínio de links leva à plataforma', async () => {
    const r = await t.app.inject({ method: 'GET', url: '/', headers: { host: SHORT_HOST }, remoteAddress: nextIp() });
    expect(r.statusCode).toBe(302);
    expect(r.headers.location).toBe(`http://${DASH_HOST}`);
  });
});

describe('gestão de usuários (admin)', () => {
  it('cria usuário com senha temporária (exibida uma vez); troca obrigatória e aceite de termos antes de usar', async () => {
    const c = await send(admin, 'POST', '/users', { email: 'dave@example.org', linkQuota: 3 });
    expect(c.statusCode).toBe(201);
    const temp = c.json().temporaryPassword as string;
    expect(temp).toBeTruthy();
    const dave = await loginUser(t, 'dave@example.org', temp);
    const me = (await get(dave, '/auth/me')).json();
    expect(me).toMatchObject({ role: 'user', mustChangePassword: true, linkQuota: 3 });
    // bloqueado até trocar
    const blocked = await get(dave, '/links');
    expect(blocked.statusCode).toBe(403);
    expect(blocked.json().error.code).toBe('password_change_required');
    // exige termos e senha forte
    expect((await send(dave, 'POST', '/auth/change-password', { currentPassword: temp, newPassword: 'NovaSenha-Forte-#77a' })).json().error.code).toBe('terms_required');
    expect((await send(dave, 'POST', '/auth/change-password', { currentPassword: temp, newPassword: 'fraca', acceptTerms: true })).json().error.code).toBe('weak_password');
    expect((await send(dave, 'POST', '/auth/change-password', { currentPassword: 'errada-1A-#zzzzzz', newPassword: 'NovaSenha-Forte-#77a', acceptTerms: true })).statusCode).toBe(401);
    expect((await send(dave, 'POST', '/auth/change-password', { currentPassword: temp, newPassword: 'NovaSenha-Forte-#77a', acceptTerms: true })).statusCode).toBe(200);
    expect((await get(dave, '/links')).statusCode).toBe(200);
    // a senha temporária deixa de funcionar
    const old = await t.app.inject({ method: 'POST', url: '/api/v1/auth/login', headers: { host: DASH_HOST }, remoteAddress: nextIp(), payload: { email: 'dave@example.org', password: temp } });
    expect(old.statusCode).toBe(401);
    await loginUser(t, 'dave@example.org', 'NovaSenha-Forte-#77a');
  });

  it('reset de senha revoga sessões e força nova troca', async () => {
    const list = (await get(admin, '/users')).json().items;
    const al = list.find((u: { email: string }) => u.email === ALICE);
    const r = await send(admin, 'POST', `/users/${al.id}/reset-password`);
    expect(r.statusCode).toBe(200);
    expect((await get(alice, '/links')).statusCode).toBe(401);
    const again = await loginUser(t, ALICE, r.json().temporaryPassword);
    expect((await get(again, '/auth/me')).json().mustChangePassword).toBe(true);
    // volta ao estado original para os próximos testes
    await send(again, 'POST', '/auth/change-password', { currentPassword: r.json().temporaryPassword, newPassword: USER_PASSWORD, acceptTerms: true });
    alice = await loginUser(t, ALICE);
  });

  it('suspender revoga sessões, desativa links e impede login; reativar a conta não reativa links moderados', async () => {
    const a = await makeLink(t, alice, { slug: 'alice-susp' });
    expect((await visit(t, 'alice-susp', nextIp())).statusCode).toBe(302);
    const al = (await get(admin, '/users')).json().items.find((u: { email: string }) => u.email === ALICE);
    expect((await send(admin, 'PATCH', `/users/${al.id}`, { status: 'suspended' })).statusCode).toBe(200);

    expect((await get(alice, '/links')).statusCode).toBe(401);
    const login = await t.app.inject({ method: 'POST', url: '/api/v1/auth/login', headers: { host: DASH_HOST }, remoteAddress: nextIp(), payload: { email: ALICE, password: USER_PASSWORD } });
    expect(login.statusCode).toBe(403);
    expect(login.json().error.code).toBe('account_suspended');
    expect((await visit(t, 'alice-susp', nextIp())).statusCode).toBe(404);

    await send(admin, 'PATCH', `/users/${al.id}`, { status: 'active' });
    alice = await loginUser(t, ALICE);
    const re = await send(alice, 'PATCH', `/links/${a.body.id}`, { isActive: true });
    expect(re.statusCode).toBe(403);
    expect(re.json().error.code).toBe('disabled_by_moderation');
    expect((await send(admin, 'PATCH', `/links/${a.body.id}`, { isActive: true })).statusCode).toBe(200);
    expect((await visit(t, 'alice-susp', nextIp())).statusCode).toBe(302);
  });

  it('a conta administradora é protegida e a exclusão apaga links, eventos e alertas do usuário', async () => {
    const users = (await get(admin, '/users')).json().items;
    const adm = users.find((u: { role: string }) => u.role === 'admin');
    expect((await send(admin, 'PATCH', `/users/${adm.id}`, { status: 'suspended' })).statusCode).toBe(400);
    expect((await send(admin, 'DELETE', `/users/${adm.id}`)).statusCode).toBe(400);

    const c = await send(admin, 'POST', '/users', { email: 'erin@example.org', password: 'Erin-Forte-#2026-zz' });
    const erinId = c.json().id;
    expect(c.json().temporaryPassword).toBeUndefined();
    const erin = await loginUser(t, 'erin@example.org', 'Erin-Forte-#2026-zz');
    await send(erin, 'POST', '/auth/change-password', { currentPassword: 'Erin-Forte-#2026-zz', newPassword: 'Erin-Forte-#2026-yy', acceptTerms: true });
    const e = await makeLink(t, erin, { slug: 'erin-link' });
    await visit(t, 'erin-link', '198.51.100.230');
    await t.ctx.pool.query("INSERT INTO alerts (type, severity, title, short_link_id, dedupe_key) VALUES ('x', 'low', 't', $1, 'k-e')", [e.body.id]);
    await makeLink(t, bob, { slug: 'bob-fica' });
    await visit(t, 'bob-fica', '198.51.100.231');

    expect((await send(admin, 'DELETE', `/users/${erinId}`)).statusCode).toBe(200);
    const left = await t.ctx.pool.query('SELECT slug FROM access_events');
    expect(left.rows.map((r) => r.slug)).toEqual(['bob-fica']);
    expect((await t.ctx.pool.query("SELECT 1 FROM short_links WHERE slug = 'erin-link'")).rowCount).toBe(0);
    expect((await t.ctx.pool.query("SELECT 1 FROM alerts WHERE dedupe_key = 'k-e'")).rowCount).toBe(0);
    expect((await visit(t, 'erin-link', nextIp())).statusCode).toBe(404);
    expect((await get(erin, '/links')).statusCode).toBe(401);
    const audit = (await get(admin, '/audit?action=user.delete')).json().items;
    expect(audit).toHaveLength(1);
    expect(JSON.stringify(audit)).not.toContain('erin@');
  });
});

describe('exclusão da própria conta (direito de apagamento)', () => {
  it('usuário apaga conta, links, eventos e alertas com a senha; admin não pode se autoexcluir', async () => {
    expect((await signup(t, 'gina@example.org')).statusCode).toBe(201);
    const gina = await loginUser(t, 'gina@example.org');
    await makeLink(t, gina, { slug: 'gina-link' });
    await visit(t, 'gina-link', '198.51.100.240');
    const wrong = await send(gina, 'POST', '/auth/delete-account', { password: 'Errada-Errada-#1x' });
    expect(wrong.statusCode).toBe(401);
    expect((await send(gina, 'POST', '/auth/delete-account', { password: USER_PASSWORD })).statusCode).toBe(200);
    expect((await t.ctx.pool.query("SELECT 1 FROM accounts WHERE email = 'gina@example.org'")).rowCount).toBe(0);
    expect((await t.ctx.pool.query("SELECT 1 FROM access_events WHERE slug = 'gina-link'")).rowCount).toBe(0);
    expect((await visit(t, 'gina-link', nextIp())).statusCode).toBe(404);
    expect((await get(gina, '/links')).statusCode).toBe(401);
    expect((await send(admin, 'POST', '/auth/delete-account', { password: 'Senha-Forte-#2026-xyz' })).statusCode).toBe(400);
  });
});

describe('denúncias de abuso', () => {
  it('qualquer pessoa denuncia sem login; admin analisa, desativa o link e suspende o dono', async () => {
    const a = await makeLink(t, alice, { slug: 'link-suspeito' });
    const pub = await t.app.inject({
      method: 'POST', url: '/api/v1/public/abuse-report', headers: { host: DASH_HOST }, remoteAddress: nextIp(),
      payload: { slug: `http://${SHORT_HOST}/link-suspeito`, reason: 'tracking_without_consent', details: 'Recebi este link sem aviso', contact: 'vitima@example.org' },
    });
    expect(pub.statusCode).toBe(201);
    const bad = await t.app.inject({ method: 'POST', url: '/api/v1/public/abuse-report', headers: { host: DASH_HOST }, remoteAddress: nextIp(), payload: { slug: '../x', reason: 'other' } });
    expect(bad.statusCode).toBe(400);
    const badReason = await t.app.inject({ method: 'POST', url: '/api/v1/public/abuse-report', headers: { host: DASH_HOST }, remoteAddress: nextIp(), payload: { slug: 'link-suspeito', reason: 'xxx' } });
    expect(badReason.statusCode).toBe(400);

    const rep = (await get(admin, '/reports?status=open')).json().items;
    expect(rep).toHaveLength(1);
    expect(rep[0]).toMatchObject({ slug: 'link-suspeito', reason: 'tracking_without_consent', owner: { email: ALICE } });

    expect((await send(admin, 'PATCH', `/reports/${rep[0].id}`, { status: 'link_disabled', suspendOwner: true })).statusCode).toBe(200);
    expect((await visit(t, 'link-suspeito', nextIp())).statusCode).toBe(404);
    expect((await get(alice, '/links')).statusCode).toBe(401);
    const st = await t.ctx.pool.query('SELECT status FROM accounts WHERE email = $1', [ALICE]);
    expect(st.rows[0].status).toBe('suspended');
    expect(a.res.statusCode).toBe(201);

    // restaura a alice
    const al = (await get(admin, '/users')).json().items.find((u: { email: string }) => u.email === ALICE);
    await send(admin, 'PATCH', `/users/${al.id}`, { status: 'active' });
    alice = await loginUser(t, ALICE);
  });

  it('limita denúncias por IP e não registra o IP do denunciante', async () => {
    const statuses: number[] = [];
    for (let i = 0; i < 13; i++) {
      const r = await t.app.inject({ method: 'POST', url: '/api/v1/public/abuse-report', headers: { host: DASH_HOST }, remoteAddress: '203.0.113.151', payload: { slug: 'qualquer-coisa', reason: 'other' } });
      statuses.push(r.statusCode);
    }
    expect(statuses).toContain(429);
    const cols = (await t.ctx.pool.query("SELECT column_name FROM information_schema.columns WHERE table_name = 'abuse_reports'")).rows.map((r) => r.column_name);
    expect(cols.some((c: string) => /ip/i.test(c))).toBe(false);
  });
});

describe('segurança do login sem MFA', () => {
  it('conta de usuário não aceita o fluxo de MFA e erros não revelam se o e-mail existe', async () => {
    const wrongUser = await t.app.inject({ method: 'POST', url: '/api/v1/auth/login', headers: { host: DASH_HOST }, remoteAddress: nextIp(), payload: { email: 'naoexiste@example.org', password: USER_PASSWORD } });
    const wrongPw = await t.app.inject({ method: 'POST', url: '/api/v1/auth/login', headers: { host: DASH_HOST }, remoteAddress: nextIp(), payload: { email: ALICE, password: 'Senha-Errada-#99zz' } });
    expect(wrongUser.statusCode).toBe(401);
    expect(wrongPw.statusCode).toBe(401);
    expect(wrongUser.json()).toEqual(wrongPw.json());
    // o admin continua exigindo MFA
    const adm = await t.app.inject({ method: 'POST', url: '/api/v1/auth/login', headers: { host: DASH_HOST }, remoteAddress: nextIp(), payload: { email: ADMIN_EMAIL, password: 'Senha-Forte-#2026-xyz' } });
    expect(adm.json().mfaRequired).toBe(true);
    expect(adm.cookies).toHaveLength(0);
  });

  it('bloqueia a conta de usuário após falhas repetidas', async () => {
    const o = await openApp();
    try {
      await signup(o.app, 'frank@example.org');
      for (let i = 0; i < 5; i++) {
        await o.app.app.inject({ method: 'POST', url: '/api/v1/auth/login', headers: { host: DASH_HOST }, remoteAddress: nextIp(), payload: { email: 'frank@example.org', password: 'Errada-Errada-#1x' } });
      }
      const r = await o.app.app.inject({ method: 'POST', url: '/api/v1/auth/login', headers: { host: DASH_HOST }, remoteAddress: nextIp(), payload: { email: 'frank@example.org', password: USER_PASSWORD } });
      expect(r.statusCode).toBe(429);
    } finally {
      await o.app.close();
    }
    t = (await openApp()).app;
    admin = await t.login();
    await signup(t, ALICE);
    await signup(t, BOB);
    alice = await loginUser(t, ALICE);
    bob = await loginUser(t, BOB);
  });
});
