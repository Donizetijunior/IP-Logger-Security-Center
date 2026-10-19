# ADR 0001 — Decisões técnicas e desvios do briefing

Status: aceito · Data: 2026-10-19

## Mantido conforme o briefing

Node.js 24 LTS, TypeScript, React + Vite + Tailwind, PostgreSQL, Redis/BullMQ, Caddy, Docker Compose, outbox transacional, 302 imediato, fail-open documentado, retenção de 30 dias, alertas só no painel, MFA TOTP + Argon2id, uma única conta de administrador (substituída pela migração 005: múltiplos administradores, ver ADR 0002).

## Desvios (o briefing permite desde que registrados)

| Briefing | Adotado | Motivo | Efeito nos requisitos |
|---|---|---|---|
| NestJS com adaptador Fastify | **Fastify direto** + módulos simples | Caminho crítico do redirect enxuto (≈2 ms internos), menos dependências/superfície, execução nativa de TypeScript no Node 24 sem *transpile* (NestJS exige decorators/metadados) | Nenhum: mesmo servidor HTTP, mesmas rotas e contratos |
| ORM + migrations | **SQL puro** parametrizado + migrations `.sql` com lock consultivo | Esquema pequeno, `inet`/CTE atômica no redirect, auditoria fácil de queries | Nenhum |
| Build com `tsc`/bundler | **Node executa `.ts` diretamente** (`erasableSyntaxOnly`) | Simplicidade de imagem e debug | Exige Node ≥ 24 |
| Exportação "assíncrona" | Worker consulta `exports` pendentes a cada 5 s (sem fila BullMQ dedicada) | Menos peças; resiliente a reinício | Nenhum |
| Backup como serviço Compose | **Scripts no host** (`backup.sh`/`restore.sh`) | O briefing admite "rotina da VPS"; chave de criptografia fica fora do servidor | Nenhum |
| `SESSION_SECRET` | Presente e validado, mas **sem uso criptográfico** (sessão = token opaco hasheado no banco) | Evitar cookie assinado desnecessário | Variável reservada; documentado |

## Outras decisões

- **404 uniforme** para slug inexistente/desativado/expirado/removido (o briefing permite 404 consistente em vez de 410): reduz enumeração.
- **Cache de links em memória** (TTL 30 s, *stale* 1 h) para tornar o fail-open possível sem o banco; consequência: instância única de API.
- **Limite de redirect por IP configurável (1200/min)** para não penalizar usuários atrás de NAT (um limite inicial de 600/min foi descartado ao medir carga de um único IP).
- **IP do Caddy fixo** na rede Compose e `TRUSTED_PROXY_CIDRS` = `/32` desse IP.
- **Pontuação "evidência independente"** definida como corroboração AbuseIPDB (≥ 50) + GreyNoise malicioso (+15), pois o briefing não detalha a fonte.
- **Sem lint (ESLint)** no MVP: `tsc --strict` + testes são o portão de qualidade; adicionar ESLint é recomendável.
