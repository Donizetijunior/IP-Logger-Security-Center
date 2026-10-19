#!/usr/bin/env bash
# Restaura um backup criptografado. SEGURANÇA/PRIVACIDADE: antes de reabrir o serviço, o expurgo de
# retenção é executado para remover qualquer dado vencido que o backup traga de volta (CA-18).
# Uso: BACKUP_KEY_FILE=/caminho/chave ./infra/scripts/restore.sh backups/iplogger-XXXX.dump.enc
set -euo pipefail

cd "$(dirname "$0")/../.."
file="${1:?uso: restore.sh <arquivo.dump.enc>}"
: "${BACKUP_KEY_FILE:?defina BACKUP_KEY_FILE}"
[ -r "$file" ] || { echo "arquivo não encontrado: $file" >&2; exit 1; }

if [ -f "$file.sha256" ]; then
  sha256sum -c "$file.sha256"
fi

set -a; [ -f .env ] && . ./.env; set +a
DB="${POSTGRES_DB:-iplogger}"; USR="${POSTGRES_USER:-iplogger}"

echo "==> Parando api e worker (consultas bloqueadas durante a restauração)"
docker compose stop api worker caddy >/dev/null

echo "==> Restaurando banco $DB"
openssl enc -d -aes-256-cbc -pbkdf2 -iter 200000 -pass "file:$BACKUP_KEY_FILE" -in "$file" \
  | docker compose exec -T postgres pg_restore -U "$USR" -d "$DB" --clean --if-exists --no-owner

echo "==> Executando expurgo de retenção ANTES de liberar consultas"
docker compose run --rm --no-deps worker node apps/worker/src/cli/purge.ts

echo "==> Subindo serviços"
docker compose up -d
echo "Restauração concluída. Verifique: ./infra/scripts/smoke-test.sh"
