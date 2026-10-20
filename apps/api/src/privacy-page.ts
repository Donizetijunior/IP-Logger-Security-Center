import type { Ctx } from './context.ts';

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] ?? c);

/** Versão e data do Aviso de Privacidade: altere ao mudar o conteúdo (e registre em docs/legal-decision.md). */
export const PRIVACY_VERSION = '2026-10-20';
export const PRIVACY_UPDATED_AT = '20 de outubro de 2026';

/**
 * Aviso de Privacidade público (LGPD, art. 9º). Cada afirmação aqui deve corresponder ao que o código faz;
 * trechos que dependem de configuração (provedores, prazos) são gerados a partir dela.
 */
export function renderPrivacyPage(ctx: Ctx, geoAttribution: string | null = null): string {
  const { config } = ctx;
  const contact = esc(config.PRIVACY_CONTACT_EMAIL);
  const mailto = /^[^\s@<>"']+@[^\s@<>"']+$/.test(config.PRIVACY_CONTACT_EMAIL) ? `<a href="mailto:${contact}">${contact}</a>` : contact;
  const days = config.ANALYTICS_RETENTION_DAYS;
  const panel = esc(config.PUBLIC_DASHBOARD_URL.replace(/\/$/, ''));
  const optional: string[] = [];
  if (config.ABUSEIPDB_ENABLED) optional.push('AbuseIPDB (reputação de IP; EUA)');
  if (config.GREYNOISE_ENABLED) optional.push('GreyNoise (classificação de ruído de internet; EUA)');
  const thirdParties = `
  <li><strong>Cloudflare, Inc.</strong> (EUA, infraestrutura global): DNS, TLS e túnel de acesso ao servidor, além do encaminhamento do e-mail de contato. Todo o tráfego passa por ela, portanto ela processa o endereço IP e os dados técnicos da conexão. Ela publica termos de tratamento de dados (DPA).</li>
  ${config.RDAP_ENABLED ? '<li><strong>Registros RDAP</strong> (via rdap.org e registros regionais de internet, como LACNIC e ARIN): recebem o <em>endereço IP público</em> consultado para informar quem é o responsável pelo bloco de rede. Não recebem outros dados.</li>' : ''}
  ${optional.map((o) => `<li><strong>${esc(o)}</strong>: recebe somente o endereço IP público.</li>`).join('\n  ')}`;
  return `<!doctype html>
<html lang="pt-BR">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>Aviso de Privacidade</title>
<style>
  :root { color-scheme: light dark; }
  body { font: 16px/1.65 system-ui, sans-serif; max-width: 48rem; margin: 2rem auto; padding: 0 1rem 3rem; }
  h1 { font-size: 1.7rem; margin-bottom: .2rem; } h2 { font-size: 1.2rem; margin-top: 2.2rem; }
  h3 { font-size: 1rem; margin-top: 1.2rem; }
  .meta { opacity: .75; margin-top: 0; }
  .resumo { border: 1px solid; padding: .75rem 1rem; border-radius: .5rem; }
  table { border-collapse: collapse; width: 100%; font-size: .95rem; }
  th, td { border: 1px solid #8884; padding: .45rem .6rem; text-align: left; vertical-align: top; }
  nav ul { columns: 2; padding-left: 1.1rem; }
</style>
</head>
<body>
<h1>Aviso de Privacidade</h1>
<p class="meta">Versão ${PRIVACY_VERSION} · atualizado em ${PRIVACY_UPDATED_AT} · Lei Geral de Proteção de Dados (Lei 13.709/2018)</p>

<div class="resumo">
<p><strong>Em resumo.</strong> Este serviço cria links curtos que <strong>registram os acessos</strong> (endereço IP, data/hora e dados técnicos do navegador) para fins de segurança da informação. Quem criou o link vê esses registros. Eles são <strong>apagados automaticamente após ${days} dias</strong>. Não usamos cookies de rastreamento, publicidade nem venda de dados. Você pode exercer seus direitos pelo e-mail ${mailto}.</p>
</div>

<nav aria-label="Índice"><ul>
<li><a href="#controlador">1. Quem é o controlador</a></li>
<li><a href="#visitantes">2. Se você apenas clicou em um link</a></li>
<li><a href="#contas">3. Se você tem uma conta</a></li>
<li><a href="#denuncias">4. Denúncias de abuso</a></li>
<li><a href="#ferramentas">5. Ferramentas e notas privadas</a></li>
<li><a href="#cookies">6. Cookies</a></li>
<li><a href="#terceiros">7. Compartilhamento e transferência internacional</a></li>
<li><a href="#retencao">8. Por quanto tempo guardamos</a></li>
<li><a href="#direitos">9. Seus direitos e como exercê-los</a></li>
<li><a href="#seguranca">10. Segurança</a></li>
<li><a href="#outros">11. Outras informações</a></li>
</ul></nav>

<h2 id="controlador">1. Quem é o controlador</h2>
<p>${esc(config.PRIVACY_CONTROLLER_NAME)}. O serviço é um projeto de código aberto, gratuito e sem fins econômicos, mantido por uma pessoa física. Canal para titulares de dados e para a Autoridade Nacional de Proteção de Dados (ANPD): ${mailto}.</p>
<p>Quem cria um link nesta plataforma (o <strong>dono do link</strong>) aceita os Termos de Uso, é responsável pelo uso que faz dos dados dos visitantes dos seus links e está proibido de rastrear pessoas sem autorização ou consentimento. O operador da plataforma e o dono do link tratam os dados cada um para as suas finalidades e responsabilidades.</p>

<h2 id="visitantes">2. Se você apenas clicou em um link</h2>
<h3>O que registramos</h3>
<ul>
  <li>Endereço IP da conexão e data/hora (UTC);</li>
  <li>Link acessado, método HTTP e resultado do redirecionamento;</li>
  <li>User-Agent (navegador e sistema), idioma aceito e <em>apenas o domínio</em> de origem (Referer), truncados e sanitizados;</li>
  <li>Estimativas derivadas do endereço IP: tipo de dispositivo/navegador, país/região/cidade aproximados, provedor (ASN) e reputação da rede.</li>
</ul>
<p>Não coletamos cookies, senhas, conteúdo de formulários nem identificadores persistentes do navegador, e não usamos <em>fingerprinting</em> nem scripts no destino. Não há página intermediária: o redirecionamento ocorre imediatamente e, por isso, você pode não perceber que o acesso foi registrado — é para isso que existe este aviso.</p>
<h3>Para quê e com que base legal</h3>
<p><strong>Finalidade:</strong> segurança da informação e investigação de incidentes (identificar automação, varreduras e abuso) e monitoramento, pelo dono, dos acessos aos seus próprios links. <strong>Base legal:</strong> legítimo interesse (LGPD, art. 7º, IX), com os cuidados de minimização descritos aqui; você pode se opor ao tratamento (veja a seção 9).</p>
<h3>Quem acessa esses dados</h3>
<p>O dono do link e o operador da plataforma. Os dados de um dono não são visíveis a outros usuários. Exportações feitas pelo dono mascaram o IP por padrão.</p>
<h3>Importante sobre as estimativas</h3>
<p>A geolocalização e a reputação referem-se ao <strong>endereço de rede</strong>, que pode ser compartilhado (NAT, VPN, redes corporativas ou móveis) e <strong>não identifica, por si só, uma pessoa</strong>. São estimativas e podem estar erradas.</p>
${geoAttribution ? `<p><small>${esc(geoAttribution)}</small></p>` : ''}
<p>Recebeu um link e acredita que foi usado indevidamente? <a href="${panel}/denunciar">Denuncie aqui</a>, sem login e sem registro do seu IP.</p>

<h2 id="contas">3. Se você tem uma conta</h2>
<table>
<tr><th>Dado</th><th>Para quê</th><th>Observações</th></tr>
<tr><td>E-mail</td><td>Identificar a conta, entrar e receber comunicações do serviço</td><td>Visível ao administrador</td></tr>
<tr><td>Senha</td><td>Autenticação</td><td>Guardada apenas como <em>hash</em> (Argon2id); nunca em texto</td></tr>
<tr><td>Autenticação em dois fatores (administradores)</td><td>Segurança da conta</td><td>Segredo TOTP cifrado; códigos de recuperação guardados como <em>hash</em></td></tr>
<tr><td>Sessão</td><td>Manter você conectado</td><td>Token aleatório guardado como <em>hash</em>; expira por inatividade e em até 8 horas</td></tr>
<tr><td>Links, domínios, alertas e exportações</td><td>Prestar o serviço</td><td>Isolados por conta</td></tr>
<tr><td>Aceite dos Termos</td><td>Prova do aceite</td><td>Data e versão</td></tr>
<tr><td>Registros de auditoria (ações como login, criação e exclusão)</td><td>Segurança e prevenção a abuso</td><td>Sem endereço IP; mantidos por ${config.AUDIT_RETENTION_DAYS} dias</td></tr>
</table>
<p><strong>Base legal:</strong> execução do serviço que você solicitou ao criar a conta (art. 7º, V) e legítimo interesse em segurança (art. 7º, IX). A criação da conta exige maioridade (18 anos).</p>
<p>Você pode excluir a conta em “Minha conta”: isso apaga links, eventos, alertas, exportações, notas e sessões.</p>

<h2 id="denuncias">4. Denúncias de abuso</h2>
<p>O formulário de denúncia não exige login e <strong>não registra o seu IP</strong>. Guardamos o link denunciado, o motivo, os detalhes que você escrever e, se informar, o seu contato. Esses dados servem apenas para analisar e documentar a moderação, e são eliminados 180 dias após a conclusão da análise.</p>

<h2 id="ferramentas">5. Ferramentas e notas privadas</h2>
<ul>
  <li><strong>Consultas</strong> (IP, URL, MAC, DNS): os dados que você digita são processados para responder e <strong>não ficam em histórico</strong>. Algumas consultas contactam serviços externos (por exemplo, RDAP) ou o endereço que você informou.</li>
  <li><strong>Notas privadas</strong>: são cifradas no seu navegador antes do envio. A chave fica no endereço (após o “#”) e <strong>nunca chega ao servidor</strong>, que guarda apenas o texto cifrado. A nota se autodestrói ao ser lida ou ao expirar.</li>
</ul>

<h2 id="cookies">6. Cookies</h2>
<p>Visitantes de links não recebem cookies. Usuários logados recebem apenas cookies <strong>estritamente necessários</strong> (sessão, <code>HttpOnly</code> e <code>SameSite=Strict</code>). Não há cookies de análise, publicidade ou terceiros.</p>

<h2 id="terceiros">7. Compartilhamento e transferência internacional</h2>
<p>Não vendemos nem cedemos dados para publicidade. Os dados são tratados em servidor operado pelo controlador. Para o serviço funcionar, utilizamos:</p>
<ul>${thirdParties}
</ul>
<p>As bases de geolocalização (DB-IP Lite) e de nós Tor são consultadas localmente, sem enviar o seu IP a terceiros. IPs privados ou reservados nunca são enviados a terceiros. Como alguns desses provedores estão fora do Brasil, há <strong>transferência internacional de dados</strong>, necessária à execução do serviço e à segurança (LGPD, art. 33). Também poderemos fornecer dados a autoridades quando houver <strong>ordem judicial ou obrigação legal</strong> válidas.</p>

<h2 id="retencao">8. Por quanto tempo guardamos</h2>
<table>
<tr><th>Dado</th><th>Prazo</th></tr>
<tr><td>Eventos de acesso aos links (IP e dados técnicos)</td><td>${days} dias, depois eliminados automaticamente</td></tr>
<tr><td>Cópias de segurança cifradas do banco</td><td>Podem conter eventos já eliminados por um período limitado adicional (hoje, até 14 dias)</td></tr>
<tr><td>Conta, links e domínios</td><td>Até a exclusão da conta</td></tr>
<tr><td>Registros de auditoria (sem IP)</td><td>${config.AUDIT_RETENTION_DAYS} dias</td></tr>
<tr><td>Denúncias</td><td>180 dias após a conclusão</td></tr>
<tr><td>Notas privadas</td><td>Até a leitura ou a expiração</td></tr>
</table>
<p>Se uma lei ou ordem judicial exigir a guarda de registros por prazo maior (por exemplo, Lei 12.965/2014, art. 15 e seguintes), eles seguirão esse prazo apenas na medida exigida.</p>

<h2 id="direitos">9. Seus direitos e como exercê-los</h2>
<p>Pela LGPD (art. 18) você pode pedir: confirmação de que tratamos seus dados; acesso; correção; anonimização, bloqueio ou eliminação de dados desnecessários ou tratados em desconformidade; portabilidade; eliminação dos dados tratados; informação sobre com quem compartilhamos; e <strong>oposição</strong> ao tratamento feito com base em legítimo interesse. Você também pode peticionar à ANPD (gov.br/anpd).</p>
<p>Escreva para ${mailto}. Responderemos em até 15 dias. Como um endereço IP, sozinho, não prova quem o usa, podemos pedir informações para localizar os registros (por exemplo, o link acessado e o dia e a hora aproximados) e avaliar com cuidado para não expor dados de terceiros.</p>

<h2 id="seguranca">10. Segurança</h2>
<p>Adotamos conexões cifradas (TLS), <em>hash</em> de senhas e tokens, cifragem de segredos e de cópias de segurança, isolamento de dados entre contas, autenticação em dois fatores para administradores, limitação de tentativas e registro de ações administrativas. Nenhum sistema é totalmente seguro; em caso de incidente relevante, comunicaremos os titulares e a ANPD conforme a LGPD (art. 48).</p>

<h2 id="outros">11. Outras informações</h2>
<ul>
  <li><strong>Menores:</strong> o serviço não é destinado a menores de 18 anos e não cria contas para eles.</li>
  <li><strong>Código aberto:</strong> o código é público (<a href="${esc(config.OPEN_SOURCE_URL)}" rel="noopener">repositório</a>); os dados dos usuários e visitantes não são.</li>
  <li><strong>Alterações:</strong> este aviso pode mudar. A versão e a data ficam no topo; mudanças relevantes serão avisadas no painel.</li>
</ul>
</body>
</html>`;
}
