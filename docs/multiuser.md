# Contas, cadastro e moderação

A partir da versão 0.2 a plataforma é **multiusuário**: cada pessoa cria e vê **somente os próprios links e eventos**; o administrador gerencia usuários e a moderação.

## Papéis

| Papel | Como nasce | MFA | Vê |
|---|---|---|---|
| **Administrador** (um único) | CLI `bootstrap-admin` (nunca pela web) | TOTP obrigatório + códigos de recuperação | Tudo: todos os links/eventos, usuários, denúncias, integrações, auditoria |
| **Usuário** | Cadastro público, ou criado pelo admin | Não (senha forte; bloqueio após falhas) | Apenas links, eventos, IPs, alertas e exportações **dos próprios links** |

O papel **nunca** vem do cliente (campos extras no cadastro são ignorados — testado). Pode haver **vários administradores** (migração 005 removeu o índice `accounts_single_admin`). Um admin só é criado por outro admin, no painel (**Usuários → Novo administrador**), exigindo reautenticação recente (senha); o CLI cria apenas o primeiro. Todo admin tem MFA TOTP obrigatório: QR, segredo, senha temporária e 10 códigos de recuperação são exibidos uma única vez, e no primeiro acesso ele troca a senha e aceita os Termos.

## Modo de cadastro (`SIGNUP_MODE`)

| Valor | Efeito |
|---|---|
| `open` | Qualquer pessoa cria conta e já entra (exige aceite dos Termos e senha forte) |
| `approval` (padrão) | A conta nasce **pendente**; só entra depois de o admin aprovar em *Usuários* |
| `closed` | Sem cadastro público; só o admin cria contas |

Limites: `SIGNUP_RATE_PER_HOUR` cadastros por IP (padrão 5), `DEFAULT_LINK_QUOTA` links por conta (padrão 25). Alterar o modo exige editar `.env` e `docker compose up -d api`.

> **Atenção:** o cadastro `open` **não verifica o e-mail** (não há SMTP no MVP). Qualquer pessoa pode se cadastrar com e-mail de terceiros. Isso é aceitável para o limite pequeno de links, mas deixa a moderação (denúncias, suspensão) como sua principal defesa. Para endurecer: use `approval`, reduza `DEFAULT_LINK_QUOTA` e, no futuro, acrescente verificação de e-mail/CAPTCHA.

## Gestão de usuários (admin → *Usuários*)

Criar (com senha temporária gerada e exibida **uma única vez**; o usuário é obrigado a trocá-la e a aceitar os Termos no primeiro acesso), aprovar, suspender/reativar, ajustar limite de links, redefinir senha (encerra sessões) e excluir (apaga links, eventos, alertas e exportações, sem deixar eventos órfãos). Ninguém altera, suspende ou exclui a **própria** conta por essas rotas (400 `self_protected`), e o **último administrador ativo** não pode ser suspenso/excluído (409 `last_admin`). Um admin pode redefinir a senha, suspender ou excluir outro admin; suspender um admin não desativa links ou domínios (só os de usuários comuns).

Suspender uma conta: revoga sessões, **desativa todos os links** e marca-os como *moderados* — o dono **não consegue reativá-los** (`disabled_by_moderation`); só o admin.

## Denúncias de abuso (público → admin → *Denúncias*)

`/denunciar` (sem login, **sem registrar o IP do denunciante**, limitado a 10/h por IP). O admin vê o link, destino e dono e pode: analisar, **desativar o link**, **suspender o dono** (desativa todos os links) ou arquivar. Denúncias resolvidas são eliminadas após 180 dias (podem conter contato do denunciante).

## Isolamento (multi-tenant)

Aplicado no SQL de todas as rotas: links, eventos, detalhe de evento, perfil de IP (só IPs que acessaram links do dono), painel/série temporal, alertas, exportações (o worker usa `scope_owner_id`). Rotas de `/settings`, `/integrations/status`, `/audit`, `/users` e `/reports` são exclusivas do admin. Coberto por `tests/integration/multiuser.test.ts` (22 testes).

## Dados do usuário (LGPD)

- **Exclusão pelo próprio usuário:** *Minha conta → Excluir conta e dados* (confirma senha) — remove links, eventos, alertas e a conta.
- **Retenção:** os eventos continuam expirando em 30 dias para todos.
- **Papéis de tratamento:** quem cria o link é o responsável pelos dados dos visitantes dos *seus* links (Termos de Uso, §3); o operador da plataforma trata os dados como infraestrutura. **Isso precisa ser validado juridicamente** (ver [privacy-retention.md](privacy-retention.md)).

## Risco de abuso (leitura obrigatória antes de abrir ao público)

Uma plataforma de links com registro de IP e **cadastro livre** pode ser usada para rastrear pessoas sem consentimento, para phishing ou para perseguição, e domínios assim costumam ser listados em *blocklists* de reputação. Controles implementados: Termos com proibições explícitas, denúncia pública, suspensão/moderação, cota por conta, limite de cadastro por IP, redirecionamento sem esconder o aviso de privacidade (`/privacy`), destino validado (sem laços de redirect). **Não** há verificação de e-mail, CAPTCHA, página intermediária de aviso ao visitante, nem detecção automática de phishing. Avalie com o jurídico se uma página de aviso antes do redirecionamento é exigida pelo seu enquadramento.
