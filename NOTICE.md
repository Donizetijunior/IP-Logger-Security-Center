# Avisos e licenças de terceiros

**Licença do projeto:** [GNU Affero General Public License v3.0](LICENSE) (`AGPL-3.0-only`). Copyright © 2026 Donizeti Junior e colaboradores. Quem hospedar uma versão modificada como serviço de rede deve disponibilizar o código-fonte correspondente aos usuários desse serviço.

## DB-IP Lite

A geolocalização pode usar as bases gratuitas **DB-IP Lite** (https://db-ip.com), licenciadas sob **Creative Commons Attribution 4.0 (CC BY 4.0)**. Atribuição: *IP Geolocation by DB-IP* — exibida pela aplicação. As bases não são distribuídas neste repositório (são baixadas por `infra/scripts/update-geoip.sh`).

## MaxMind GeoLite2

Este produto inclui dados GeoLite2 criados pela MaxMind, disponíveis em https://www.maxmind.com. O uso das bases está sujeito ao EULA da MaxMind (https://www.maxmind.com/en/geolite/eula), inclusive a obrigação de atualização e de atribuição. As bases **não** são distribuídas neste repositório.

## IEEE OUI

A ferramenta de fabricante por MAC embute o registro público de OUI do IEEE (https://standards-oui.ieee.org/), reduzido a prefixo → organização em `apps/api/data/oui.json`. Confira os termos de uso do IEEE ao redistribuir o arquivo.

## Provedores de Threat Intelligence

AbuseIPDB (https://docs.abuseipdb.com/), GreyNoise Community (https://docs.greynoise.io/), Tor Project (https://check.torproject.org/exit-addresses) e serviços RDAP têm termos próprios de uso, cotas e licenças de dados. O operador é responsável por verificá-los e cumpri-los antes de habilitar cada integração.

## Dependências de código

Bibliotecas de código aberto instaladas via npm (Fastify, pg, BullMQ, ioredis, maxmind, otplib, @node-rs/argon2, zod, ipaddr.js, ua-parser-js, React, Vite, Tailwind CSS, entre outras), cada uma sob sua própria licença; consulte `package-lock.json`. Imagens: Node.js, Caddy, PostgreSQL, Redis.
