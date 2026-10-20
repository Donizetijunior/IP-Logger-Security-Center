# Privacidade

Resumo para o operador — o detalhamento (dados, retenção, terceiros, pendências jurídicas e checklist de go-live) está em [docs/privacy-retention.md](docs/privacy-retention.md). O texto público é servido em `/privacy` (código em `apps/api/src/privacy-page.ts`, versionado) e descreve o que o código realmente faz; quem hospedar o projeto deve **adaptá-lo** (controlador, contato, provedores, prazos de backup) e validá-lo com advogado. Ao mudar o texto, altere `PRIVACY_VERSION` e registre em [docs/legal-decision.md](docs/legal-decision.md).

**Princípios do projeto:** finalidade de segurança, coleta mínima, transparência, sem fingerprinting/scripts no destino, sem cookies de rastreamento, retenção de 30 dias com expurgo automático, IP mascarado por padrão em exportações, e distinção clara entre *endereço de rede* e *pessoa*.

**Antes de publicar:** definir controlador/encarregado, base legal, decisão sobre o art. 15 da Lei 12.965/2014 (guarda de 6 meses) e transferência internacional para os provedores habilitados. A aplicação não inicia em produção sem `LEGAL_REVIEW_ACKNOWLEDGED=true`; **não altere esse valor sem a decisão documentada**.
