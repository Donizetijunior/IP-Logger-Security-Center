# Abrindo o código (open source)

## 1. Escolha uma licença (ainda não definida)

Sem arquivo `LICENSE` o código é, por padrão, **todos os direitos reservados**: ninguém pode legalmente usá-lo ou modificá-lo. A escolha é sua; opções comuns:

| Licença | Efeito | Quando faz sentido |
|---|---|---|
| **AGPL-3.0** | Quem hospedar uma versão modificada como serviço precisa publicar suas alterações | Você quer impedir que terceiros montem um serviço fechado a partir do projeto |
| **Apache-2.0** | Permissiva, com concessão de patentes | Você quer adoção ampla e aceita forks fechados |
| **MIT** | Permissiva e mínima | Idem, com menos texto |

Depois de escolher: adicione `LICENSE`, ajuste `"license"` no `package.json` (hoje `UNLICENSED`) e o aviso em [NOTICE.md](../NOTICE.md). A licença do **código** não substitui os Termos de Uso do **serviço** hospedado (já previsto no §8 dos Termos).

## 2. Antes de publicar (checklist)

- [x] Nenhum segredo versionado: `.env`, credenciais locais, `node_modules` e `dist` estão no `.gitignore`; só `.env.example` (placeholders) vai ao repositório.
- [ ] Conferir o histórico: `git log -p | grep -iE "password|secret|token|key"` (esperado: apenas placeholders/testes).
- [ ] Rodar `npm audit` e resolver o que for relevante.
- [ ] Trocar contatos de exemplo (`PRIVACY_CONTACT_EMAIL`, `OPEN_SOURCE_URL`) pelos reais.
- [ ] Ativar *Dependabot/Renovate*, *secret scanning* e proteção da branch `main` no GitHub.
- [ ] Definir `SECURITY.md` com canal real de contato para vulnerabilidades (hoje descreve o processo, sem e-mail).
- [ ] Criar *issue templates* e um `CODE_OF_CONDUCT.md` se esperar contribuições.

## 3. Uso responsável (importante num projeto desse tipo)

Ferramentas de registro de IP são de uso duplo. Para o projeto aberto não virar um kit de rastreamento/phishing:

- Mantenha no README e nos Termos a **finalidade de segurança autorizada** e as proibições (já presentes).
- Mantenha a **denúncia pública**, a moderação e o aviso `/privacy` ativos por padrão; não os remova em forks sem aviso.
- O padrão de `SIGNUP_MODE` no código é `approval` (seguro por padrão); `open` é opt-in do operador.
- Considere documentar que o projeto **não aceita** contribuições cujo objetivo seja ocultar o aviso aos visitantes, burlar a moderação ou coletar dados além da allowlist.

## 4. Operando um serviço público aberto

O operador do serviço (você, em `iplogger.com.br`) é quem responde perante a LGPD e os provedores de infraestrutura. Veja [privacy-retention.md](privacy-retention.md) e [multiuser.md](multiuser.md) — em especial a decisão jurídica pendente e os riscos de abuso do cadastro livre.
