import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { AuthService, SESSION_TTL_MS } from '../auth.ts';
import { audit } from '../audit.ts';
import type { Ctx } from '../context.ts';
import { HttpError } from '../util.ts';
import { registerLinks } from './links.ts';
import { registerEvents } from './events.ts';
import { registerDashboard } from './dashboard.ts';
import { registerAlerts } from './alerts.ts';
import { registerMisc } from './misc.ts';
import { registerExports } from './exports.ts';

const loginBody = z.object({ email: z.string().email().max(254), password: z.string().min(1).max(256) });
const verifyBody = z.object({ challenge: z.string().min(20).max(100), code: z.string().min(6).max(32) });
const reauthBody = z.object({ password: z.string().min(1).max(256) });

export function sessionCookieName(secure: boolean): string {
  return secure ? '__Host-iplc_session' : 'iplc_session';
}

export function registerAdmin(app: FastifyInstance, ctx: Ctx): void {
  const { config, auth, pool } = ctx;
  const cookieName = sessionCookieName(config.cookieSecure);
  const dashboardOrigin = new URL(config.PUBLIC_DASHBOARD_URL).origin;

  // A API administrativa só responde no domínio do painel
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

  // --- Rotas públicas de autenticação
  app.post('/auth/login', { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (req, reply) => {
    checkOrigin(req);
    const body = loginBody.parse(req.body);
    const result = await auth.startLogin(body.email, body.password);
    if (!result.ok) {
      await audit(pool, { action: 'auth.login', result: 'failure', metadata: { reason: result.reason } });
      if (result.reason === 'locked') throw new HttpError(429, 'locked', 'Conta temporariamente bloqueada. Tente mais tarde.');
      throw new HttpError(401, 'invalid_credentials', 'Credenciais inválidas');
    }
    return { challenge: result.challenge, mfaSetupPending: result.mfaSetupPending };
  });

  app.post('/auth/totp/verify', { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (req, reply) => {
    checkOrigin(req);
    const body = verifyBody.parse(req.body);
    const result = await auth.completeLogin(body.challenge, body.code);
    if (!result.ok) {
      await audit(pool, { action: 'auth.mfa', result: 'failure' });
      throw new HttpError(401, 'invalid_code', 'Código inválido ou expirado');
    }
    await audit(pool, { adminId: result.adminId, action: 'auth.login', result: 'success', metadata: { recovery: result.usedRecovery } });
    setSessionCookie(reply, result.sessionToken);
    return { email: result.email, csrfToken: result.csrfToken, usedRecoveryCode: result.usedRecovery };
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
    });

    priv.get('/auth/me', async (req) => ({ authenticated: true, email: req.session!.email, csrfToken: req.session!.csrfToken }));

    priv.post('/auth/logout', async (req, reply) => {
      await auth.revokeSession(req.session!.id);
      await audit(pool, { adminId: req.session!.adminId, action: 'auth.logout', result: 'success' });
      reply.clearCookie(cookieName, { path: '/' });
      return { ok: true };
    });

    priv.post('/auth/reauth', { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (req) => {
      const { password } = reauthBody.parse(req.body);
      const ok = await auth.reauthenticate(req.session!, password);
      await audit(pool, { adminId: req.session!.adminId, action: 'auth.reauth', result: ok ? 'success' : 'failure' });
      if (!ok) throw new HttpError(401, 'invalid_credentials', 'Senha incorreta');
      return { ok: true, validForSeconds: 300 };
    });

    registerLinks(priv, ctx);
    registerEvents(priv, ctx);
    registerDashboard(priv, ctx);
    registerAlerts(priv, ctx);
    registerExports(priv, ctx);
    registerMisc(priv, ctx);
  });
}
