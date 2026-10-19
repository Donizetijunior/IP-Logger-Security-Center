# Ferramentas

Menu **Ferramentas** (somente para usuários logados). Todas rodam no servidor, exceto os geradores e a cifragem das notas, que rodam **no navegador**.

| Ferramenta | O que faz | De onde vêm os dados | Observações |
|---|---|---|---|
| **Meu IP e User-Agent** | Mostra o IP que o servidor enxerga, tipo (público/privado/CGNAT…), navegador/sistema, idioma e se é saída Tor | Conexão atual + lista Tor local | Atrás de VPN/proxy/NAT o IP pode não ser o do seu dispositivo |
| **Consulta de IP** | Classificação, geolocalização/ASN aproximados (GeoLite2), DNS reverso, Tor e, opcionalmente, RDAP | GeoLite2 local, DNS, Tor, RDAP | IPs privados/reservados não geram nenhuma consulta externa. Reputação (AbuseIPDB/GreyNoise) **não** é exposta aqui para não gastar a cota nem revelar quais IPs visitaram links de terceiros |
| **WHOIS / RDAP** | Registro de domínio (registrador, datas, servidores DNS) ou de bloco de IP | RDAP via `rdap.org` → servidor autoritativo | Não exibe contatos pessoais. Cache de 1 h |
| **Fabricante (MAC)** | Fabricante pelo prefixo OUI (24/28/36 bits) e detecção de MAC aleatório de privacidade | Registro público do IEEE, embutido (`apps/api/data/oui.json`) | Atualize com `node infra/scripts/update-oui.mjs` |
| **Verificador de URL** | Mostra a cadeia de redirecionamentos (status, HTTPS, tempo, servidor), avisa sobre rebaixamento HTTPS→HTTP, muitos domínios e laços | Requisições HEAD/GET de **apenas cabeçalhos** | **Nunca baixa nem executa o conteúdo.** Protegido contra SSRF (abaixo) |
| **Nota privada** | Cria uma nota de leitura única que se autodestrói | Cifrada **no navegador** (AES-GCM 256) | O servidor guarda só o texto cifrado; a chave fica no `#` da URL e nunca é enviada. Quem recebe o link **não precisa de conta** |
| **Gerador de User-Agent** | Gera strings de navegadores comuns | No navegador | Para testes |
| **Gerador de IP** | IPv4/IPv6 públicos aleatórios ou IPs de documentação | No navegador | Para dados de teste; não use para varrer ou acessar sistemas |

## Proteção contra SSRF (verificador de URL e RDAP)

Implementada em `apps/api/src/tools/safe-http.ts` e coberta por testes:

- só `http`/`https`, **portas 80 e 443** (não serve de varredor de portas), sem credenciais na URL;
- recusa `localhost`, TLDs internos e IPs privados/loopback/link-local/CGNAT/reservados — inclusive em formas numéricas (`2130706433`, `0x7f.1`);
- **DNS com trava no momento da conexão** (`guardedLookup`): se *qualquer* resposta for não pública, a conexão é recusada — não existe janela para *DNS rebinding*;
- cada redirecionamento é revalidado do zero (a cadeia é percorrida salto a salto, no máximo 8; RDAP exige HTTPS);
- timeouts curtos, cabeçalhos limitados a 16 KB, corpo (RDAP) limitado a 256 KB, sem seguir conteúdo.

Limites por IP: 15–60 requisições/min conforme a ferramenta. As consultas externas só são feitas por usuários autenticados.

## O que **não** existe (de propósito)

Não implementamos: **pixel de rastreamento** (rastreia pessoas por e-mail sem que saibam), **localizador por número de telefone, por foto ou por GPS** (identificação de pessoas), **gerador de números de cartão** (apoio a fraude), **e-mail temporário** (exige infraestrutura de e-mail e é muito usado para abuso) e **teste de velocidade** (custo de banda sem relação com o projeto). Isso mantém a finalidade de segurança autorizada dos [Termos de Uso](multiuser.md).

## Notas privadas — detalhes de segurança

- Criação exige login (até 50 notas ativas por conta; TTL 1 h a 7 dias; 40 KB cifrados).
- Leitura é pública e **atômica**: `DELETE … RETURNING` garante que, mesmo com leituras simultâneas, só um leitor recebe o conteúdo (testado com 8 requisições paralelas).
- Existe uma verificação de existência que **não consome** a nota (evita que prévias de mensageiros a destruam) e a leitura é um `POST` com checagem de `Origin`.
- Notas expiradas são removidas pelo expurgo; excluir a conta apaga as notas.
- **Limite:** quem tiver o link completo (com `#chave`) lê a nota. Não é um canal para segredos de alto risco: o texto passa por navegadores e pode ficar no histórico do emissor.
