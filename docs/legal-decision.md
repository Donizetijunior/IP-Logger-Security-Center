# Registro da decisão jurídica de go-live

> **Isto é um registro do operador, não um parecer jurídico.** Foi redigido com base em fatos declarados pelo operador e deve ser revisado por advogado de direito digital/LGPD assim que possível. Ele existe para que a trava `LEGAL_REVIEW_ACKNOWLEDGED` represente uma decisão consciente e documentada, e não um valor ligado por conveniência.

- **Data do registro:** 2026-10-19
- **Serviço:** IP Logger Security Center (`iplogger.com.br` / `painel.iplogger.com.br`)
- **Operador/controlador:** _[nome completo do operador — preencher]_
- **Canal do titular de dados:** _[e-mail de contato — preencher]_ (também exibido em `/privacy`)

## 1. Fatos declarados pelo operador

1. O serviço é operado por **pessoa física**.
2. O projeto é **gratuito**, **sem monetização** (sem planos pagos, anúncios ou venda de dados) e **de código aberto**.
3. Não há pessoa jurídica (empresa/MEI) envolvida na operação.
4. O cadastro de usuários é controlado por `SIGNUP_MODE` (padrão do projeto: `approval`).

## 2. Marco Civil da Internet — art. 15 (guarda de registros de acesso por 6 meses)

O art. 15 impõe a guarda ao provedor de aplicações **constituído como pessoa jurídica** que exerça a atividade **de forma organizada, profissional e com fins econômicos**.

**Conclusão do operador:** pelos fatos acima (pessoa física, sem fins econômicos), a obrigação de guarda de 6 meses **não se aplica**; por isso **não** foi implementado armazenamento legal separado, e os eventos identificáveis são eliminados em **30 dias** (minimização, art. 6º, III, LGPD).

**Condições que invalidam esta conclusão (reavaliar imediatamente se ocorrer qualquer uma):**
- constituição de empresa/MEI para operar ou receber pelo serviço;
- qualquer monetização (planos, doações recorrentes vinculadas a benefícios, anúncios, venda de dados);
- ordem judicial ou pedido de autoridade (art. 15, §§ 1º a 4º: pode haver ordem de guarda/preservação de registros);
- mudança de escala ou finalidade que descaracterize a atividade como não econômica.

Se uma condição ocorrer: desligar `LEGAL_REVIEW_ACKNOWLEDGED`, reavaliar com advogado e implementar o armazenamento legal descrito em [privacy-retention.md](privacy-retention.md).

## 3. LGPD — base legal e papéis

| Item | Posição adotada |
|---|---|
| Dado tratado | Endereço IP, data/hora, User-Agent/idioma saneados, origem do Referer (dado pessoal, conforme entendimento corrente da ANPD) |
| Finalidade | Segurança da informação e investigação de incidentes (detecção de varreduras/automação), no contexto de links criados por usuários que aceitam os Termos |
| Base legal | **Legítimo interesse** (art. 7º, IX) para segurança, com avaliação de legítimo interesse (LIA) abaixo |
| Papéis | O operador é controlador do tratamento realizado pela plataforma; o **usuário que cria o link é responsável pelo uso dos dados dos visitantes dos seus links** e pela finalidade (Termos §3). A repartição exata de papéis deve ser validada por advogado |
| Minimização | Allowlist de campos; sem cookies, tokens, fingerprinting ou corpo de requisição; Referer reduzido à origem; retenção de 30 dias com expurgo automático |
| Transparência | `/privacy` público, Termos de Uso, denúncia pública sem registro de IP |
| Direitos do titular | Canal de contato em `/privacy`; busca por IP e exclusão manual descritas em [operations.md](operations.md) |
| Compartilhamento/transferência | Cloudflare (túnel e TLS), RDAP (`rdap.org`), e — se habilitados — AbuseIPDB/GreyNoise. Há transferência internacional; fundamento a validar (art. 33) |

**LIA resumida:** (i) interesse legítimo — proteger o serviço e permitir investigação de segurança autorizada; (ii) necessidade — o IP é indispensável para a finalidade e nada além do necessário é coletado; (iii) balanceamento — expectativa do titular é limitada (não há aviso no ato do clique), o que **aumenta o risco**; mitigado por: retenção curta, proibições nos Termos, denúncia/moderação, ausência de cruzamento de dados entre contas, IP mascarado em exportações por padrão. **Risco residual reconhecido:** uso indevido por usuários para rastrear pessoas sem consentimento; controles em [multiuser.md](multiuser.md).

## 4. Pontos que continuam em aberto (não impedem o registro, mas devem ser tratados)

- Revisão do texto de `/privacy` e dos Termos por advogado.
- Decisão sobre **aviso ao visitante antes do redirecionamento** (opcional no produto; reduz risco de transparência).
- RIPD/DPIA, se a ANPD ou o advogado entender exigível.
- Avaliação da transferência internacional (Cloudflare e provedores habilitados).
- Verificação de e-mail e CAPTCHA no cadastro aberto (limitação técnica atual).

## 5. Aprovação

| | |
|---|---|
| Decisão | Go-live autorizado pelo operador com base nos fatos da seção 1 |
| Responsável | _[nome do operador]_ |
| Data | 2026-10-19 |
| Revisão obrigatória em | 6 meses, ou antes se ocorrer uma condição da seção 2 |
