import type { FastifyInstance } from 'fastify';
import {
  classifyClient, isValidSlug, sanitizeAcceptLanguage, sanitizeReferer, sanitizeUserAgent, validateTargetUrl,
} from '@ipl/shared';
import type { Ctx } from '../context.ts';

const INSERT_EVENT_SQL = `
  WITH e AS (
    INSERT INTO access_events
      (short_link_id, slug, ip_address, method, http_status, user_agent, accept_language, referer_origin,
       client_class, device_class, browser, os)
    VALUES ($1, $2, $3, $4, 302, $5, $6, $7, $8, $9, $10, $11)
    RETURNING id
  )
  INSERT INTO outbox_events (aggregate_id, type, payload_minimal)
  SELECT id, 'access_event.enrich', '{}'::jsonb FROM e`;

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error('timeout')), ms);
  });
  return Promise.race([p, timeout]).finally(() => clearTimeout(timer));
}

export function registerRedirect(app: FastifyInstance, ctx: Ctx): void {
  const { config, pool, telemetry, linkCache } = ctx;

  app.get<{ Params: { slug: string } }>(
    '/:slug',
    {
      config: {
        rateLimit: {
          max: config.REDIRECT_RATE_LIMIT_PER_MIN,
          timeWindow: '1 minute',
          onExceeded: () => telemetry.increment('redirect_rate_limited'),
        },
      },
    },
    async (req, reply) => {
      const started = performance.now();
      const notFound = () => reply.code(404).header('cache-control', 'no-store').send({ error: { code: 'not_found', message: 'Não encontrado' } });

      // Domínio principal (domainId = null) ou domínio personalizado ATIVO. Um link só responde no domínio a que pertence.
      const host = (req.headers.host ?? '').toLowerCase();
      let domainId: string | null = null;
      if (host !== config.shortHost) {
        const custom = ctx.domains.byHost(host);
        if (!custom || custom.status !== 'active') return notFound();
        domainId = custom.id;
      }

      const slug = req.params.slug;
      if (!isValidSlug(slug)) return notFound();

      let lookup;
      try {
        lookup = await linkCache.get(slug, domainId);
      } catch {
        telemetry.increment('redirect_lookup_failed');
        return reply.code(503).header('cache-control', 'no-store').header('retry-after', '5').send({ error: { code: 'unavailable', message: 'Serviço temporariamente indisponível' } });
      }
      if (lookup.degraded) telemetry.increment('redirect_degraded_cache');

      const link = lookup.link;
      // Inexistente, desativado, removido ou expirado: mesma resposta 404 (sem enumeração, sem vazar destino)
      if (!link || !link.is_active || link.deleted_at || (link.expires_at && link.expires_at.getTime() <= Date.now())) {
        return notFound();
      }
      // Revalida o destino imediatamente antes de redirecionar
      const target = validateTargetUrl(link.target_url, config.allowedDomains);
      if (!target.ok || !target.url) {
        telemetry.increment('redirect_invalid_target');
        return notFound();
      }

      const ip = req.clientIp;
      const ua = sanitizeUserAgent(req.headers['user-agent']);
      const client = classifyClient(req.method, ua);
      telemetry.increment(req.method === 'HEAD' ? 'requests_head' : 'requests_get');

      if (ip) {
        try {
          await withTimeout(
            pool.query(INSERT_EVENT_SQL, [
              link.id, link.slug, ip, req.method,
              ua, sanitizeAcceptLanguage(req.headers['accept-language']), sanitizeReferer(req.headers.referer),
              client.clientClass, client.deviceClass, client.browser, client.os,
            ]),
            config.REDIRECT_DB_TIMEOUT_MS,
          );
        } catch {
          // fail-open: o redirect segue; a perda de telemetria é contabilizada e vira alerta no painel
          telemetry.increment('capture_failed');
        }
      } else {
        telemetry.increment('capture_failed');
      }

      telemetry.observeRedirectMs(performance.now() - started);
      return reply.code(302).header('location', target.url).header('cache-control', 'no-store').send();
    },
  );
}
