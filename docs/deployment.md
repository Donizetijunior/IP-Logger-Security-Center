# Implantação

## 1. Pré-requisitos

- VPS Linux atualizada. Referência inicial de dimensionamento: **2 vCPU, 4 GB RAM, SSD 40 GB** (a validar por carga real; nas medições locais a API usou ~45 MB e o Postgres ~40 MB em repouso).
- Docker Engine ≥ 24 com Compose v2; `openssl`, `bash`, `curl` no host (scripts de backup/smoke).
- Dois registros DNS (A/AAAA) para a VPS: um para os **links** (`links.exemplo.com`) e outro para o **painel** (`painel.exemplo.com`).
- Firewall: liberar apenas 80/443 (e SSH restrito por origem). PostgreSQL e Redis **não** publicam portas — o Compose não os expõe.

## 2. Configuração

```bash
git clone <repo> iplogger && cd iplogger
cp .env.example .env && chmod 600 .env
```

Preencha no `.env`:

| Variável | Observação |
|---|---|
| `LINKS_SITE`, `PANEL_SITE` | Nomes de domínio (o Caddy emite/renova TLS Let's Encrypt automaticamente). |
| `PUBLIC_SHORT_BASE_URL`, `PUBLIC_DASHBOARD_URL` | URLs `https://…` correspondentes (a API valida o cabeçalho `Host` contra elas). |
| `ACME_EMAIL` | E-mail para o Let's Encrypt. |
| `POSTGRES_PASSWORD`, `REDIS_PASSWORD` | Gere com `openssl rand -base64 36`. |
| `SESSION_SECRET` (≥ 32) | Reservado; exigido pela validação de configuração (as sessões usam tokens opacos hasheados no banco). |
| `TOTP_ENCRYPTION_KEY` | `openssl rand -hex 32`. **Perdê-la invalida o MFA do admin** — guarde-a no cofre de segredos. |
| `ABUSEIPDB_*`, `GREYNOISE_*`, `GEOLITE2_ENABLED`, `MAXMIND_*` | Opt-in. Veja [threat-intelligence.md](threat-intelligence.md). |
| `LEGAL_REVIEW_ACKNOWLEDGED` | Só `true` após a decisão jurídica documentada. |
| `PRIVACY_CONTROLLER_NAME`, `PRIVACY_CONTACT_EMAIL` | Aparecem em `/privacy`. |

Valores `CHANGE_ME…` são **rejeitados** em produção. Para segredos fora do `.env`, a aplicação aceita `NOME_FILE` (ex.: `DATABASE_URL_FILE=/run/secrets/db_url`) para `DATABASE_URL`, `SESSION_SECRET`, `TOTP_ENCRYPTION_KEY`, `ABUSEIPDB_API_KEY` e `GREYNOISE_API_KEY`.

## 3. Subir e criar o administrador

```bash
docker compose up -d --build
docker compose run --rm api node apps/api/src/cli/bootstrap-admin.ts
```

O comando pede e-mail e senha (≥ 12 caracteres, 3 classes de caracteres), cria **a única conta ativa**, e imprime **uma única vez** o segredo/URI TOTP e 10 códigos de recuperação. Cadastre o TOTP no autenticador e guarde os códigos. O MFA é confirmado no primeiro login. Não existe cadastro remoto; um segundo admin ativo é recusado pelo banco.

## 4. GeoLite2 (opcional)

1. Crie conta MaxMind, aceite o EULA e gere `MAXMIND_ACCOUNT_ID`/`MAXMIND_LICENSE_KEY`.
2. `GEOLITE2_ENABLED=true` no `.env`, depois `docker compose --profile geoip up -d geoipupdate worker`.
3. O worker recarrega as bases a cada hora (mantém a anterior se a nova for inválida). Estado em *Configurações e saúde*.

Atribuição obrigatória: *Este produto inclui dados GeoLite2 criados pela MaxMind (https://www.maxmind.com)* — já exibida no painel e em [NOTICE.md](../NOTICE.md).

## 5. Verificação

```bash
./infra/scripts/smoke-test.sh      # saúde, portas não publicadas, 404/401 corretos, cabeçalhos
```

Confirme também, após o primeiro tráfego real, que o IP registrado é o do visitante (e não o do Caddy/gateway): crie um link, abra-o de uma rede externa e veja o evento no painel. Se o IP for interno, `TRUSTED_PROXY_CIDRS`/`IPLC_CADDY_IP` estão errados.

## 6. Atualização

```bash
git pull && docker compose build && docker compose up -d      # migrations rodam na inicialização (lock consultivo)
./infra/scripts/smoke-test.sh
```

Imagens-base estão fixadas por **digest** no `Dockerfile` e no `docker-compose.yml`. Para atualizá-las: `docker pull <imagem>`, copie o novo digest (`docker image inspect --format '{{index .RepoDigests 0}}'`), rode os testes e o smoke test. Reveja `npm audit` periodicamente.

## 7. Rollback

`docker compose down` não apaga volumes. Para voltar a uma versão anterior do código: `git checkout <tag>`, `docker compose up -d --build`. Migrations são aditivas; para reverter dados use [backup/restore](operations.md#backup-e-restauração).

## 8. Atrás de CDN / balanceador

O desenho assume Caddy como único proxy. Se colocar um CDN/LB na frente, **o IP do visitante passa a vir em outro cabeçalho** e o Caddy verá o IP do CDN: configure `trusted_proxies` do Caddy para as faixas oficiais do CDN, repasse o IP real em `X-Forwarded-For` e **repita os testes de spoofing** (`tests/e2e`, CA-06). Não adicione CIDRs genéricos a `TRUSTED_PROXY_CIDRS`.

## 9. Checklist de produção

Veja [acceptance-checklist.md](acceptance-checklist.md#checklist-de-homologação-e-produção).

## 10. Publicar com domínio próprio via Cloudflare Tunnel (ex.: iplogger.com.br)

Para servidores com IP privado/CGNAT ou sem portas liberadas. A Cloudflare termina o TLS e o contêiner `cloudflared` leva o tráfego ao Caddy; **nenhuma porta é aberta no roteador**.

1. **Domínio na Cloudflare:** adicione `iplogger.com.br` à sua conta e aponte os *nameservers* do registro.br para os da Cloudflare.
2. **Túnel:** *Zero Trust → Networks → Tunnels → Create* (tipo Cloudflared). Copie o **token**.
3. **Hostnames públicos** do túnel (ambos para o serviço **HTTP** `caddy:80`):
   - `iplogger.com.br` → links curtos (`https://iplogger.com.br/<slug>`; a raiz redireciona para o painel)
   - `painel.iplogger.com.br` → painel (login, cadastro, termos, denúncias)
4. **`.env`** (no servidor):
   ```dotenv
   LINKS_SITE=http://iplogger.com.br
   PANEL_SITE=http://painel.iplogger.com.br
   PUBLIC_SHORT_BASE_URL=https://iplogger.com.br
   PUBLIC_DASHBOARD_URL=https://painel.iplogger.com.br
   COOKIE_SECURE=true
   CLOUDFLARE_TUNNEL_TOKEN=<token>
   SIGNUP_MODE=approval        # open | approval | closed (ver docs/multiuser.md)
   NODE_ENV=production
   LEGAL_REVIEW_ACKNOWLEDGED=true   # SOMENTE após a decisão jurídica documentada
   ```
5. **Subir:** `docker compose --profile tunnel up -d --build`
6. **Verificar o IP real do visitante:** abra um link de fora da sua rede e confira o IP no painel. O Caddy só confia no cabeçalho `CF-Connecting-IP` quando a conexão vem do contêiner `cloudflared` (IP fixo `IPLC_TUNNEL_IP`); de qualquer outra origem o cabeçalho é descartado (testado em `tests/e2e`).

Notas: use *SSL/TLS = Full* e ative HSTS na Cloudflare se desejar; a Cloudflare passa a ver o tráfego (considere isso na avaliação de privacidade/transferência internacional). Para acesso direto por LAN durante testes, use `curl -H "Host: …"`.
