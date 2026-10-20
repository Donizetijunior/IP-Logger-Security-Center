import type { FastifyInstance } from 'fastify';
import { validateTargetUrl } from '@ipl/shared';
import type { Ctx } from '../context.ts';

export { renderPrivacyPage } from '../privacy-page.ts';
import { renderPrivacyPage } from '../privacy-page.ts';

export function registerPublic(app: FastifyInstance, ctx: Ctx): void {
  app.get('/privacy', async (_req, reply) => {
    let attribution: string | null = null;
    try {
      const g = await ctx.pool.query<{ a: string | null }>("SELECT value->>'attribution' AS a FROM job_state WHERE key = 'geoip'");
      attribution = g.rows[0]?.a ?? null;
    } catch {
      /* sem banco: a página de privacidade continua disponível */
    }
    return reply
      .type('text/html; charset=utf-8')
      .header('content-security-policy', "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'")
      .header('cache-control', 'public, max-age=300')
      .send(renderPrivacyPage(ctx, attribution));
  });
  // Raiz do domínio de links: leva à plataforma (não há link no caminho vazio)
  app.get('/', async (req, reply) => {
    const host = (req.headers.host ?? '').toLowerCase();
    if (host === ctx.config.shortHost && ctx.config.shortHost !== ctx.config.dashboardHost) {
      return reply.redirect(ctx.config.PUBLIC_DASHBOARD_URL, 302);
    }
    // Domínio personalizado ativo: raiz redireciona ao destino configurado pelo dono (revalidado a cada uso)
    const custom = ctx.domains.byHost(host);
    if (custom?.status === 'active' && custom.rootRedirectUrl) {
      const t = validateTargetUrl(custom.rootRedirectUrl, ctx.config.allowedDomains);
      if (t.ok && t.url) return reply.header('cache-control', 'no-store').redirect(t.url, 302);
    }
    return reply.code(404).send({ error: { code: 'not_found', message: 'Não encontrado' } });
  });
  // Checagem de roteamento: prova que o domínio chega a esta instalação (devolve só o hash do token de verificação)
  app.get('/.well-known/iplogger-check', async (req, reply) => {
    const custom = ctx.domains.byHost(req.headers.host);
    if (!custom) return reply.code(404).send({ error: { code: 'not_found', message: 'Não encontrado' } });
    return reply.header('cache-control', 'no-store').send({ ok: true, challenge: custom.challenge });
  });
  app.get('/robots.txt', async (_req, reply) => reply.type('text/plain').send('User-agent: *\nDisallow: /\n'));
}
