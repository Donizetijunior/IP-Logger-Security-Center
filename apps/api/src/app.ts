import cookie from '@fastify/cookie';
import rateLimit from '@fastify/rate-limit';
import Fastify, { type FastifyInstance } from 'fastify';
import { ZodError } from 'zod';
import { FilterError, isPublicIp, parseCidrs, parseIp, resolveClientIp } from '@ipl/shared';
import type { Ctx } from './context.ts';
import { HttpError } from './util.ts';
import { registerRedirect } from './routes/redirect.ts';
import { registerPublic } from './routes/public.ts';
import { registerAdmin } from './routes/admin.ts';

export const SESSION_COOKIE_BASE = 'iplc_session';

export async function buildApp(
  ctx: Ctx,
  opts: { logger?: boolean; logStream?: { write(msg: string): void } } = {},
): Promise<FastifyInstance> {
  const trusted = parseCidrs(ctx.config.TRUSTED_PROXY_CIDRS);
  const app = Fastify({
    logger: opts.logger === false ? false : { level: ctx.config.LOG_LEVEL, ...(opts.logStream ? { stream: opts.logStream } : {}) },
    disableRequestLogging: true,
    bodyLimit: 64 * 1024,
    maxParamLength: 128,
    routerOptions: { ignoreTrailingSlash: true },
    // Nunca usar trustProxy do Fastify: o IP é resolvido por resolveClientIp (proxies explicitamente confiáveis).
    trustProxy: false,
  });

  await app.register(cookie);
  await app.register(rateLimit, {
    global: false,
    keyGenerator: (req) => req.clientIp ?? req.ip,
  });

  app.decorateRequest('clientIp', null);
  app.decorateRequest('session', null);

  app.addHook('onRequest', async (req, reply) => {
    req.clientIp = resolveClientIp({
      socketIp: req.socket.remoteAddress,
      forwardedFor: req.headers['x-forwarded-for'],
      trusted,
    });
    const path = req.url.split('?')[0] ?? '';
    const internal = path === '/healthz' || path === '/readyz' || path === '/metrics';
    if (!internal) {
      const host = (req.headers.host ?? '').toLowerCase();
      if (host !== ctx.config.shortHost && host !== ctx.config.dashboardHost) {
        // Domínio personalizado: só ativos; domínios pendentes podem responder apenas à checagem de roteamento
        const custom = ctx.domains.byHost(host);
        const routingCheck = path === '/.well-known/iplogger-check';
        if (!custom || (custom.status !== 'active' && !routingCheck)) {
          reply.code(421).send({ error: { code: 'misdirected_request', message: 'Host não reconhecido' } });
          return reply;
        }
      }
    }
    return undefined;
  });

  app.addHook('onSend', async (req, reply, payload) => {
    reply.header('x-content-type-options', 'nosniff');
    reply.header('referrer-policy', 'no-referrer');
    reply.header('x-robots-tag', 'noindex, nofollow');
    reply.header('x-frame-options', 'DENY');
    if (!reply.hasHeader('cache-control')) reply.header('cache-control', 'no-store');
    return payload;
  });

  // Log operacional mínimo: rota (padrão, não a URL real), status e duração. Sem IP, query ou cabeçalhos.
  app.addHook('onResponse', async (req, reply) => {
    req.log.info({ method: req.method, route: req.routeOptions?.url ?? 'n/a', status: reply.statusCode, ms: Math.round(reply.elapsedTime) }, 'req');
  });

  app.setErrorHandler((err: unknown, req, reply) => {
    if (err instanceof HttpError) {
      return reply.code(err.status).send({ error: { code: err.code, message: err.message } });
    }
    if (err instanceof FilterError) {
      return reply.code(400).send({ error: { code: 'invalid_filter', message: err.message } });
    }
    if (err instanceof ZodError) {
      return reply.code(400).send({
        error: { code: 'validation_error', message: 'Dados inválidos', details: err.issues.map((i) => ({ path: i.path.join('.'), message: i.message })) },
      });
    }
    const e = err as { statusCode?: number; code?: string; message?: string };
    if (e.statusCode && e.statusCode >= 400 && e.statusCode < 500) {
      return reply.code(e.statusCode).send({ error: { code: e.code ?? 'bad_request', message: 'Requisição inválida' } });
    }
    req.log.error({ err: { message: String(e.message ?? 'erro').replace(/[\r\n]+/g, ' ').slice(0, 300) } }, 'erro não tratado');
    return reply.code(500).send({ error: { code: 'internal_error', message: 'Erro interno' } });
  });

  app.setNotFoundHandler((_req, reply) => reply.code(404).send({ error: { code: 'not_found', message: 'Não encontrado' } }));

  // Endpoints internos só aceitam conexões diretas da rede Docker/loopback, nunca via proxy público.
  const isInternalRequest = (req: { socket: { remoteAddress?: string }; headers: Record<string, unknown> }): boolean => {
    if (req.headers['x-forwarded-for'] || req.headers['forwarded']) return false;
    const ip = parseIp(req.socket.remoteAddress);
    return !!ip && !isPublicIp(ip.toString());
  };

  app.get('/healthz', async () => ({ status: 'ok' }));
  app.get('/readyz', async (req, reply) => {
    if (!isInternalRequest(req)) return reply.code(404).send({ error: { code: 'not_found', message: 'Não encontrado' } });
    try {
      await ctx.pool.query('SELECT 1');
      return { status: 'ready' };
    } catch {
      return reply.code(503).send({ status: 'not_ready', reason: 'database_unavailable' });
    }
  });
  app.get('/metrics', async (req, reply) => {
    if (!isInternalRequest(req)) return reply.code(404).send({ error: { code: 'not_found', message: 'Não encontrado' } });
    return reply.type('text/plain; version=0.0.4').send(ctx.telemetry.prometheus());
  });

  await ctx.domains.refresh();
  registerPublic(app, ctx);
  await app.register(async (admin) => registerAdmin(admin, ctx), { prefix: '/api/v1' });
  // Rota catch-all /:slug por último
  registerRedirect(app, ctx);

  return app;
}
