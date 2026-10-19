# IP Logger Security Center

Plataforma de links curtos com registro de acessos, enriquecimento assíncrono de IPs e dashboard de Cybersecurity / Threat Intelligence, para **investigação de segurança autorizada**. **Multiusuário**: cada pessoa vê somente os próprios links; um administrador gerencia usuários e moderação. Cadastro público configurável (`open` / `approval` / `closed`) — ver [docs/multiuser.md](docs/multiuser.md).

> **Status:** MVP implementado e testado (ver [checklist de aceite](docs/acceptance-checklist.md)). **Go-live bloqueado** até a decisão jurídica sobre guarda de registros de acesso (Lei 12.965/2014, art. 15) e a base legal de tratamento serem documentadas — ver [docs/privacy-retention.md](docs/privacy-retention.md). Em `NODE_ENV=production` a aplicação **recusa iniciar** sem `LEGAL_REVIEW_ACKNOWLEDGED=true`.

## O que faz

- Cria links curtos (`GET /{slug}` → **HTTP 302 imediato**, `Cache-Control: no-store`, sem página intermediária e sem JavaScript no destino).
- Registra cada requisição (IP, horário UTC, link, método, User-Agent/idioma saneados, origem do Referer) e a classifica como *provável usuário*, *robô*, *prévia de link* ou *sondagem HEAD* — **uma requisição não é um clique humano confirmado**.
- Enriquece **em background** (nunca no caminho do redirect): GeoLite2/ASN local, DNS reverso, lista de saídas Tor, AbuseIPDB e GreyNoise Community (opt-in), RDAP sob demanda.
- Calcula um **risk score explicável e versionado** (regra, peso, valor, fonte, horário) e gera alertas internos (somente no painel).
- Painel em pt-BR: visão geral, links, eventos com filtros, detalhe do evento, investigação de IP, alertas, saúde das integrações, auditoria.
- **Ferramentas** para usuários logados (meu IP/UA, consulta de IP, WHOIS/RDAP, fabricante por MAC, verificador de URL com proteção SSRF, notas privadas autodestrutivas, geradores): [docs/tools.md](docs/tools.md).
- **Contas:** cadastro público, Termos de Uso, troca/exclusão de conta, gestão de usuários pelo admin, cotas por conta e **denúncia pública de abuso** com moderação.
- Exporta CSV/JSON com reautenticação, IP mascarado por padrão, TTL curto e auditoria.
- Expurga automaticamente eventos identificáveis após **30 dias**.

## Arquitetura (resumo)

`Caddy (80/443)` → `API Fastify` / `Web estático` · `PostgreSQL` (dados + outbox transacional) · `Redis/BullMQ` (fila) · `Worker` (enriquecimento, alertas, expurgo, exportações). Detalhes e diagramas em [docs/architecture.md](docs/architecture.md).

## Início rápido (Docker Compose)

Pré-requisitos: Docker Engine 24+ com Compose v2, domínios apontando para a VPS (ou veja o modo local abaixo).

```bash
cp .env.example .env && chmod 600 .env     # preencha segredos e domínios
docker compose up -d --build
docker compose run --rm api node apps/api/src/cli/bootstrap-admin.ts   # cria o admin, exibe TOTP e códigos de recuperação UMA vez
./infra/scripts/smoke-test.sh
```

Guia completo (TLS, GeoLite2, backups, atualização): [docs/deployment.md](docs/deployment.md). Operação: [docs/operations.md](docs/operations.md).

### Modo local de teste (sem DNS)

Use `NODE_ENV=development`, `LINKS_SITE=http://links.localhost`, `PANEL_SITE=http://painel.localhost`, `HTTP_PORT=18088` e `PUBLIC_*_URL=http://{links,painel}.localhost:18088`. O painel abre em `http://painel.localhost:18088`.

## Desenvolvimento

Requer Node.js ≥ 24 (executa TypeScript nativamente) e Docker para as dependências de teste.

```bash
npm install
docker compose -f docker-compose.test.yml up -d --wait   # Postgres :55432 e Redis :56379 efêmeros
npm run ci            # typecheck (api/worker/shared + web), testes unitários/integração/segurança, build do painel
npm run dev:web       # painel em http://localhost:5173 (proxy /api -> :3000)
```

Testes E2E contra o stack Compose em execução e carga: veja [docs/acceptance-checklist.md](docs/acceptance-checklist.md#como-reproduzir).

## Estrutura

```
apps/api      Fastify: redirect, REST administrativa, privacidade
apps/worker   BullMQ: outbox, enriquecimento, risco, alertas, expurgo, exportações
apps/web      React + Vite + Tailwind (pt-BR)
packages/shared    Config, IP/URL/sanitização, classificação de cliente, motor de risco
packages/database  Migrations SQL, pool e utilitários
infra/        Caddyfile e scripts (backup, restore, smoke-test)
tests/        integration, security, e2e, load
docs/         arquitetura, API (OpenAPI), TI, risco, privacidade, operação, ADRs
```

## Código aberto

Veja [docs/open-source.md](docs/open-source.md) (escolha de licença, o que nunca versionar e como proteger o serviço hospedado).

## Limitações conhecidas (leia antes de usar)

- Geolocalização e reputação referem-se ao **endereço de rede** (NAT/VPN/CGNAT), não a uma pessoa.
- Adaptadores AbuseIPDB/GreyNoise e GeoLite2 foram validados **apenas com simulações HTTP / sem bases reais** (não havia chaves); valide com credenciais próprias antes de depender deles ([docs/threat-intelligence.md](docs/threat-intelligence.md)).
- Instância única de API (cache de links em memória). Para escalar horizontalmente é preciso invalidar o cache de forma compartilhada.
- O cadastro `open` **não verifica e-mail** (sem SMTP) e não há CAPTCHA: leia o aviso de abuso em [docs/multiuser.md](docs/multiuser.md#risco-de-abuso-leitura-obrigatória-antes-de-abrir-ao-público).
- Medições de desempenho foram feitas em Docker Desktop (Windows), não na VPS de referência.
