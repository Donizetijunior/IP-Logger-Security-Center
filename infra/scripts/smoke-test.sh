#!/usr/bin/env bash
# Smoke test de deploy. Requer o stack em execução e uma sessão de admin só para o passo opcional.
#   LINKS_URL / PANEL_URL  (padrão: PUBLIC_SHORT_BASE_URL / PUBLIC_DASHBOARD_URL do .env)
#   CONNECT_TO  IP para onde apontar os domínios de teste (padrão 127.0.0.1)
# Verifica: Postgres/Redis NÃO publicados, healthchecks, headers, 404 consistente, painel e /privacy.
# O teste de spoofing de X-Forwarded-For pela cadeia real está em tests/e2e/stack.test.ts (CA-06).
set -uo pipefail

cd "$(dirname "$0")/../.."
set -a; [ -f .env ] && . ./.env; set +a
LINKS_URL="${LINKS_URL:-${PUBLIC_SHORT_BASE_URL:-http://links.localhost:8088}}"
PANEL_URL="${PANEL_URL:-${PUBLIC_DASHBOARD_URL:-http://painel.localhost:8088}}"
CONNECT_TO="${CONNECT_TO:-127.0.0.1}"
fail=0
ok()   { printf '  [OK]   %s\n' "$1"; }
bad()  { printf '  [FALHA] %s\n' "$1"; fail=1; }

host_of() { echo "$1" | sed -E 's#^https?://##; s#/.*$##'; }
port_of() { local h; h="$(host_of "$1")"; case "$h" in *:*) echo "${h##*:}";; *) case "$1" in https*) echo 443;; *) echo 80;; esac;; esac; }
curl_resolve() { # $1 url ; resto = args do curl
  local url="$1"; shift
  local h; h="$(host_of "$url" | sed 's/:.*//')"
  curl -sS --max-time 10 --resolve "$h:$(port_of "$url"):$CONNECT_TO" "$@" "$url"
}

echo "1) Contêineres saudáveis"
for s in caddy api web worker postgres redis; do
  st="$(docker compose ps --format '{{.Service}} {{.Health}} {{.State}}' 2>/dev/null | awk -v s="$s" '$1==s{print $2" "$3}')"
  case "$st" in *healthy*|*running*) ok "$s: $st";; *) bad "$s: ${st:-ausente}";; esac
done

echo "2) PostgreSQL e Redis não publicados no host"
for s in postgres redis; do
  pub="$(docker compose port "$s" "$([ "$s" = postgres ] && echo 5432 || echo 6379)" 2>/dev/null || true)"
  case "$pub" in ""|:0|0.0.0.0:0) pub="";; esac
  [ -z "$pub" ] && ok "$s sem porta publicada" || bad "$s publicado em $pub"
done

echo "3) Domínio de links"
code="$(curl_resolve "$LINKS_URL/slug-inexistente-zz" -o /dev/null -w '%{http_code}')"
[ "$code" = 404 ] && ok "slug inexistente => 404" || bad "slug inexistente => $code"
hdr="$(curl_resolve "$LINKS_URL/privacy" -D - -o /dev/null)"
echo "$hdr" | grep -qi '^HTTP/.* 200' && ok "/privacy => 200" || bad "/privacy não respondeu 200"
for p in /metrics /readyz /api/v1/links; do
  code="$(curl_resolve "$LINKS_URL$p" -o /dev/null -w '%{http_code}')"
  [ "$code" = 404 ] && ok "$p oculto no domínio de links" || bad "$p => $code (esperado 404)"
done

echo "4) Painel"
code="$(curl_resolve "$PANEL_URL/" -o /dev/null -w '%{http_code}')"
[ "$code" = 200 ] && ok "SPA => 200" || bad "SPA => $code"
code="$(curl_resolve "$PANEL_URL/api/v1/auth/me" -o /dev/null -w '%{http_code}')"
[ "$code" = 401 ] && ok "API protegida sem sessão => 401" || bad "/auth/me => $code"
hdr="$(curl_resolve "$PANEL_URL/" -D - -o /dev/null)"
echo "$hdr" | grep -qi 'content-security-policy' && ok "CSP presente" || bad "CSP ausente"
echo "$hdr" | grep -qi 'x-content-type-options: nosniff' && ok "nosniff presente" || bad "nosniff ausente"
echo "$hdr" | grep -qi '^server:' && bad "cabeçalho Server exposto" || ok "Server oculto"

echo
[ "$fail" = 0 ] && echo "SMOKE TEST: APROVADO" || { echo "SMOKE TEST: FALHOU"; exit 1; }
