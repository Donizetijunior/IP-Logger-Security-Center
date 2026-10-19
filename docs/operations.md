# Operação

## Observabilidade

| Fonte | O que mostra | Onde |
|---|---|---|
| `GET /healthz` | Liveness da API (sem credenciais) | Healthcheck do Docker; **não** exposto pelo Caddy |
| `GET /readyz` | Readiness (consulta o Postgres) | Só rede interna (recusa conexões via proxy/IP público) |
| `GET /metrics` | Contadores e p50/p95/p99 do redirect, sem PII | Só rede interna: `docker compose exec api wget -qO- http://127.0.0.1:3000/metrics` |
| Painel → *Visão geral* | Telemetria perdida, worker sem sinal, KPIs | `/` |
| Painel → *Configurações e saúde* | Fila, outbox, cotas, circuitos, GeoIP/Tor, último expurgo, auditoria | `/configuracoes` |
| Alertas internos | `capture_failure`, `outbox_lag`, `queue_stuck`, `worker_down`, `provider_*`, `storage_critical` | `/alertas` |

Logs são JSON em stdout com rotação (`json-file`, 10 MB × 5). **Não contêm** IP, slug, query string, cabeçalhos, cookies ou tokens; a rota é registrada como padrão (`/:slug`). IPs ficam apenas no banco.

`DB_SIZE_ALERT_BYTES` (padrão 10 GiB) e `DISK_CHECK_PATH` (padrão `/`) ajustam o alerta de armazenamento do worker. Não há notificações externas no MVP: acompanhe o painel (e o monitor externo de sua escolha sobre `https://links…/privacy` para disponibilidade).

## Backup e restauração

- **Backup diário automático:** o cron do servidor roda `infra/scripts/backup.sh` às **03:30 UTC** (00:30 em Brasília): `pg_dump -Fc` criptografado com AES-256 (PBKDF2), `sha256`, permissão `600` e **exclusão de cópias com mais de 14 dias**. Destino: `~/iplogger-backups`; log em `backup.log` na mesma pasta.
- **Trava de disco:** o backup **aborta** (código 2) se o destino tiver menos de `BACKUP_MIN_FREE_GB` (padrão 5 GB) livres, para nunca encher o disco de um servidor compartilhado com outros projetos.
- **Tamanho:** ~43–150 bytes por evento comprimido; ~600 bytes por evento no banco (medido com 100 mil eventos). Até ~100 mil acessos/dia os 14 backups ocupam ~6 GB.
- **Chave:** `~/.iplogger-backup.key` (permissão 600) no servidor **e uma cópia fora dele** (guarde em gerenciador de senhas). Sem a chave os backups são irrecuperáveis; com a chave e o arquivo qualquer pessoa os abre — trate os dois como segredos.
- **Cópia fora do servidor:** os backups ficam no mesmo disco do banco, então **não protegem contra perda do servidor**. Copie periodicamente `~/iplogger-backups` para outro lugar (ex.: `scp`/`rsync` para seu computador), respeitando a retenção.
- **Verificar um backup sem tocar na produção:** `BACKUP_KEY_FILE=... BACKUP_DIR=... ./infra/scripts/verify-backup.sh` descriptografa, confere o hash, restaura em um banco temporário `iplogger_verify`, compara contagens e o remove. Rode após mudanças no esquema e ao menos uma vez por mês.
- **RPO** alvo: 24 h. **RTO** alvo: < 1 h.
- **Restauração**: `BACKUP_KEY_FILE=… ./infra/scripts/restore.sh <arquivo.dump.enc>`. Verifica o hash, **para api/worker/caddy**, restaura, **executa o expurgo de retenção antes de reabrir as consultas** (CA-18) e só então sobe os serviços.
- Os scripts leem o `.env` sem executá-lo (valores com espaços/parênteses são válidos para o Docker e quebrariam um `source`).

## Reprocessar eventos (ex.: depois de instalar a geolocalização)

Eventos antigos não ganham local sozinhos. Para reenfileirar os dos últimos 30 dias que ainda estão sem país: `docker compose exec -T postgres psql -U iplogger -d iplogger -c "insert into outbox_events (aggregate_id, type) select id, 'access_event.enrich' from access_events where country is null and occurred_at > now() - interval '30 days'"`. O worker processa em segundos e o resultado é idempotente.

## Expurgo (retenção de 30 dias)

Roda no worker diariamente (e na inicialização se a última execução passou de 23 h), em lotes de 5000. Remove: eventos > 30 dias e suas avaliações; alertas com IP; cache de inteligência vencido ou sem evento associado ao IP; exportações expiradas; outbox publicada > 7 dias; desafios/sessões vencidos; auditoria > `AUDIT_RETENTION_DAYS`. Execução manual: `docker compose run --rm --no-deps worker node apps/worker/src/cli/purge.ts`. Último resultado no painel.

## Rotação de credenciais

| Item | Procedimento |
|---|---|
| Senha do admin | Hoje: recriar a conta — `DELETE FROM admins` (SQL; remove sessões e códigos em cascata), rodar o bootstrap de novo e guardar novos TOTP/códigos. A auditoria é preservada. (Troca de senha pelo painel não faz parte do MVP.) |
| Chaves de API (AbuseIPDB/GreyNoise/MaxMind) | Editar `.env` e `docker compose up -d worker`. Revogue a chave antiga no provedor. |
| `POSTGRES_PASSWORD` | `ALTER USER` no banco, atualizar `.env`, `docker compose up -d`. |
| `REDIS_PASSWORD` | Atualizar `.env` e `docker compose up -d` (a fila é reidratada pela outbox). |
| `TOTP_ENCRYPTION_KEY` | Exige recriar o admin (o segredo TOTP é cifrado com ela). |

## Gestão de usuários e moderação

Veja [multiuser.md](multiuser.md). Rotina sugerida: revisar *Denúncias* e *Usuários → Aguardando aprovação* diariamente; ao receber uma denúncia procedente, **desativar o link e suspender o dono**; para pedidos de exclusão de titulares, o usuário pode excluir a própria conta ou o admin usar *Excluir* em *Usuários*.

## Resposta a incidentes (resumo)

1. **Suspeita de acesso indevido ao painel:** `UPDATE admin_sessions SET revoked_at = now()` (revoga todas), troque a senha (recriar admin), revise `/configuracoes → Auditoria`.
2. **Vazamento de chave de API:** revogue no provedor, gere nova, atualize `.env`.
3. **Perda de telemetria (alerta `capture_failure`):** verifique `docker compose ps`, logs do Postgres, disco. O redirect segue (fail-open); eventos do período **não são recuperáveis**.
4. **Dado pessoal solicitado por titular:** pesquise por IP em *Eventos*/*Investigação de IP*; exclusão antecipada é um `DELETE` manual por IP (documente na auditoria) — respeitando obrigações legais de guarda.
5. **Fila travada / worker parado:** `docker compose logs worker`, `docker compose restart worker`; a outbox reenfileira o que estava pendente.

## Investigar falhas de captura

`capture_failed` (métrica `iplogger_capture_failed_total` e tabela `telemetry_counters`) conta redirects em que a gravação do evento falhou ou excedeu `REDIRECT_DB_TIMEOUT_MS` (400 ms). Causas comuns: Postgres indisponível/saturado, IP do cliente não resolvido. Com o banco fora, links já em cache seguem redirecionando por até `LINK_CACHE_STALE_MS` (1 h); links ainda não vistos retornam `503`.

## Fail-open (política documentada)

O redirect é considerado mais importante que a telemetria: se o PostgreSQL falhar, a API redireciona usando o cache de links e **contabiliza** a perda. **Não há garantia de retenção** de eventos nessa janela. O painel e o alerta `capture_failure` tornam a perda visível.

## Limites e escala

Instância única de API/worker. Concorrência do worker: 4 jobs. Limite de taxa do redirect: `REDIRECT_RATE_LIMIT_PER_MIN` por IP (padrão 1200). Para escalar a API horizontalmente é preciso substituir o cache de links em memória por invalidação compartilhada (Redis pub/sub).
