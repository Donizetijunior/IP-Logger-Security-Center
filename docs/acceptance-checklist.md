# Checklist de aceite (CA-01 … CA-22) — resultados verificados

Data da verificação: 2026-10-19 · Ambiente: Windows 11 + Docker Desktop (Linux containers), Node 24, PostgreSQL 17, Redis 7, Caddy 2. **Não** foi verificado em VPS Linux de produção, nem com chaves/bases reais de provedores.

Legenda: ✅ verificado por teste automatizado executado e aprovado · 🧪 verificado em execução manual do stack · ⚠️ parcial/pendente (explicado).

## Resumo das execuções

| Suíte | Comando | Resultado |
|---|---|---|
| Tipos (api, worker, shared, testes) + web | `npm run typecheck` / `npm run typecheck:web` | sem erros |
| Unitários, integração (Postgres/Redis reais), segurança | `npm test` | **243 aprovados** em 13 arquivos (inclui multiusuário 22 · ferramentas 33 · domínios 18)|
| Build do painel | `npm run build:web` | ok (JS 315 kB / 98 kB gzip) |
| E2E no stack Compose (Caddy→API→Postgres/Redis/Worker) | `npx vitest run tests/e2e` | **13/13 aprovados** (rodado sobre um banco migrado da v0.1), incluindo quedas reais de Redis e Postgres e o teste do Cloudflare Tunnel (`CF-Connecting-IP` só do contêiner do túnel) |
| Smoke test de deploy | `./infra/scripts/smoke-test.sh` | **APROVADO** (contêineres saudáveis, DB/Redis não publicados, 404/401 corretos, CSP/nosniff, `Server` oculto) |
| OpenAPI | `redocly lint docs/openapi.yaml` | válido (0 erros; avisos de estilo) |
| Backup/restore reais | `backup.sh` + `restore.sh` | ok; 5 eventos vencidos reintroduzidos pelo backup foram **removidos antes de a API subir** |
| Painel no navegador | login com senha+TOTP, visão geral, alertas, eventos, IP, configurações, layout móvel | ok (1 bug visual encontrado e corrigido: nome da fonte Tor) |

## Critérios

| ID | Resultado | Evidência |
|---|---|---|
| CA-01 Admin cria link | ✅ | `api.test.ts` › links (401 sem sessão; 201 com slug/URL pública; slug duplicado 409; reservado 400) · E2E |
| CA-02 Visitante abre link | ✅🧪 | `api.test.ts` › redirect (302, `Location`, `no-store`, evento + outbox) · E2E pela cadeia real Caddy→API |
| CA-03 TI indisponível não bloqueia redirect | ✅ | O handler não importa nem aguarda provedores; E2E com provedores desabilitados e `worker.test.ts` com provedores falhando; carga: p95 interno ≤ 4 ms |
| CA-04 Redis offline | ✅🧪 | `worker.test.ts` (outbox permanece, publica ao voltar) · E2E: `docker compose stop redis` ⇒ 302, evento `pending`; após `start` ⇒ enriquecido |
| CA-05 PostgreSQL offline | ✅🧪 | `api.test.ts` (fail-open por cache; link desconhecido ⇒ 503) · E2E com `stop postgres`: 302 mantido, `capture_failed` contabilizado e visível no painel após a recuperação |
| CA-06 `X-Forwarded-For` falso | ✅🧪 | `shared.test.ts` (função), `api.test.ts` (direto e via proxy), E2E (cabeçalho forjado pelo cliente não altera o IP pela cadeia Caddy→API) |
| CA-07 IPv6/privado/reservado | ✅ | `shared.test.ts` (tabela de faixas), `worker.test.ts` (nenhuma chamada a provedores para IPs não públicos, inclusive documentação), IPv6 gravado corretamente; IPv6 não vai ao GreyNoise |
| CA-08 Quota/429 | ✅ | `worker.test.ts`: `Retry-After`/429 ⇒ `rate_limited` e circuito aberto (1 chamada para 3 IPs); quota diária respeitada; 5 falhas ⇒ circuito aberto |
| CA-09 Sem resultado em TI | ✅ | `shared.test.ts` + `worker.test.ts`: `no_data` ≠ seguro; sem fontes ⇒ `not_evaluated` (score `null`, nunca 0) |
| CA-10 Score alto explicado | ✅ | `worker.test.ts`: score 80 com regras/pesos/fontes/versão em `risk_assessments` e alerta com evidências; UI exibe tabela de evidências |
| CA-11 Tor/VPN só contexto | ✅ | `shared.test.ts` e `worker.test.ts`: saída Tor ⇒ 0 ponto, sem alerta |
| CA-12 Login/MFA incorretos | ✅ | `api.test.ts`/`security.test.ts`: 401 sem sessão/cookie, bloqueio de conta, limite de taxa 429, auditoria sem credenciais, TOTP inválido e *replay* rejeitados |
| CA-13 Logout | ✅🧪 | `api.test.ts` e E2E: sessão revogada ⇒ 401 |
| CA-14 Link expirado/desativado | ✅ | `api.test.ts`: 404 idêntico para inexistente/desativado/expirado/removido, sem `Location` e sem vazar destino; cache invalidado ao desativar |
| CA-15 CR/LF e tokens | ✅ | `shared.test.ts` (sanitização), `api.test.ts` (UA truncado, cookie/Authorization não persistidos, logs sem IP/slug/query), `security.test.ts` (conexão TCP real: byte de controle ⇒ 400; cabeçalhos injetados não são persistidos; 431) |
| CA-16 Expurgo de 30 dias | ✅ | `worker.test.ts`: remove eventos, avaliações, alertas com IP e cache de IP; preserva recentes; 12.001 linhas em lotes |
| CA-17 Exportação | ✅🧪 | `api.test.ts` (reauth, TTL ≈ 30 min, auditoria, `409` até pronta) · `worker.test.ts` (filtros, máscara de IP, CSV injection) · E2E: gerada pelo worker, baixada, IP mascarado `/24`, auditada |
| CA-18 Restore de backup antigo | ✅🧪 | `worker.test.ts` + execução real de `restore.sh`: expurgo antes de liberar consultas (2460 → 2455 eventos; vencidos 5 → 0) |
| CA-19 Reinício dos contêineres | 🧪 | E2E: `restart api worker`, dados e sessão preservados, link continua redirecionando; stop/start de Redis/Postgres (revelou e corrigiu falta de `DAC_OVERRIDE` no Redis) |
| CA-20 SSRF e open redirect | ✅ | `shared.test.ts` (esquemas/hosts/IPs numéricos), `api.test.ts` (destinos maliciosos 400), `security.test.ts` (query/path nunca mudam o `Location`; destino adulterado no banco é revalidado ⇒ 404); `providers.test.ts` (RDAP host fixo, sem redirect, sem IP privado) |
| CA-21 HEAD/previews | ✅ | `shared.test.ts` e `api.test.ts`: HEAD, prévias e robôs fora de "visitas estimadas"; UI e API usam o termo "estimadas" |
| CA-22 Go-live jurídico | ⚠️ | **Trava implementada e testada** (produção não inicia sem `LEGAL_REVIEW_ACKNOWLEDGED=true`; verificada no contêiner). A **decisão jurídica em si está PENDENTE** e é responsabilidade do controlador — ver [privacy-retention.md](privacy-retention.md) |

## Desempenho (15.1) — medido, ambiente de desenvolvimento

Carga pela cadeia real (Caddy→API→Postgres), 20 s por etapa, 1 IP de origem, `tests/load/redirect-load.mjs`:

| Taxa | Respostas 302 | Erros | p50 / p95 / p99 **cliente** | p50 / p95 / p99 **interno** (handler) |
|---|---|---|---|---|
| 10 req/s | 200/200 | 0 | 5,4 / 7,2 / 14,2 ms | 2,6 / 3,9 / 11,3 ms |
| 25 req/s | 500/500 | 0 | 4,3 / 6,1 / 8,8 ms | 2,4 / 3,4 / 5,4 ms |
| 50 req/s | 1000/1000 | 0 | 3,3 / 4,3 / 7,0 ms | 1,9 / 3,0 / 4,8 ms |

CPU da API ≤ 3,5 %, RAM API ≈ 47 MiB, Postgres ≈ 43 MiB, outbox drenada (0 pendentes). **Meta p95 ≤ 250 ms: atendida com folga neste ambiente.** Isso **não** é garantia de capacidade na VPS: repita na VPS de referência. Achado durante a medição: um limite inicial de 600 req/min/IP gerava 429 para um único IP; passou a ser configurável (padrão 1200).

## Não verificado / pendente (seja explícito antes de produção)

- ⚠️ **Decisão jurídica** (art. 15 Marco Civil; base legal; transferência internacional) — bloqueante.
- ⚠️ **AbuseIPDB, GreyNoise, RDAP real e GeoLite2 reais** — contratos testados com respostas HTTP simuladas (somente em testes); sem chaves/licenças no ambiente. Validar em staging com credenciais.
- ⚠️ **TLS/ACME (Let's Encrypt)** e IP real de visitantes vindos da Internet — testado apenas em HTTP local; o IP visto foi o gateway do Docker (`172.30.0.1`), como esperado nessa topologia.
- ⚠️ **Atualização da lista Tor** foi exercitada com listas simuladas e o worker tenta a URL real ao iniciar; o painel local mostrou "Pronto", mas confirme o conteúdo na sua rede.
- ⚠️ **Instância única** de API (cache de links em memória) e **sem ESLint**; **sem troca de senha pelo painel**; **armazenamento legal de 6 meses não implementado** (depende da decisão jurídica).
- ⚠️ Teste de penetração independente não realizado.

## Checklist de homologação e produção

- [ ] DNS dos dois domínios apontando para a VPS; portas 80/443 abertas; SSH restrito
- [ ] `.env` com segredos fortes (sem `CHANGE_ME`), `chmod 600`; backup da `TOTP_ENCRYPTION_KEY` em cofre
- [ ] Decisão jurídica registrada; só então `LEGAL_REVIEW_ACKNOWLEDGED=true`
- [ ] `/privacy` revisado (controlador, contato, finalidades) e divulgado onde os links circulam
- [ ] Admin criado pelo CLI; TOTP cadastrado; códigos de recuperação guardados
- [ ] `smoke-test.sh` aprovado; IP de teste de rede externa aparece corretamente no painel
- [ ] Provedores TI habilitados com chaves próprias, termos/cotas conferidos; GeoLite2 com atribuição
- [ ] Cron de `backup.sh`; **teste de restauração** executado; cópias fora do servidor com retenção de 30 dias
- [ ] `docker compose ps` saudável; alertas `worker_down`/`capture_failure` ausentes
- [ ] `npm audit` e atualização de imagens por digest; teste de carga na VPS de referência

## Como reproduzir

```bash
# pré-requisitos de teste
docker compose -f docker-compose.test.yml up -d --wait
npm install && npm run ci

# E2E e carga exigem o stack rodando e um admin de TESTE (nunca use credenciais reais)
docker compose up -d --build
docker compose run --rm -e ADMIN_EMAIL=admin@example.org -e ADMIN_PASSWORD='<senha-de-teste>' api node apps/api/src/cli/bootstrap-admin.ts
E2E_TOTP_SECRET=<segredo exibido> E2E_PASSWORD='<senha-de-teste>' E2E_PORT=<HTTP_PORT> npm run test:e2e
E2E_TOTP_SECRET=... E2E_PASSWORD=... npm run test:load
```

## Versão 0.2 — multiusuário, cadastro público e túnel

| Item | Resultado | Evidência |
|---|---|---|
| Isolamento entre usuários (links, eventos, IPs, painel, alertas, exportações) | ✅ | `multiuser.test.ts` |
| Cadastro `open`/`approval`/`closed`, termos, senha forte, limite por IP, papel não escalável | ✅ | `multiuser.test.ts` |
| Cotas, laço de redirect bloqueado, raiz do domínio de links redireciona ao painel | ✅ | `multiuser.test.ts` |
| Senha temporária + troca obrigatória + aceite de Termos; reset revoga sessões | ✅ | `multiuser.test.ts` |
| Suspensão revoga sessões e desativa links; dono não reativa link moderado | ✅ | `multiuser.test.ts` |
| Exclusão (admin e própria conta) apaga links/eventos/alertas | ✅ | `multiuser.test.ts` |
| Denúncia pública sem IP + moderação | ✅ | `multiuser.test.ts` |
| Migration 002 sobre banco existente (admin vira dono dos links) | 🧪 | stack local migrado, 3 links com dono |
| Cloudflare Tunnel: IP real só do contêiner do túnel; cabeçalho forjado descartado | 🧪✅ | E2E + execução manual |
| Telas (cadastro, login de usuário, painel limitado, Usuários) | 🧪 | verificado no navegador |
| **Publicação em iplogger.com.br** | ⚠️ pendente | exige token do túnel na Cloudflare e decisão jurídica (`LEGAL_REVIEW_ACKNOWLEDGED`) |
| Verificação de e-mail / CAPTCHA / MFA para usuários | ⚠️ não implementado | — |

## Versão 0.3 — ferramentas

| Item | Resultado | Evidência |
|---|---|---|
| Ferramentas exigem login; usuários comuns têm acesso | ✅ | `tools.test.ts` |
| Consulta de IP: nada externo para IP não público; RDAP sob demanda com cache; sem vazar inteligência de terceiros | ✅ | `tools.test.ts` |
| WHOIS/RDAP de domínio e IP (sem contatos pessoais; 502 sem detalhes internos; 503 se desabilitado) | ✅ | `tools.test.ts`, `tools-real-transport.test.ts`, `providers.test.ts` |
| RDAP segue o redirecionamento do `rdap.org` com validação por salto | ✅🧪 | testes + consulta real a 8.8.8.8 e registro.br (corrigiu um defeito: o cliente anterior não seguia redirecionamentos) |
| Fabricante por MAC (OUI 24/28/36 bits, MAC aleatório) | ✅ | `tools.test.ts` (40.349 prefixos) |
| Verificador de URL: cadeia, rebaixamento, laço, HEAD→GET, erros | ✅🧪 | `tools.test.ts`; real contra example.org e google.com |
| **SSRF** com o transporte real: loopback, metadados de nuvem, IPs numéricos, esquemas, portas 22/6379, credenciais | ✅ | `tools-real-transport.test.ts`, unidade de `guardedLookup`/`safeHop` |
| Notas privadas: leitura única atômica (8 leituras paralelas ⇒ 1), expiração, quota, cifragem no cliente | ✅ | `tools.test.ts`, `notecrypto.test.ts` |
| Telas das ferramentas | 🧪 | verificado no navegador (usuário comum) |
| Reputação AbuseIPDB/GreyNoise nas ferramentas | ⚠️ não exposta (decisão de privacidade/cota) | — |

## Produção — iplogger.com.br (2026-10-19)

Verificado pela Internet (via Cloudflare Tunnel), com `NODE_ENV=production`, `COOKIE_SECURE=true`, `SIGNUP_MODE=open`:

| Item | Resultado |
|---|---|
| TLS válido, HSTS, CSP, `nosniff`, `X-Frame-Options` no painel | ✅ |
| Login do admin com senha + TOTP; cookie `__Host-iplc_session; Secure; HttpOnly; SameSite=Strict` | ✅ |
| Link criado e aberto publicamente: `302`, `Cache-Control: no-store` | ✅ |
| IP registrado = IP real do visitante; `X-Forwarded-For` forjado ignorado | ✅ |
| `CF-Connecting-IP` forjado: bloqueado pela própria Cloudflare (erro 1000) antes de chegar à origem | ✅ |
| `/metrics`, `/readyz`, `/healthz`, `/api/v1/links` (no domínio de links) ⇒ 404; API sem sessão ⇒ 401 | ✅ |
| Raiz `iplogger.com.br/` redireciona ao painel; `/privacy` identifica o operador e o canal de contato | ✅ |
| Dados de teste removidos após a verificação | ✅ |

Pendências do operador: criar o encaminhamento `contato@iplogger.com.br` (Cloudflare Email Routing), girar o token do túnel (foi exposto no chat), e acompanhar a revisão jurídica descrita em [legal-decision.md](legal-decision.md).

## Versão 0.4 — domínios personalizados

| Item | Resultado | Evidência |
|---|---|---|
| Validação do hostname (IP, curinga, interno, hosts da plataforma, subdomínios da plataforma só pelo admin) e unicidade | ✅ | `domains.test.ts` |
| Verificação por TXT (ausente/errado/correto) e checagem de roteamento (ok, desafio errado, HTTP inesperado, falha de rede) | ✅ | `domains.test.ts` |
| Modos `admin`, `approval` e `open`; limite por usuário; aprovação só pelo admin; ativação exige propriedade verificada | ✅ | `domains.test.ts` |
| Mesmo slug em domínios diferentes; link só responde no seu domínio; pendente/desativado não serve nada (421) | ✅ | `domains.test.ts` |
| Endpoint de roteamento devolve só o hash do token e só para domínios cadastrados | ✅ | `domains.test.ts` |
| Desativar/reativar tem efeito imediato (cache invalidado); excluir exige remover links; suspender o dono desativa os domínios | ✅ | `domains.test.ts` |
| Raiz do domínio (404 ou redirecionamento validado), laço de redirecionamento bloqueado, denúncia por URL completa | ✅ | `domains.test.ts` |
| Migration 004 sobre dados reais de produção | ✅🧪 | aplicada no servidor sem perda de dados |
| Roteamento real pelo Caddy coringa em produção: domínio ativo ⇒ 302; host desconhecido ⇒ 421; rotas internas ⇒ 404; desativar ⇒ 421 | 🧪 | execução no servidor (domínio de teste removido) |
| Domínio real de ponta a ponta (TXT + rota do túnel + TLS Cloudflare) | ⚠️ pendente | depende de um domínio seu na mesma conta Cloudflare |
