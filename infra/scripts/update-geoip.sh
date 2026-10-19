#!/usr/bin/env bash
# Baixa/atualiza as bases de geolocalização gratuitas DB-IP Lite (cidade + ASN, formato MMDB) para o
# volume Docker "geoip", lido pelo worker (recarrega sozinho em até 1 h) e pela API.
#
#   Licença: CC BY 4.0 — a atribuição "IP Geolocation by DB-IP" é exibida pela aplicação.
#   Fonte:   https://db-ip.com/db/lite.php  (publicada todo mês; este script tenta o mês atual e o anterior)
#
# Uso:  ./infra/scripts/update-geoip.sh            (cron mensal sugerido: dia 3 às 04:00)
#       GEOIP_VOLUME=iplogger_geoip ./infra/scripts/update-geoip.sh
# Requer GEOLITE2_ENABLED=true no .env (o nome é histórico: vale para qualquer base MMDB).
set -euo pipefail

VOLUME="${GEOIP_VOLUME:-iplogger_geoip}"
MIN_CITY_BYTES=$((20 * 1024 * 1024))
MIN_ASN_BYTES=$((1 * 1024 * 1024))
this_month="$(date -u +%Y-%m)"
prev_month="$(date -u -d "$(date -u +%Y-%m-15) -1 month" +%Y-%m 2>/dev/null || date -u -v-1m +%Y-%m)"

fetch() { # $1 = city|asn  $2 = tamanho mínimo
  local kind="$1" min="$2" ok=0
  for m in "$this_month" "$prev_month"; do
    url="https://download.db-ip.com/free/dbip-${kind}-lite-${m}.mmdb.gz"
    echo "  tentando $url"
    # Baixa para arquivo temporário dentro do volume, valida o tamanho e só então substitui (atômico)
    if docker run --rm --user 0 -v "${VOLUME}:/geoip" --entrypoint sh curlimages/curl:latest -c "
        set -e
        curl -fsSL --max-time 600 '$url' | gunzip > /geoip/dbip-${kind}-lite.mmdb.tmp
        size=\$(wc -c < /geoip/dbip-${kind}-lite.mmdb.tmp)
        if [ \"\$size\" -lt $min ]; then echo 'arquivo pequeno demais ('\$size' bytes)'; rm -f /geoip/dbip-${kind}-lite.mmdb.tmp; exit 3; fi
        chmod 644 /geoip/dbip-${kind}-lite.mmdb.tmp
        mv /geoip/dbip-${kind}-lite.mmdb.tmp /geoip/dbip-${kind}-lite.mmdb
        echo \"  ok: \$size bytes\"
      "; then ok=1; break; fi
  done
  [ "$ok" = 1 ] || { echo "FALHA ao atualizar a base $kind" >&2; return 1; }
}

echo "Atualizando bases DB-IP Lite no volume $VOLUME"
docker volume inspect "$VOLUME" >/dev/null 2>&1 || docker volume create "$VOLUME" >/dev/null
fetch asn "$MIN_ASN_BYTES"
fetch city "$MIN_CITY_BYTES"
echo "Concluído. O worker recarrega as bases em até 1 hora (ou: docker compose restart worker api)."
