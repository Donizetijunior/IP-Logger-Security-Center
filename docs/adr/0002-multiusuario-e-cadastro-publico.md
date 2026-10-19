# ADR 0002 — Multiusuário, cadastro público e publicação por Cloudflare Tunnel

Status: aceito · Data: 2026-10-19 · Substitui parcialmente as decisões "um único administrador / sem cadastro público / sem multi-tenant" do briefing original (ADR 0001).

## Contexto

O proprietário decidiu abrir a plataforma a terceiros (cadastro por "qualquer pessoa"), com tendência a código aberto, publicada em `iplogger.com.br` a partir de um servidor com IP privado.

## Decisões

1. **Contas com papéis** (`admin` único, `user` ilimitados) na tabela `accounts` (renomeada de `admins`); links têm `owner_id`; o isolamento é feito **no SQL** de cada rota (não só na interface).
2. **Cadastro configurável** (`SIGNUP_MODE`): `open`, `approval` (**padrão do código**) e `closed`. O servidor do proprietário foi configurado conforme a escolha dele; o padrão seguro permanece `approval`.
3. **Sem MFA para usuários comuns** nesta versão (senha forte ≥ 12, bloqueio por falhas, limite por IP); o admin mantém TOTP obrigatório. MFA opcional para usuários fica como evolução.
4. **Moderação como controle principal contra abuso:** denúncia pública sem IP, suspensão, links moderados não reativáveis pelo dono, cota por conta, Termos com proibições explícitas.
5. **Cloudflare Tunnel** como forma de publicação: `cloudflared` com IP fixo na rede interna; o Caddy usa `CF-Connecting-IP` **somente** quando a conexão vem desse IP (senão descarta o cabeçalho).
6. `NODE_ENV=production` continua exigindo `LEGAL_REVIEW_ACKNOWLEDGED=true`. **A abertura pública não altera essa trava.**

## Riscos aceitos / abertos

- **Cadastro `open` sem verificação de e-mail e sem CAPTCHA** (sem SMTP): vulnerável a cadastros em massa e a e-mails de terceiros; mitigado por cota (25), limite por IP e moderação.
- **Uso indevido** (rastreamento sem consentimento, phishing) e reputação do domínio — ver [multiuser.md](../multiuser.md#risco-de-abuso-leitura-obrigatória-antes-de-abrir-ao-público).
- **Papéis LGPD** (operador x controlador de cada link) e eventual necessidade de **aviso ao visitante antes do redirecionamento** dependem de parecer jurídico.
- A Cloudflare passa a processar o tráfego (transferência internacional).
