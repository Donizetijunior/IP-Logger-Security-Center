import { Card, PageHeader } from '../ui';

export const TERMS_VERSION = '2026-10-20';

export function TermsPage() {
  return (
    <>
      <PageHeader title="Termos de Uso" subtitle={`Versão ${TERMS_VERSION} · atualizado em 20 de outubro de 2026`} />
      <Card>
        <div className="flex flex-col gap-4 text-sm leading-relaxed">
          <section>
            <h2 className="mb-1 font-semibold">1. O serviço e quem pode usá-lo</h2>
            <p>
              Esta plataforma, de código aberto, gratuita e mantida por uma pessoa física, cria links curtos que registram os acessos para
              fins de <strong>segurança da informação</strong>: testes de conscientização autorizados, detecção de varreduras e automação,
              investigação de incidentes e monitoramento de links próprios. O redirecionamento é imediato; quem acessa um link tem seus
              dados técnicos de conexão registrados, conforme o Aviso de Privacidade. Para criar uma conta é preciso ter
              <strong> 18 anos ou mais</strong> e capacidade civil. Ao se cadastrar, você declara que as informações são verdadeiras e aceita
              estes Termos.
            </p>
          </section>
          <section>
            <h2 className="mb-1 font-semibold">2. Uso proibido</h2>
            <ul className="list-disc pl-5">
              <li>Rastrear, perseguir, intimidar ou identificar pessoas <strong>sem autorização ou consentimento</strong>.</li>
              <li>Phishing, fraude, golpes, engenharia social maliciosa ou distribuição de malware.</li>
              <li>Assédio, divulgação de dados pessoais de terceiros (<em>doxxing</em>) ou qualquer finalidade ilícita.</li>
              <li>Redirecionar para conteúdo ilegal ou que viole direitos de terceiros.</li>
              <li>Tentar burlar limites, isolamento entre contas, moderação ou medidas de segurança, ou sobrecarregar o serviço.</li>
              <li>Usar as ferramentas do serviço para varrer, atacar ou acessar sistemas de terceiros sem autorização.</li>
            </ul>
          </section>
          <section>
            <h2 className="mb-1 font-semibold">3. Sua responsabilidade como dono do link</h2>
            <p>
              Você é o responsável pelos links que cria e pelo tratamento dos dados dos visitantes deles: deve ter <strong>base legal</strong>{' '}
              para esse tratamento, informar os titulares quando a lei exigir (LGPD) e atender às solicitações deles. Você responde por
              eventuais danos causados a terceiros pelo uso que fizer da plataforma. O endereço IP e a geolocalização referem-se ao
              <strong> endereço de rede</strong>, que pode ser compartilhado (NAT/VPN), e não identificam uma pessoa por si só.
            </p>
          </section>
          <section>
            <h2 className="mb-1 font-semibold">4. Sua conta</h2>
            <p>
              Mantenha sua senha em sigilo e use senha forte. Você é responsável pelas ações feitas com a sua conta; avise-nos imediatamente se
              suspeitar de acesso indevido. Não é permitido ceder a conta a terceiros nem criar contas para burlar uma suspensão.
            </p>
          </section>
          <section>
            <h2 className="mb-1 font-semibold">5. Moderação, denúncias e cooperação com autoridades</h2>
            <p>
              Qualquer pessoa pode denunciar um link em <a href="/denunciar">Denunciar abuso</a>. Podemos desativar links e suspender ou
              excluir contas, a qualquer momento, em caso de suspeita de violação destes termos ou de risco a terceiros ou ao serviço.
              Links desativados por moderação não podem ser reativados pelo dono. Cumpriremos <strong>ordens judiciais e requisições
              legais válidas</strong>, o que pode incluir a preservação e o fornecimento de dados de conta e de acesso.
            </p>
          </section>
          <section>
            <h2 className="mb-1 font-semibold">6. Limites</h2>
            <p>Há limite de links por conta e de requisições. Podemos alterar limites para proteger o serviço.</p>
          </section>
          <section>
            <h2 className="mb-1 font-semibold">7. Dados, retenção e exclusão</h2>
            <p>
              Eventos de acesso identificáveis são eliminados automaticamente após 30 dias. Você pode excluir sua conta a qualquer momento em
              “Minha conta”, o que apaga seus links, eventos e alertas. Veja o Aviso de Privacidade para detalhes e canais de contato.
            </p>
          </section>
          <section>
            <h2 className="mb-1 font-semibold">8. Sem garantias e limitação de responsabilidade</h2>
            <p>
              O serviço é gratuito e fornecido “como está”, sem garantia de disponibilidade, continuidade ou adequação a um fim específico, e
              pode ser alterado ou encerrado. Reputação, geolocalização e classificações são <strong>estimativas</strong> e não constituem
              prova. Em caso de indisponibilidade do banco de dados, os acessos podem não ser registrados. Na máxima extensão permitida em
              lei, o operador não responde por lucros cessantes, perda de dados ou danos indiretos decorrentes do uso do serviço; isso não
              afasta a responsabilidade que a lei não permita excluir (por exemplo, por dolo).
            </p>
          </section>
          <section>
            <h2 className="mb-1 font-semibold">9. Código aberto</h2>
            <p>O código da plataforma é aberto (AGPL-3.0); a licença do código não altera estes Termos de Uso do serviço hospedado.</p>
          </section>
          <section>
            <h2 className="mb-1 font-semibold">10. Alterações destes Termos</h2>
            <p>
              Podemos atualizar estes Termos. A versão e a data ficam no topo e mudanças relevantes serão avisadas no painel; continuar usando
              o serviço após o aviso significa concordar com a nova versão. Se não concordar, exclua a sua conta.
            </p>
          </section>
          <section>
            <h2 className="mb-1 font-semibold">11. Lei aplicável e contato</h2>
            <p>
              Aplica-se a lei brasileira. Fica eleito o foro da comarca de domicílio do operador, ressalvados os foros que a lei imponha
              como obrigatórios. Dúvidas, solicitações de titulares e denúncias: contato@iplogger.com.br.
            </p>
          </section>
        </div>
      </Card>
    </>
  );
}
