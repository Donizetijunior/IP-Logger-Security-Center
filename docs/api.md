# API — exemplos

Especificação completa: [openapi.yaml](openapi.yaml) (OpenAPI 3.1). Abaixo, exemplos com `curl` (substitua os domínios). Em produção o cookie chama-se `__Host-iplc_session`.

```bash
PAINEL=https://painel.exemplo.com
LINKS=https://links.exemplo.com
JAR=$(mktemp)

# 1) Login (senha) -> desafio
CH=$(curl -s -c $JAR -H 'content-type: application/json' \
  -d '{"email":"admin@exemplo.com","password":"********"}' $PAINEL/api/v1/auth/login | jq -r .challenge)

# 2) MFA (TOTP de 6 dígitos ou código de recuperação) -> cookie de sessão + csrfToken
CSRF=$(curl -s -b $JAR -c $JAR -H 'content-type: application/json' \
  -d "{\"challenge\":\"$CH\",\"code\":\"123456\"}" $PAINEL/api/v1/auth/totp/verify | jq -r .csrfToken)

# 3) Criar link
curl -s -b $JAR -H "x-csrf-token: $CSRF" -H 'content-type: application/json' \
  -d '{"slug":"campanha-a1","label":"Monitoramento de campanha autorizada","targetUrl":"https://exemplo.org/recurso","expiresAt":null}' \
  $PAINEL/api/v1/links

# 4) Visitar o link (HTTP 302 imediato)
curl -si $LINKS/campanha-a1 | head -5

# 5) Eventos filtrados (paginação por cursor)
curl -s -b $JAR "$PAINEL/api/v1/events?clientClass=human_probable&riskLevel=high&limit=50"

# 6) Investigar um IP (com RDAP sob demanda)
curl -s -b $JAR "$PAINEL/api/v1/ips/203.0.113.42?rdap=true"

# 7) Exportar (exige reautenticação recente; IP mascarado por padrão)
curl -s -b $JAR -H "x-csrf-token: $CSRF" -H 'content-type: application/json' -d '{"password":"********"}' $PAINEL/api/v1/auth/reauth
curl -s -b $JAR -H "x-csrf-token: $CSRF" -H 'content-type: application/json' \
  -d '{"format":"csv","filters":{"from":"2026-10-01T00:00:00Z"},"fullIp":false}' $PAINEL/api/v1/exports
curl -s -b $JAR -OJ $PAINEL/api/v1/exports/<id>/download
```

## Convenções

- **Erros:** `{"error":{"code","message","details?"}}`; `400` validação, `401` sem sessão, `403` CSRF/origem/reauth, `404`, `409` conflito, `413` corpo > 64 KB, `429` limite de taxa, `500` genérico (sem stack).
- **Autenticação:** cookie `HttpOnly; SameSite=Strict` (+ `Secure`/`__Host-` em produção). Mutações exigem `X-CSRF-Token` e, se houver, `Origin` igual ao painel. Não há CORS.
- **Limites:** login 10/min/IP e bloqueio de conta por 15 min após 5 falhas; redirect `REDIRECT_RATE_LIMIT_PER_MIN`/IP.
- **Respostas nunca contêm:** segredos TOTP, chaves de API, hashes de senha, stack traces.
