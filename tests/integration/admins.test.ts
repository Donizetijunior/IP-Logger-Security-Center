import { authenticator } from 'otplib';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bootstrapAdmin } from '../../apps/api/src/auth.ts';
import { ADMIN_PASSWORD, USER_PASSWORD, loginUser, makeLink, nextIp, signup, startTestApp, type Session, type TestApp } from './helpers.ts';

let t: TestApp;
let admin1: Session;
let user: Session;

interface NewAdmin {
  id: string; email: string; temporaryPassword: string; totpSecret: string; otpauthUri: string; qrSvg: string; recoveryCodes: string[];
}

const api = (s: Session, method: 'GET' | 'POST' | 'PATCH' | 'DELETE', url: string, payload?: unknown) =>
  t.app.inject({ method, url: `/api/v1${url}`, headers: s.headers(), payload: payload as object, remoteAddress: nextIp() });
const host = () => t.ctx.config.dashboardHost;

async function createAdmin(s: Session, email: string, extra: Record<string, unknown> = {}) {
  await api(s, 'POST', '/auth/reauth', { password: ADMIN_PASSWORD });
  const r = await api(s, 'POST', '/users/admins', { email, ...extra });
  return { res: r, body: r.json() as NewAdmin };
}

/** Login completo de um admin (senha + MFA por TOTP ou código de recuperação). */
async function loginAdmin(email: string, password: string, code: string): Promise<Session | { status: number; body: unknown }> {
  const l1 = await t.app.inject({ method: 'POST', url: '/api/v1/auth/login', headers: { host: host() }, remoteAddress: nextIp(), payload: { email, password } });
  if (l1.statusCode !== 200) return { status: l1.statusCode, body: l1.json() };
  const l2 = await t.app.inject({
    method: 'POST', url: '/api/v1/auth/totp/verify', headers: { host: host() }, remoteAddress: nextIp(), payload: { challenge: l1.json().challenge, code },
  });
  if (l2.statusCode !== 200) return { status: l2.statusCode, body: l2.json() };
  const c = l2.cookies[0]!;
  const cookie = `${c.name}=${c.value}`;
  const csrf = l2.json().csrfToken as string;
  return { cookie, csrf, headers: (extra = {}) => ({ host: host(), cookie, 'x-csrf-token': csrf, ...extra }) };
}
const isSession = (v: unknown): v is Session => !!v && typeof (v as Session).headers === 'function';

beforeAll(async () => {
  t = await startTestApp({ SIGNUP_MODE: 'open' });
  admin1 = await t.login();
  await signup(t, 'user@example.org');
  user = await loginUser(t, 'user@example.org');
});
afterAll(async () => {
  await t.close();
});

describe('criação de administradores', () => {
  it('usuário comum não cria administrador; admin sem reautenticação recente também não', async () => {
    expect((await api(user, 'POST', '/users/admins', { email: 'x@example.org' })).statusCode).toBe(403);
    const denied = await api(admin1, 'POST', '/users/admins', { email: 'laercio@example.org' });
    expect(denied.statusCode).toBe(403);
    expect(denied.json().error.code).toBe('reauth_required');
    const audit = await t.ctx.pool.query("SELECT result FROM audit_events WHERE action = 'admin.create' ORDER BY at");
    expect(audit.rows.map((r) => r.result)).toContain('denied');
    expect((await t.ctx.pool.query("SELECT count(*)::int AS n FROM accounts WHERE role = 'admin'")).rows[0].n).toBe(1);
  });

  it('com reautenticação: cria admin com segredo TOTP, QR, 10 códigos de recuperação e senha temporária (exibidos uma vez)', async () => {
    const { res, body } = await createAdmin(admin1, 'laercio@example.org');
    expect(res.statusCode).toBe(201);
    expect(body.temporaryPassword).toMatch(/^Tmp-/);
    expect(body.totpSecret).toMatch(/^[A-Z2-7]{20,}$/);
    expect(body.otpauthUri).toContain('otpauth://totp/');
    expect(body.qrSvg.startsWith('<svg')).toBe(true);
    expect(body.recoveryCodes).toHaveLength(10);

    // nada sensível fica legível no banco nem volta a ser exibido
    const row = (await t.ctx.pool.query("SELECT password_hash, totp_secret_encrypted, role, must_change_password, link_quota FROM accounts WHERE email = 'laercio@example.org'")).rows[0];
    expect(row.role).toBe('admin');
    expect(row.must_change_password).toBe(true);
    expect(row.password_hash).not.toContain(body.temporaryPassword);
    expect(row.totp_secret_encrypted).not.toContain(body.totpSecret);
    const list = JSON.stringify((await api(admin1, 'GET', '/users')).json());
    expect(list).not.toContain(body.totpSecret);
    expect(list).not.toContain(body.recoveryCodes[0]!);
    const audit = (await t.ctx.pool.query("SELECT metadata_redacted::text AS m FROM audit_events WHERE action = 'admin.create' AND result = 'success'")).rows;
    expect(audit).toHaveLength(1);
    expect(audit[0].m).not.toContain(body.totpSecret);
  });

  it('e-mail duplicado => 409; senha fraca => 400; e-mail inválido => 400', async () => {
    await api(admin1, 'POST', '/auth/reauth', { password: ADMIN_PASSWORD });
    expect((await api(admin1, 'POST', '/users/admins', { email: 'LAERCIO@example.org' })).statusCode).toBe(409);
    expect((await api(admin1, 'POST', '/users/admins', { email: 'novo@example.org', password: 'fraca' })).statusCode).toBe(400);
    expect((await api(admin1, 'POST', '/users/admins', { email: 'nao-e-email' })).statusCode).toBe(400);
  });

  it('o CLI de instalação continua recusando um segundo admin (a criação é pelo painel)', async () => {
    await expect(bootstrapAdmin(t.ctx.pool, t.ctx.encKey, 'outro@example.org', 'Senha-Forte-#2026-zz')).rejects.toThrow(/painel/);
  });
});

describe('primeiro acesso do novo administrador', () => {
  let laercio: NewAdmin;
  let session: Session;

  beforeAll(async () => {
    await t.ctx.pool.query("DELETE FROM accounts WHERE email = 'laercio@example.org'");
    const created = await createAdmin(admin1, 'laercio@example.org');
    expect(created.res.statusCode).toBe(201);
    laercio = created.body;
  });

  it('MFA é obrigatório: senha sozinha não abre sessão', async () => {
    const l1 = await t.app.inject({ method: 'POST', url: '/api/v1/auth/login', headers: { host: host() }, remoteAddress: nextIp(), payload: { email: laercio.email, password: laercio.temporaryPassword } });
    expect(l1.statusCode).toBe(200);
    expect(l1.json().mfaRequired).toBe(true);
    expect(l1.json().mfaSetupPending).toBe(true);
    expect(l1.cookies).toHaveLength(0);
    const bad = await loginAdmin(laercio.email, laercio.temporaryPassword, '000000');
    expect(isSession(bad)).toBe(false);
  });

  it('entra com TOTP, é obrigado a trocar a senha e aceitar os Termos, e depois tem poderes de admin', async () => {
    const s = await loginAdmin(laercio.email, laercio.temporaryPassword, authenticator.generate(laercio.totpSecret));
    expect(isSession(s)).toBe(true);
    session = s as Session;
    const me = (await api(session, 'GET', '/auth/me')).json();
    expect(me).toMatchObject({ role: 'admin', mustChangePassword: true });
    const blocked = await api(session, 'GET', '/users');
    expect(blocked.statusCode).toBe(403);
    expect(blocked.json().error.code).toBe('password_change_required');
    expect((await api(session, 'POST', '/auth/change-password', { currentPassword: laercio.temporaryPassword, newPassword: 'Laercio-Forte-#2026-ok' })).json().error.code).toBe('terms_required');
    expect((await api(session, 'POST', '/auth/change-password', { currentPassword: laercio.temporaryPassword, newPassword: 'Laercio-Forte-#2026-ok', acceptTerms: true })).statusCode).toBe(200);
    expect((await api(session, 'GET', '/users')).statusCode).toBe(200);
    expect((await api(session, 'GET', '/settings')).statusCode).toBe(200);
  });

  it('enxerga os dados de todos (escopo de admin) e o admin original enxerga os dele', async () => {
    await makeLink(t, user, { slug: 'link-do-usuario' });
    await makeLink(t, admin1, { slug: 'link-do-admin1' });
    const slugs = (await api(session, 'GET', '/links')).json().items.map((l: { slug: string }) => l.slug);
    expect(slugs).toEqual(expect.arrayContaining(['link-do-usuario', 'link-do-admin1']));
    const roles = (await api(admin1, 'GET', '/users')).json().items.filter((u: { role: string }) => u.role === 'admin').length;
    expect(roles).toBe(2);
  });

  it('código de recuperação também abre sessão (uso único)', async () => {
    const code = laercio.recoveryCodes[0]!;
    expect(isSession(await loginAdmin(laercio.email, 'Laercio-Forte-#2026-ok', code))).toBe(true);
    expect(isSession(await loginAdmin(laercio.email, 'Laercio-Forte-#2026-ok', code))).toBe(false);
  });

  it('a conta própria é protegida: não se suspende, exclui nem redefine por aqui', async () => {
    const me = (await api(session, 'GET', '/users')).json().items.find((u: { email: string }) => u.email === laercio.email);
    expect((await api(session, 'PATCH', `/users/${me.id}`, { status: 'suspended' })).json().error.code).toBe('self_protected');
    expect((await api(session, 'DELETE', `/users/${me.id}`)).statusCode).toBe(400);
    expect((await api(session, 'POST', `/users/${me.id}/reset-password`)).statusCode).toBe(400);
  });

  it('um admin suspende outro: sessões caem, login é recusado e os links dele NÃO são desativados; reativar restaura o acesso', async () => {
    const other = (await api(admin1, 'GET', '/users')).json().items.find((u: { email: string }) => u.email === laercio.email);
    await makeLink(t, session, { slug: 'link-do-laercio' });
    expect((await api(admin1, 'PATCH', `/users/${other.id}`, { status: 'suspended' })).statusCode).toBe(200);
    expect((await api(session, 'GET', '/links')).statusCode).toBe(401);
    const denied = await loginAdmin(laercio.email, 'Laercio-Forte-#2026-ok', authenticator.generate(laercio.totpSecret));
    expect(isSession(denied)).toBe(false);
    expect((denied as { status: number }).status).toBe(403);
    const link = (await t.ctx.pool.query("SELECT is_active, moderation_disabled FROM short_links WHERE slug = 'link-do-laercio'")).rows[0];
    expect(link).toEqual({ is_active: true, moderation_disabled: false });

    expect((await api(admin1, 'PATCH', `/users/${other.id}`, { status: 'active' })).statusCode).toBe(200);
    // TOTP não pode ser reutilizado na mesma janela de 30 s: usa um código de recuperação
    expect(isSession(await loginAdmin(laercio.email, 'Laercio-Forte-#2026-ok', laercio.recoveryCodes[1]!))).toBe(true);
  });

  it('redefinir a senha de outro admin exige nova troca e mantém o MFA', async () => {
    const other = (await api(admin1, 'GET', '/users')).json().items.find((u: { email: string }) => u.email === laercio.email);
    const r = await api(admin1, 'POST', `/users/${other.id}/reset-password`);
    expect(r.statusCode).toBe(200);
    const l1 = await t.app.inject({ method: 'POST', url: '/api/v1/auth/login', headers: { host: host() }, remoteAddress: nextIp(), payload: { email: laercio.email, password: r.json().temporaryPassword } });
    expect(l1.json().mfaRequired).toBe(true);
  });

  it('excluir outro admin apaga a conta e os dados dele; o admin original permanece', async () => {
    const other = (await api(admin1, 'GET', '/users')).json().items.find((u: { email: string }) => u.email === laercio.email);
    expect((await api(admin1, 'DELETE', `/users/${other.id}`)).statusCode).toBe(200);
    expect((await t.ctx.pool.query("SELECT 1 FROM accounts WHERE email = 'laercio@example.org'")).rowCount).toBe(0);
    expect((await t.ctx.pool.query("SELECT 1 FROM short_links WHERE slug = 'link-do-laercio'")).rowCount).toBe(0);
    expect((await api(admin1, 'GET', '/auth/me')).json().role).toBe('admin');
    void USER_PASSWORD;
  });
});
