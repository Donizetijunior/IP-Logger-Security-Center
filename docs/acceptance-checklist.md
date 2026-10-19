# Checklist de aceite (CA-01 … CA-22) — resultados verificados

Data da verificação: 2026-10-19 · Ambiente: Windows 11 + Docker Desktop (Linux containers), Node 24, PostgreSQL 17, Redis 7, Caddy 2. **Não** foi verificado em VPS Linux de produção, nem com chaves/bases reais de provedores.

Legenda: ✅ verificado por teste automatizado executado e aprovado · 🧪 verificado em execução manual do stack · ⚠️ parcial/pendente (explicado).

## Resumo das execuções

| Suíte | Comando | Resultado |
|---|---|---|
| Tipos (api, worker, shared, testes) + web | `npm run typecheck` / `npm run typecheck:web` | sem erros |
| Unitários, integração (Postgres/Redis reais), segurança | `npm test` | **159 aprovados** em 5 arquivos (shared 66 · API 40 · worker 25 · provedores 14 · segurança 14) |
| Build do painel | `npm run build:web` | ok (JS 315 kB / 98 kB gzip) |
| E2E no stack Compose (Caddy→API→Postgres/Redis/Worker) | `npx vitest run tests/e2e` | **12/12 aprovados**, incluindo quedas reais de Redis e Postgres |
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
