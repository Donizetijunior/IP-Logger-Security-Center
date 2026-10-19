# Privacidade, retenção e pendências jurídicas

> Este documento descreve o que o **software** faz. Ele **não** é parecer jurídico nem garante conformidade com a LGPD ou o Marco Civil da Internet. Itens marcados **PENDENTE** exigem decisão do controlador/assessoria jurídica antes do go-live.

## Dados tratados

| Dado | Origem | Finalidade | Retenção |
|---|---|---|---|
| IP, horário UTC, link, método, status | Conexão/proxy confiável | Segurança e investigação | 30 dias |
| User-Agent, idioma (truncados/saneados), origem do Referer | Cabeçalhos permitidos | Classificação de cliente | 30 dias |
| País/região/cidade, ASN, DNS reverso, Tor, reputação, risco | Enriquecimento | Contexto de segurança | 30 dias (cache expira antes: 24 h/6 h) |
| Alertas com IP | Motor de alertas | Triagem | 30 dias (anonimizados/excluídos pelo expurgo) |
| Exportações | Ação do admin | Investigação | `EXPORT_TTL_MINUTES` (30 min) |
| Auditoria administrativa | Ações do admin | Rastreabilidade | `AUDIT_RETENTION_DAYS` (365) — **sem IP de visitante**, metadados redigidos |

**Nunca armazenados:** cookies, `Authorization`, tokens, corpo de requisição, query string ou path do Referer, identificadores persistentes, fingerprinting. IPs privados/reservados não são enviados a terceiros.

## Compartilhamento com terceiros (transferência)

Quando habilitados pelo operador, o **IP público** é enviado a: AbuseIPDB, GreyNoise (Community, IPv4), serviço RDAP (`rdap.org`) e baixa-se a lista de saídas Tor do Torproject. GeoLite2 é local (sem envio). Esses provedores podem estar fora do Brasil (transferência internacional — **PENDENTE** avaliar base e cláusulas, art. 33 LGPD).

## Transparência

- Aviso público em `/privacy` (nos dois domínios), gerado a partir de `PRIVACY_CONTROLLER_NAME`/`PRIVACY_CONTACT_EMAIL`. O texto é **modelo a revisar**. Como não há página intermediária, divulgue a existência do aviso no contexto em que os links são distribuídos.
- Painel mostra a política de retenção (somente leitura) e a pendência jurídica.

## Retenção de 30 dias e backups

O expurgo diário elimina o que passou de 30 dias (ver [operations.md](operations.md#expurgo-retenção-de-30-dias)). Backups são apagados após 30 dias e, ao restaurar, o **expurgo roda antes de liberar consultas** (testado: 5 eventos vencidos reintroduzidos por um backup foram removidos antes de a API subir). Dados agregados que sobrevivam (`telemetry_counters`) não contêm IP.

## PENDENTE — guarda legal de 6 meses (Lei 12.965/2014, art. 15)

O art. 15 obriga **provedores de aplicações de internet** constituídos como pessoa jurídica, que exerçam a atividade de forma organizada, profissional e com fins econômicos, a manter registros de acesso a aplicações por **6 meses**. A equipe responsável deve avaliar se este serviço se enquadra. **O software não presume que 30 dias bastem.**

- Se **aplicável**: é necessário um **armazenamento de registros legais separado** do analytics de 30 dias (finalidade, acesso, segurança e prazo distintos), com guarda mínima e acesso por ordem judicial/autoridade. **Isto não está implementado no MVP** e a decisão é bloqueante.
- Se **não aplicável**: registre a fundamentação.
- Independentemente: **nunca** aplique a exclusão de 30 dias a registros sujeitos a obrigação superior.

### Trava de go-live

`NODE_ENV=production` exige `LEGAL_REVIEW_ACKNOWLEDGED=true`; sem isso a API e o worker **não iniciam** (testado). Só altere o valor depois de registrar:

- [ ] Controlador, encarregado (DPO) e canal de direitos do titular definidos
- [ ] Base legal do tratamento (ex.: legítimo interesse em segurança, com LIA documentada) e finalidade
- [ ] Decisão sobre o art. 15 do Marco Civil e, se aplicável, desenho do armazenamento legal
- [ ] Avaliação de transferência internacional para os provedores habilitados
- [ ] Revisão e publicação do texto de `/privacy`
- [ ] RIPD/DPIA, se exigível

## Direitos do titular (como atender)

Localize registros em *Eventos → filtro por IP* ou *Investigação de IP*; exporte (CSV/JSON, com reautenticação e auditoria) para responder a pedidos de acesso. Exclusão antecipada: `DELETE FROM access_events WHERE ip_address = '<ip>'` (cascateia avaliações) e remoção do cache `ip_intelligence`, registrando a ação — respeitando obrigações legais de guarda.
