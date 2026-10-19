# Contribuindo

## Ambiente

Node.js ≥ 24 (TypeScript executado nativamente: use apenas sintaxe *erasable* — sem `enum`, `namespace` ou *parameter properties*; imports com extensão `.ts`) e Docker.

```bash
npm install
docker compose -f docker-compose.test.yml up -d --wait
npm run ci
```

## Regras

- **Teste primeiro:** toda mudança de comportamento vem com teste (unitário em `packages/*`, integração em `tests/integration`, segurança em `tests/security`). Não conte uma funcionalidade como pronta só porque o código foi escrito.
- **Nunca** fabrique resultados de provedores: mocks de HTTP existem **somente** em testes.
- **Privacidade por padrão:** não persista cabeçalhos fora da allowlist, não registre IP/slug/query em logs, não envie IP não público a terceiros.
- **Caminho do redirect:** sem `await` de rede externa; a gravação deve continuar em um único statement atômico com timeout.
- Mudanças em regras de risco aumentam `RISK_ENGINE_VERSION` e atualizam [docs/risk-scoring.md](docs/risk-scoring.md).
- Decisões arquiteturais relevantes: registre em [docs/adr](docs/adr).
- Estilo: TypeScript estrito (`npm run typecheck`), `.editorconfig` respeitado; mensagens/UI em pt-BR.
- Dependências: justifique novas, fixe versões em produção, rode `npm audit`.
