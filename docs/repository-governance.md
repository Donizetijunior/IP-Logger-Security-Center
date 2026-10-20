# Governança do repositório (open source)

Como receber contribuições de outras pessoas **sem arriscar o servidor, os segredos nem a qualidade**.

## Modelo de trabalho

1. Ninguém (além de quem mantém) escreve direto na `main`. Contribuidores fazem **fork → branch → pull request**.
2. A CI roda no PR com permissões mínimas e **sem segredos** (`.github/workflows/ci.yml`; nunca use `pull_request_target`).
3. A mantenedora revisa (CODEOWNERS exige isso) e só então faz o *merge* (use *Squash and merge*).
4. **O deploy no servidor é manual** (`git pull` + `docker compose up -d --build`). O GitHub não tem acesso ao servidor: um PR malicioso não consegue executar nada em produção.

## Configurações no GitHub (uma vez, pela interface)

**Settings → Branches → Add branch ruleset** (alvo: `main`):

- Require a pull request before merging — 1 aprovação; *Dismiss stale approvals*; **Require review from Code Owners**.
- Require status checks to pass — marque o job **`ci`**; *Require branches to be up to date*.
- Block force pushes e Restrict deletions.
- Require conversation resolution before merging.
- (Opcional) Require signed commits.

**Settings → Actions → General**:

- *Fork pull request workflows from outside collaborators*: **Require approval for all outside collaborators**.
- *Workflow permissions*: **Read repository contents** (somente leitura).

**Settings → Code security** — ative: *Private vulnerability reporting*, *Dependabot alerts*, *Dependabot security updates*, *Secret scanning* e *Push protection*, e *Code scanning (CodeQL)*.

**Settings → General**: desative *Wikis* e *Projects* se não for usar; em *Pull Requests*, permita só *Squash merging* e ative *Automatically delete head branches*.

**Sua conta GitHub**: ative 2FA (chave de segurança ou app) e, em *Settings → Emails*, marque *Keep my email addresses private* e *Block command line pushes that expose my email* para não expor seu e-mail nos commits.

## Regras de ouro

- Nunca coloque segredos no repositório. `.env`, `*.key` e `secrets/` estão no `.gitignore`; se algo vazar, **gire o segredo** — apagar o commit não basta.
- Não adicione *secrets* de produção ao GitHub Actions enquanto o deploy for manual.
- Revise com atenção PRs que mexem em `.github/`, `Dockerfile`, `docker-compose*.yml`, `infra/`, migrações, autenticação, `tools/` (SSRF) e `package-lock.json`.
- Dependências novas: justifique, confira o pacote no npm (mantenedor, downloads, licença) e rode `npm audit`.

## Origem do código (DCO)

Exigimos `Signed-off-by` em cada commit (`git commit -s`). Isso é a declaração de que a pessoa pode contribuir com aquele código ([developercertificate.org](https://developercertificate.org/)). Instale o app **DCO** do GitHub no repositório para verificar isso automaticamente.

## Licença

Defina e adicione um arquivo `LICENSE` antes de divulgar. Sem licença, o código é "todos os direitos reservados" e ninguém pode legalmente usá-lo ou contribuir. Sugestão para um serviço web: **AGPL-3.0** (obriga quem hospedar versões modificadas a publicá-las); alternativas permissivas: Apache-2.0 ou MIT.
