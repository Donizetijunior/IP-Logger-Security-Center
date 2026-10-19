# Threat Intelligence

**Ao ativar qualquer provedor, confira termos de uso, licença de dados, cotas e entitlement do seu plano no momento do deploy.** Todos são opt-in (`*_ENABLED=false` por padrão) e o core funciona sem eles.

## Política comum (implementada em `apps/worker/src/intel.ts`)

- Apenas IPs globalmente roteáveis são enviados (loopback, RFC1918, CGNAT, link-local, multicast, documentação e reservados são ignorados — testado).
- Cache compartilhado por IP em `ip_intelligence` (positivo `PROVIDER_CACHE_TTL_HOURS`=24; sem dados `PROVIDER_NEGATIVE_TTL_HOURS`=6; falha 5 min), deduplicação de consultas simultâneas, quota diária por provedor (`*_DAILY_QUOTA`), `Retry-After`/429 ⇒ `rate_limited` sem laço de requisições, timeout 5 s, circuit breaker (5 falhas ⇒ aberto por 5 min).
- Estados exibidos separadamente: **com resultado**, **sem resultado**, **indisponível**, **cota atingida**, **não consultado**, **desabilitado**.
- Só dados reduzidos/necessários são gravados (`data_redacted`); chaves nunca vão ao frontend nem a URLs.

## AbuseIPDB (API v2)

`GET https://api.abuseipdb.com/api/v2/check?ipAddress=<ip>&maxAgeInDays=30`, cabeçalhos `Key` e `Accept: application/json`. Extrai `abuseConfidenceScore`, `totalReports`, `numDistinctUsers`, `lastReportedAt`, `usageType`, `isp`, `domain`, `countryCode`, `isWhitelisted`, `isTor`. **Não** usa o endpoint de denúncia. Sem chave ⇒ provedor desabilitado com aviso.

## GreyNoise Community

`GET https://api.greynoise.io/v3/community/<ip>` (cabeçalho `key` se houver). **Somente IPv4 público** (IPv6 não é consultado e não consome cota). 404 = IP não observado ⇒ `no_data` (ausência de contexto, não prova de segurança). Cota do plano Community é pequena (`GREYNOISE_DAILY_QUOTA`=50 como padrão conservador — ajuste conforme seu entitlement).

## GeoLite2 + ASN (local)

Bases `GeoLite2-City.mmdb` e `GeoLite2-ASN.mmdb` em `/geoip`, atualizadas pelo serviço `geoipupdate` (perfil `geoip`). O worker valida/recarrega por mtime, mantém a base anterior se a nova falhar e mostra o estado no painel. Atribuição MaxMind obrigatória (EULA). **Nunca** promete endereço físico ou identificação de pessoa.

## Tor

Lista oficial `https://check.torproject.org/exit-addresses` a cada 3 h (`TOR_EXIT_LIST_URL`). Listas com < 50 entradas são rejeitadas (mantém a anterior). Resultado `true/false/unknown` (*unknown* se a lista nunca foi carregada). Uso de Tor é contexto, sem pontos.

## RDAP

Sob demanda (`GET /ips/{ip}?rdap=true`): host **fixo** (`rdap.org`), apenas IP público validado no caminho, `redirect: manual`, timeout 4 s, resposta reduzida e cacheada 24 h. Desligável com `RDAP_ENABLED=false`.

## Validação realizada vs. pendente

- ✅ Contrato de requisição/resposta, limites, 404/429/401/5xx, timeout, cache, cota e circuito testados com **respostas HTTP simuladas** (apenas em testes).
- ⚠️ **Não validado contra as APIs reais** nem com bases GeoLite2 reais (sem chaves/licenças no ambiente de desenvolvimento). Antes de produção: habilitar com chave de teste, gerar tráfego de um IP público conhecido e conferir *Configurações → Fontes de inteligência*.
