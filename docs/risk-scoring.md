# Risk Score (motor v1.0.0)

Determinístico, auditável e versionado (`packages/shared/src/risk.ts`). O resultado descreve a reputação do **endereço/atividade de rede**, nunca uma pessoa.

## Regras

| Código | Condição | Pontos |
|---|---|---:|
| `ABUSEIPDB_CONFIDENCE` | `abuseConfidenceScore` ≥ 75 / ≥ 50 / ≥ 25 (janela de 30 dias na consulta) | 30 / 20 / 10 |
| `GREYNOISE_MALICIOUS` | `classification = malicious` | 35 |
| `INDEPENDENT_CORROBORATION` | AbuseIPDB ≥ 50 **e** GreyNoise malicious (duas fontes independentes) | 15 |
| `RATE_ANOMALY` | ≥ 60 requisições do mesmo IP em 10 min (`RATE_ANOMALY_THRESHOLD`/`_WINDOW_MIN`) | 20 |

Contexto **sem pontos** (registrado como evidência): `GREYNOISE_CONTEXT` (ruído/benigno/riot sem classificação maliciosa), `TOR_EXIT_CONTEXT`, estados de provedor (`*_STATUS`). Tor, VPN, proxy e datacenter **nunca** pontuam sozinhos.

`score = min(100, soma)`. Níveis: **baixo** 0–29 · **médio** 30–69 · **alto** 70–100.

## Não avaliado ≠ zero

Se nenhuma fonte de reputação retornou `ok`/`no_data` (todas desabilitadas, indisponíveis, com cota atingida ou IP não consultável) o resultado é `not_evaluated` (`score = null`), exibido separadamente. `no_data` (ex.: GreyNoise 404) é avaliável e leva a *baixo*, mas **não** indica segurança — apenas ausência de contexto.

## Evidência registrada

Cada avaliação grava `[rule, points, observed, source, at, version, note]` em `risk_assessments.evidence` e a versão do motor (`engine_version`). O painel exibe a tabela no detalhe do evento e as regras/pesos em *Configurações*. Para recalcular com novas regras, aumente `RISK_ENGINE_VERSION`/limiares e reenfileire os eventos (a avaliação anterior é substituída).

## Alertas relacionados

`ip_high_risk` (nível *alto*) é deduplicado por IP (`risk:ip:<ip>`). Não há bloqueio automático por score.

## Limites

IP compartilhado (NAT/CGNAT/VPN) e fontes desatualizadas podem gerar falsos positivos/negativos; trate o score como **triagem**, não como prova.
