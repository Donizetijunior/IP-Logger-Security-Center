#!/usr/bin/env bash
# Verifica um backup SEM tocar no banco de produção: descriptografa, confere o hash e restaura em um
# banco temporário (iplogger_verify), compara contagens e remove o banco temporário.
# Uso: BACKUP_KEY_FILE=/caminho/chave ./infra/scripts/verify-backup.sh [arquivo.dump.enc]
# Sem argumento usa o backup mais recente do BACKUP_DIR (padrão ./backups).
set -euo pipefail

cd "$(dirname "$0")/../.."
: "${BACKUP_KEY_FILE:?defina BACKUP_KEY_FILE}"
BACKUP_DIR="${BACKUP_DIR:-./backups}"
file="${1:-$(ls -1t "$BACKUP_DIR"/iplogger-*.dump.enc 2>/dev/null | head -1)}"
[ -n "$file" ] && [ -r "$file" ] || { echo "nenhum backup encontrado" >&2; exit 1; }

set -a; [ -f .env ] && . ./.env; set +a
USR="${POSTGRES_USER:-iplogger}"; DB="${POSTGRES_DB:-iplogger}"; TMPDB="iplogger_verify"
psql_c() { docker compose exec -T postgres psql -U "$USR" -d "$1" -Atc "$2"; }

echo "Arquivo: $file"
[ -f "$file.sha256" ] && sha256sum -c "$file.sha256"

psql_c postgres "DROP DATABASE IF EXISTS $TMPDB" >/dev/null
psql_c postgres "CREATE DATABASE $TMPDB" >/dev/null
trap 'psql_c postgres "DROP DATABASE IF EXISTS $TMPDB" >/dev/null 2>&1 || true' EXIT

openssl enc -d -aes-256-cbc -pbkdf2 -iter 200000 -pass "file:$BACKUP_KEY_FILE" -in "$file" \
  | docker compose exec -T postgres pg_restore -U "$USR" -d "$TMPDB" --no-owner >/dev/null

ok=1
for t in accounts short_links access_events alerts audit_events; do
  prod="$(psql_c "$DB" "SELECT count(*) FROM $t")"
  rest="$(psql_c "$TMPDB" "SELECT count(*) FROM $t")"
  # Backup é anterior ao "agora": a restauração pode ter menos linhas, nunca mais
  if [ "$rest" -le "$prod" ]; then s=OK; else s=DIVERGENTE; ok=0; fi
  printf '  %-14s produção=%-8s restaurado=%-8s %s\n' "$t" "$prod" "$rest" "$s"
done
[ "$ok" = 1 ] && echo "VERIFICAÇÃO: APROVADA (restauração íntegra, banco temporário removido)" || { echo "VERIFICAÇÃO: FALHOU" >&2; exit 1; }
