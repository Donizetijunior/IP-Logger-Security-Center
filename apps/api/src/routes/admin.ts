import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { AuthService, SESSION_TTL_MS, type CreatedSession } from '../auth.ts';
import { audit } from '../audit.ts';
import type { Ctx } from '../context.ts';
import { HttpError } from '../util.ts';
import { registerLinks } from './links.ts';
import { registerEvents } from './events.ts';
import { registerDashboard } from './dashboard.ts';
import { registerAlerts } from './alerts.ts';
import { registerMisc } from './misc.ts';
import { registerExports } from './exports.ts';
import { registerPublicAccount } from './signup.ts';
import { eraseAccount, registerUsers } from './users.ts';
import { registerReports } from './reports.ts';
import { registerTools } from './tools.ts';
import { registerDomains } from './domains.ts';

const loginBody = z.object({ email: z.string().email().max(254), password: z.string().min(1).max(256) });
const verifyBody = z.object({ challenge: z.string().min(20).max(100), code: z.string().min(6).max(32) });
const reauthBody = z.object({ password: z.string().min(1).max(256) });
const changePasswordBody = z.object({
  currentPassword: z.string().min(1).max(256),
  newPassword: z.string().min(1).max(256),
  acceptTerms: z.boolean().optional(),
});

export function sessionCookieName(secure: boolean): string {
  return secure ? '__Host-iplc_session' : 'iplc_session';
}

/** Rotas permitidas enquanto a troca de senha obrigatória não foi feita. */
const ALLOWED_WHILE_MUST_CHANGE = new Set(['/auth/me', '/auth/logout', '/auth/change-password']);

export function registerAdmin(app: FastifyInstance, ctx: Ctx): void {
  const { config, auth, pool } = ctx;
  const cookieName = sessionCookieName(config.cookieSecure);
  const dashboardOrigin = new URL(config.PUBLIC_DASHBOARD_URL).origin;

  // A API administrativa/painel só responde no domínio do painel
  app.addHook('onRequest', async (req, reply) => {
    const host = (req.headers.host ?? '').toLowerCase();
    if (host !== config.dashboardHost) {
      reply.code(404).send({ error: { code: 'not_found', message: 'Não encontrado' } });
      return reply;
    }
    return undefined;
  });

  const checkOrigin = (req: FastifyRequest): void => {
    const origin = req.headers.origin;
    if (origin && origin !== dashboardOrigin) throw new HttpError(403, 'forbidden_origin', 'Origem não permitida');
  };

  const setSessionCookie = (reply: FastifyReply, token: string) => {
    reply.setCookie(cookieName, token, {
      httpOnly: true, secure: config.cookieSecure, sameSite: 'strict', path: '/', maxAge: Math.floor(SESSION_TTL_MS / 1000),
    });
  };

  const sessionPayload = (s: CreatedSession) => ({
    authenticated: true, email: s.email, role: s.role, mustChangePassword: s.mustChangePassword, csrfToken: s.csrfToken,
  });

  // --- Rotas públicas (sem sessão)
  registerPublicAccount(app, ctx, checkOrigin);

  app.post('/auth/login', { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (req, reply) => {
    checkOrigin(req);
    const body = loginBody.parse(req.body);
    const result = await auth.startLogin(body.email, body.password);
    if (!result.ok) {
      await audit(pool, { action: 'auth.login', result: 'failure', metadata: { reason: result.reason } });
      if (result.reason === 'locked') throw new HttpError(429, 'locked', 'Conta temporariamente bloqueada. Tente mais tarde.');
      if (result.reason === 'pending') throw new HttpError(403, 'account_pending', 'Sua conta aguarda aprovação do administrador.');
      if (result.reason === 'suspended') throw new HttpError(403, 'account_suspended', 'Esta conta está suspensa.');
      throw new HttpError(401, 'invalid_credentials', 'Credenciais inválidas');
    }
    if (result.mfaRequired) return { mfaRequired: true, challenge: result.challenge, mfaSetupPending: result.mfaSetupPending };
    await audit(pool, { accountId: result.session.accountId, action: 'auth.login', result: 'success', metadata: { mfa: false } });
    setSessionCookie(reply, result.session.sessionToken);
    return { mfaRequired: false, ...sessionPayload(result.session) };
  });

  app.post('/auth/totp/verify', { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (req, reply) => {
    checkOrigin(req);
    const body = verifyBody.parse(req.body);
    const result = await auth.completeLogin(body.challenge, body.code);
    if (!result.ok) {
      await audit(pool, { action: 'auth.mfa', result: 'failure' });
      throw new HttpError(401, 'invalid_code', 'Código inválido ou expirado');
    }
    await audit(pool, { accountId: result.session.accountId, action: 'auth.login', result: 'success', metadata: { mfa: true, recovery: result.usedRecovery } });
    setSessionCookie(reply, result.session.sessionToken);
    return { ...sessionPayload(result.session), usedRecoveryCode: result.usedRecovery };
  });

  // --- Escopo autenticado
  app.register(async (priv) => {
    priv.addHook('preHandler', async (req) => {
      const token = req.cookies[cookieName];
      const session = token ? await auth.findSession(token) : null;
      if (!session) throw new HttpError(401, 'unauthenticated', 'Autenticação necessária');
      req.session = session;
      if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
        checkOrigin(req);
        const header = req.headers['x-csrf-token'];
        if (!AuthService.csrfValid(session, typeof header === 'string' ? header : undefined)) {
          throw new HttpError(403, 'csrf', 'Token CSRF inválido');
        }
      }
      if (session.mustChangePassword) {
        const route = (req.url.split('?')[0] ?? '').replace(/^\/api\/v1/, '');
        if (!ALLOWED_WHILE_MUST_CHANGE.has(route)) throw new HttpError(403, 'password_change_required', 'Troque a senha temporária para continuar');
      }
    });

    priv.get('/auth/me', async (req) => ({
      authenticated: true, email: req.session!.email, role: req.session!.role, mustChangePassword: req.session!.mustChangePassword,
      linkQuota: req.session!.linkQuota, csrfToken: req.session!.csrfToken,
    }));

    priv.post('/auth/logout', async (req, reply) => {
      await auth.revokeSession(req.session!.id);
      await audit(pool, { accountId: req.session!.accountId, action: 'auth.logout', result: 'success' });
      reply.clearCookie(cookieName, { path: '/' });
      return { ok: true };
    });

    priv.post('/auth/reauth', { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (req) => {
      const { password } = reauthBody.parse(req.body);
      const ok = await auth.reauthenticate(req.session!, password);
      await audit(pool, { accountId: req.session!.accountId, action: 'auth.reauth', result: ok ? 'success' : 'failure' });
      if (!ok) throw new HttpError(401, 'invalid_credentials', 'Senha incorreta');
      return { ok: true, validForSeconds: 300 };
    });

    priv.post('/auth/change-password', { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (req) => {
      const body = changePasswordBody.parse(req.body);
      // Contas criadas pelo administrador aceitam os Termos de Uso no primeiro acesso
      const terms = await pool.query<{ terms_accepted_at: Date | null }>('SELECT terms_accepted_at FROM accounts WHERE id = $1', [req.session!.accountId]);
      if (!terms.rows[0]?.terms_accepted_at && body.acceptTerms !== true) {
        throw new HttpError(400, 'terms_required', 'É necessário aceitar os Termos de Uso');
      }
      const r = await auth.changePassword(req.session!, body.currentPassword, body.newPassword);
      if (r === 'wrong_current') {
        await audit(pool, { accountId: req.session!.accountId, action: 'auth.change_password', result: 'failure' });
        throw new HttpError(401, 'invalid_credentials', 'Senha atual incorreta');
      }
      if (typeof r === 'object') throw new HttpError(400, 'weak_password', r.weak);
      await pool.query('UPDATE accounts SET terms_accepted_at = COALESCE(terms_accepted_at, now()) WHERE id = $1', [req.session!.accountId]);
      await audit(pool, { accountId: req.session!.accountId, action: 'auth.change_password', result: 'success' });
      return { ok: true };
    });

    // Direito de apagamento: o próprio usuário exclui a conta e seus dados (o admin é protegido)
    priv.post('/auth/delete-account', { config: { rateLimit: { max: 5, timeWindow: '1 minute' } } }, async (req, reply) => {
      const { password } = reauthBody.parse(req.body);
      if (req.session!.role === 'admin') throw new HttpError(400, 'admin_protected', 'A conta administradora não pode ser excluída por aqui');
      const ok = await auth.reauthenticate(req.session!, password);
      if (!ok) throw new HttpError(401, 'invalid_credentials', 'Senha incorreta');
      const links = await eraseAccount(ctx, req.session!.accountId);
      await audit(pool, { action: 'account.self_delete', result: 'success', metadata: { links } });
      reply.clearCookie(cookieName, { path: '/' });
      return { ok: true };
    });

    registerLinks(priv, ctx);
    registerEvents(priv, ctx);
    registerDashboard(priv, ctx);
    registerAlerts(priv, ctx);
    registerExports(priv, ctx);
    registerMisc(priv, ctx);
    registerUsers(priv, ctx);
    registerReports(priv, ctx);
    registerTools(priv, ctx);
    registerDomains(priv, ctx);
  });
}
