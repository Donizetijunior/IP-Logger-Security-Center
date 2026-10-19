# Segurança

## Reportar vulnerabilidades

Não abra issue pública. Envie os detalhes (passos, impacto, versão) ao responsável pelo projeto por canal privado e aguarde confirmação antes de divulgar.

## Modelo de ameaças e controles

| Ameaça | Controle |
|---|---|
| Falsificação do IP do visitante | `X-Forwarded-For` só é aceito de proxy explicitamente confiável (IP fixo do Caddy); o Caddy sobrescreve o header; cadeia lida da direita para a esquerda; testes de spoofing direto e via proxy |
| Força bruta / roubo de credenciais | Argon2id (19 MiB, t=2), bloqueio de conta (5 falhas ⇒ 15 min), limite 10/min/IP, tempo constante para e-mail inexistente, MFA TOTP obrigatório com proteção contra *replay*, códigos de recuperação hasheados e de uso único |
| Sequestro de sessão / CSRF | Token opaco aleatório (apenas o hash fica no banco), cookie `HttpOnly`, `SameSite=Strict`, `Secure` + `__Host-` em produção, expiração absoluta 8 h e ociosa 2 h, token CSRF por sessão + checagem de `Origin`, revogação no logout |
| Open redirect / SSRF | Destino só definido pelo admin, validado por *parsing* (esquema http/https, sem credenciais, sem localhost/IPs privados) e **revalidado antes de cada redirect**; allowlist opcional (`ALLOWED_TARGET_DOMAINS`); o sistema **nunca busca** o destino; RDAP usa host fixo e IP público validado, sem seguir redirects |
| Injeção SQL | Todas as consultas parametrizadas; filtros montados com placeholders; testes com payloads hostis |
| Log injection / vazamento em logs | Cabeçalhos saneados (controles/CR/LF removidos, truncados), allowlist de campos; logs não incluem IP, slug, query, cabeçalhos ou cookies |
| XSS | SPA React (escape por padrão), CSP restritiva no painel, `/privacy` com escape e CSP `default-src 'none'` |
| Exposição de serviços internos | Apenas Caddy publica portas; Postgres/Redis só na rede Docker; `/metrics`, `/readyz`, `/healthz` bloqueados no Caddy e recusados via proxy |
| Vazamento de segredos | Segredos em `.env` (600) ou `*_FILE`; valores `CHANGE_ME` rejeitados em produção; chaves de API e TOTP nunca retornam pela API (testado); segredo TOTP cifrado com AES-256-GCM |
| Abuso de volume | Rate limit por IP no redirect (generoso, configurável); telemetria de bloqueios sem PII |
| Falha de dependências | *Fail-open* do redirect com métrica e alerta; outbox transacional; circuit breaker nos provedores |
| Injeção em exportações | Neutralização de fórmulas CSV (`=`, `+`, `-`, `@`), IP mascarado por padrão, reautenticação, TTL e auditoria |

## Endurecimento de contêineres

Usuário não-root (API/worker/web), `no-new-privileges`, `cap_drop: ALL` com adições mínimas e justificadas, sistema de arquivos `read_only` + `tmpfs`, limites de recursos, healthchecks, imagens por *digest*, logs com rotação.

## Fora de escopo (por desenho)

Sem coleta oculta, *fingerprinting*, varredura ativa de visitantes, bloqueio automático por score ou denúncia automática a provedores.

## Pendências de segurança conhecidas

- Troca de senha/rotação do admin pelo painel não existe no MVP (procedimento manual em [docs/operations.md](docs/operations.md)).
- O token CSRF é armazenado em texto na sessão (não é segredo contra o banco; o cookie de sessão é guardado apenas em hash).
- Execute `npm audit` e atualize imagens periodicamente; faça um *pentest* independente antes de operar com dados reais.
