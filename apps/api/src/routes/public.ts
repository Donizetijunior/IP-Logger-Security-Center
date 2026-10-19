import type { FastifyInstance } from 'fastify';
import type { Ctx } from '../context.ts';

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] ?? c);

export function renderPrivacyPage(ctx: Ctx, geoAttribution: string | null = null): string {
  const { config } = ctx;
  return `<!doctype html>
<html lang="pt-BR">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>Aviso de Privacidade</title>
<style>
  :root { color-scheme: light dark; }
  body { font: 16px/1.6 system-ui, sans-serif; max-width: 46rem; margin: 2rem auto; padding: 0 1rem; }
  h1 { font-size: 1.6rem; } h2 { font-size: 1.15rem; margin-top: 1.8rem; }
  .aviso { border: 1px solid; padding: .75rem 1rem; border-radius: .5rem; }
</style>
</head>
<body>
<h1>Aviso de Privacidade — Links monitorados</h1>
<p class="aviso"><strong>Modelo a revisar.</strong> Este texto precisa de validação jurídica e do controlador antes da publicação.</p>

<h2>Quem é o controlador</h2>
<p>${esc(config.PRIVACY_CONTROLLER_NAME)}. Contato para exercício de direitos do titular: ${esc(config.PRIVACY_CONTACT_EMAIL)}.</p>

<h2>Quem cria os links</h2>
<p>Esta plataforma é aberta a usuários cadastrados, que aceitam Termos de Uso e <strong>são responsáveis pelos links que criam</strong>. O uso para rastrear pessoas sem autorização ou consentimento é proibido. Se você recebeu um link e acredita que foi usado indevidamente, <a href="${esc(config.PUBLIC_DASHBOARD_URL)}/denunciar">denuncie aqui</a> (sem login e sem registrar o seu IP).</p>

<h2>Finalidade</h2>
<p>Os links encurtados deste domínio registram eventos de acesso para fins de <strong>segurança da informação e investigação de incidentes</strong> (por exemplo, identificar automação, varreduras e abuso). Não há página intermediária: o redirecionamento ocorre imediatamente.</p>

<h2>Quais dados são registrados</h2>
<ul>
  <li>Endereço IP da conexão e data/hora (UTC);</li>
  <li>Link acessado, método HTTP e resultado;</li>
  <li>User-Agent, idioma aceito e origem (domínio) do Referer, truncados e sanitizados;</li>
  <li>Estimativas derivadas: tipo de dispositivo/navegador, país/região/cidade aproximados, ASN e reputação do endereço de rede.</li>
</ul>
<p>Não coletamos cookies, senhas, tokens, conteúdo de formulários, identificadores persistentes de navegador, nem usamos fingerprinting ou scripts no destino.</p>

<h2>Importante sobre as estimativas</h2>
<p>A geolocalização e a reputação referem-se ao <strong>endereço de rede</strong>, que pode ser compartilhado (NAT, VPN, redes corporativas) e não identifica, por si só, uma pessoa.</p>
${geoAttribution ? `<p><small>${esc(geoAttribution)}</small></p>` : ''}

<h2>Compartilhamento com terceiros</h2>
<p>O endereço IP público pode ser consultado, de forma automatizada, em serviços de inteligência de ameaças (quando habilitados): AbuseIPDB, GreyNoise e consultas RDAP. IPs privados ou reservados nunca são enviados.</p>

<h2>Retenção</h2>
<p>Eventos de acesso identificáveis para análise são eliminados automaticamente após ${config.ANALYTICS_RETENTION_DAYS} dias. Registros de acesso que o controlador esteja obrigado a guardar por lei (Lei 12.965/2014, art. 15) seguem prazo e controles próprios, quando aplicáveis.</p>

<h2>Seus direitos</h2>
<p>Nos termos da LGPD (Lei 13.709/2018), você pode solicitar confirmação de tratamento, acesso, correção, eliminação quando cabível e informações sobre compartilhamento, pelo contato acima.</p>
</body>
</html>`;
}

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
    return reply.code(404).send({ error: { code: 'not_found', message: 'Não encontrado' } });
  });
  app.get('/robots.txt', async (_req, reply) => reply.type('text/plain').send('User-agent: *\nDisallow: /\n'));
}
