# Domínios personalizados

Permite que os links respondam em **domínios próprios** (ex.: `https://go.seusite.com.br/oferta`) em vez de só em `iplogger.com.br`. Os acessos são registrados normalmente (IP real, geolocalização, risco, alertas, exportações) e o isolamento entre usuários continua valendo.

## Como funciona

1. O dono cadastra o domínio em **Domínios**. O sistema gera um token de verificação.
2. **Propriedade:** o dono cria no DNS do domínio um registro **TXT** `_iplogger-challenge.<domínio>` com o valor `iplogger-verify=<token>`. O botão *Verificar agora* consulta o DNS (resolvedores públicos 1.1.1.1/8.8.8.8, sem cache local).
3. **Roteamento:** o domínio precisa chegar a esta instalação. Com Cloudflare Tunnel, adicione uma **rota do túnel** para o hostname (veja abaixo). A verificação faz, em seguida, uma checagem HTTPS em `/.well-known/iplogger-check`, que só devolve o *hash* do token — isso prova que o domínio realmente chega aqui. O resultado aparece como "roteamento ok".
4. **Ativação:** conforme `CUSTOM_DOMAINS_MODE`:

| Modo | Quem cadastra | Ativação |
|---|---|---|
| `admin` (padrão) | somente o administrador | automática após o TXT |
| `approval` | usuários (até `CUSTOM_DOMAINS_MAX_PER_USER`, padrão 3) | o administrador **aprova** depois do TXT |
| `open` | usuários | automática após o TXT |

5. Ao criar um link, o dono escolhe o **domínio do link** (domínio principal ou um domínio ativo dele). O **slug é único por domínio**: `black` pode existir em três domínios, cada um com destino próprio.

Regras de resolução (testadas): um link **só responde no domínio a que pertence** (nem no principal nem em outros); domínio pendente, não verificado ou desativado **não serve nenhum link** (HTTP 421/404); desativar um domínio tem efeito imediato; suspender o dono desativa os domínios dele; a raiz `/` do domínio retorna 404 ou redireciona para uma URL configurada (revalidada a cada uso).

## Passo a passo no servidor (Cloudflare Tunnel)

Pré-requisito: o domínio (ou a zona dele) está **na mesma conta Cloudflare** do túnel.

1. *Domínios → Adicionar domínio* → anote o **nome** e o **valor** do TXT.
2. No DNS da zona (Cloudflare → DNS → Registros): tipo **TXT**, nome `_iplogger-challenge.go` (para `go.seusite.com.br`), conteúdo `iplogger-verify=...`.
3. **Zero Trust → Redes → Túneis → (seu túnel) → Rotas → Adicionar rota → Aplicativo publicado**: subdomínio/domínio do hostname e **URL do serviço** `http://caddy:80`. A Cloudflare cria o registro DNS (CNAME proxied) sozinha.
4. Em **Domínios**, clique em **Verificar agora**. Esperado: TXT verificado, "roteamento ok" e status *Ativo*.
5. *Links → Novo link*: escolha o domínio e crie o link.

> O Caddy tem um site coringa (`:80`) que repassa qualquer `Host` à API; é a API quem aceita **somente** domínios ativos (`421 Misdirected Request` para os demais). Rotas internas (`/api`, `/metrics`…) continuam bloqueadas nesses domínios.

## Limitações e cuidados

- **Domínios em outra conta Cloudflare ou em outro provedor de DNS** não funcionam diretamente: mova a zona para a Cloudflare da mesma conta, ou use *Cloudflare for SaaS* (custom hostnames), que **não está implementado**. O TLS é sempre o da Cloudflare.
- **Excluir um domínio no painel não remove** a rota do túnel nem os registros DNS/TXT: faça isso na Cloudflare. Rotas/CNAMEs órfãos podem permitir *subdomain takeover* por outro usuário (a propriedade é reverificada por TXT, o que reduz o risco).
- **Risco de abuso:** domínios próprios deixam os links mais "confiáveis" e, portanto, mais úteis para phishing. Por isso o padrão é só o administrador cadastrar. Se abrir para usuários, prefira `approval`, revise cada domínio (nome parecido com marcas conhecidas, domínios recém-registrados) e use *Denúncias* para desativar. A denúncia aceita a **URL completa** (`https://dominio/codigo`) para achar o link certo.
- **Privacidade:** nos domínios personalizados, `/privacy` serve o mesmo aviso do serviço. Quem cria o link responde pelo uso do domínio (Termos de Uso, §3).
- Domínios não podem ser os hosts da plataforma, IPs, curingas ou nomes internos. Subdomínios da própria plataforma só o administrador cadastra.
