#!/usr/bin/env bash
# Backup criptografado do PostgreSQL (executar no host da VPS, ex.: cron diário).
#   BACKUP_KEY_FILE        arquivo com a senha de criptografia (chmod 600, fora do repositório)  [obrigatório]
#   BACKUP_DIR             destino (padrão ./backups)
#   BACKUP_RETENTION_DAYS  cópias mais antigas são apagadas (padrão 14)
#   BACKUP_MIN_FREE_GB     aborta se o disco do destino tiver menos que isto livre (padrão 5)
# RPO sugerido: 24 h (cron diário). RTO sugerido: < 1 h (ver docs/operations.md).
set -euo pipefail

cd "$(dirname "$0")/../.."
BACKUP_DIR="${BACKUP_DIR:-./backups}"
BACKUP_RETENTION_DAYS="${BACKUP_RETENTION_DAYS:-14}"
BACKUP_MIN_FREE_GB="${BACKUP_MIN_FREE_GB:-5}"
: "${BACKUP_KEY_FILE:?defina BACKUP_KEY_FILE (arquivo com a senha de criptografia)}"
[ -r "$BACKUP_KEY_FILE" ] || { echo "BACKUP_KEY_FILE ilegível" >&2; exit 1; }

# Lê variáveis do .env SEM executá-lo (valores com espaços/parênteses valem para o Docker, mas quebram o shell)
envval() { [ -f .env ] && grep -E "^$1=" .env | tail -1 | cut -d= -f2- | sed -e 's/^"//' -e 's/"$//' || true; }
POSTGRES_USER="${POSTGRES_USER:-$(envval POSTGRES_USER)}"
POSTGRES_DB="${POSTGRES_DB:-$(envval POSTGRES_DB)}"
mkdir -p "$BACKUP_DIR"
chmod 700 "$BACKUP_DIR"

# Trava de espaço: este servidor pode hospedar outros projetos, então nunca encher o disco.
free_kb="$(df -Pk "$BACKUP_DIR" | awk 'NR==2{print $4}')"
min_kb=$((BACKUP_MIN_FREE_GB * 1024 * 1024))
if [ "$free_kb" -lt "$min_kb" ]; then
  echo "ABORTADO: apenas $((free_kb / 1024 / 1024)) GB livres em $BACKUP_DIR (mínimo ${BACKUP_MIN_FREE_GB} GB)" >&2
  exit 2
fi

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
echo "$(date -u +%FT%TZ) Backup criado: $out ($(du -h "$out" | cut -f1))"

# Expira cópias antigas para que dados vencidos não sobrevivam indefinidamente em backups
find "$BACKUP_DIR" -maxdepth 1 -type f \( -name 'iplogger-*.dump.enc' -o -name 'iplogger-*.dump.enc.sha256' \) \
  -mtime "+$BACKUP_RETENTION_DAYS" -print -delete
