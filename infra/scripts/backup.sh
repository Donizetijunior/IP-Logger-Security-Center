#!/usr/bin/env bash
# Backup criptografado do PostgreSQL (executar no host da VPS, ex.: cron diário).
#   BACKUP_KEY_FILE   arquivo com a senha de criptografia (chmod 600, fora do repositório)
#   BACKUP_DIR        destino (padrão ./backups)
#   BACKUP_RETENTION_DAYS  cópias mais antigas são apagadas (padrão 30 = mesma retenção analítica)
# RPO sugerido: 24 h (cron diário). RTO sugerido: < 1 h (ver docs/operations.md).
set -euo pipefail

cd "$(dirname "$0")/../.."
BACKUP_DIR="${BACKUP_DIR:-./backups}"
BACKUP_RETENTION_DAYS="${BACKUP_RETENTION_DAYS:-30}"
: "${BACKUP_KEY_FILE:?defina BACKUP_KEY_FILE (arquivo com a senha de criptografia)}"
[ -r "$BACKUP_KEY_FILE" ] || { echo "BACKUP_KEY_FILE ilegível" >&2; exit 1; }

# shellcheck disable=SC1091
set -a; [ -f .env ] && . ./.env; set +a
mkdir -p "$BACKUP_DIR"
chmod 700 "$BACKUP_DIR"
stamp="$(date -u +%Y%m%dT%H%M%SZ)"
out="$BACKUP_DIR/iplogger-$stamp.dump.enc"
tmp="$out.partial"
trap 'rm -f "$tmp"' EXIT

docker compose exec -T postgres pg_dump -U "${POSTGRES_USER:-iplogger}" -d "${POSTGRES_DB:-iplogger}" -Fc \
  | openssl enc -aes-256-cbc -pbkdf2 -iter 200000 -salt -pass "file:$BACKUP_KEY_FILE" > "$tmp"

[ -s "$tmp" ] || { echo "backup vazio; abortando" >&2; rm -f "$tmp"; exit 1; }
mv "$tmp" "$out"
chmod 600 "$out"
sha256sum "$out" > "$out.sha256"
echo "Backup criado: $out"

# Expira cópias antigas para que dados vencidos não sobrevivam indefinidamente em backups
find "$BACKUP_DIR" -maxdepth 1 -type f \( -name 'iplogger-*.dump.enc' -o -name 'iplogger-*.dump.enc.sha256' \) \
  -mtime "+$BACKUP_RETENTION_DAYS" -print -delete
