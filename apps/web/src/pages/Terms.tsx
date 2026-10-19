import { Card, PageHeader } from '../ui';

/** Texto-modelo dos Termos de Uso. Deve ser revisado pelo responsável jurídico antes da publicação. */
export function TermsPage() {
  return (
    <>
      <PageHeader title="Termos de Uso" subtitle="Versão 2026-10 — modelo a revisar pelo controlador/assessoria jurídica antes da publicação." />
      <Card>
        <div className="flex flex-col gap-4 text-sm leading-relaxed">
          <section>
            <h2 className="mb-1 font-semibold">1. Finalidade permitida</h2>
            <p>
              Esta plataforma cria links curtos que registram os acessos para fins de <strong>segurança da informação</strong>: testes de
              conscientização autorizados, detecção de varreduras e automação, investigação de incidentes e monitoramento de links
              próprios. O redirecionamento é imediato; quem acessa um link tem seus dados técnicos de conexão registrados.
            </p>
          </section>
          <section>
            <h2 className="mb-1 font-semibold">2. Uso proibido</h2>
            <ul className="list-disc pl-5">
              <li>Rastrear, perseguir, intimidar ou identificar pessoas <strong>sem autorização ou consentimento</strong>.</li>
              <li>Phishing, fraude, golpes, engenharia social maliciosa ou distribuição de malware.</li>
              <li>Assédio, divulgação de dados pessoais de terceiros (<em>doxxing</em>) ou qualquer finalidade ilícita.</li>
              <li>Redirecionar para conteúdo ilegal ou que viole direitos de terceiros.</li>
              <li>Tentar burlar limites, isolamento entre contas, moderação ou medidas de segurança.</li>
            </ul>
          </section>
          <section>
            <h2 className="mb-1 font-semibold">3. Sua responsabilidade como dono do link</h2>
            <p>
              Você é o responsável pelos links que cria e pelo tratamento dos dados dos visitantes deles, devendo ter base legal e
              informar os titulares quando exigido por lei (LGPD). O endereço IP e a geolocalização referem-se ao
              <strong> endereço de rede</strong>, que pode ser compartilhado (NAT/VPN), e não identificam uma pessoa por si só.
            </p>
          </section>
          <section>
            <h2 className="mb-1 font-semibold">4. Moderação e denúncias</h2>
            <p>
              Qualquer pessoa pode denunciar um link em <a href="/denunciar">Denunciar abuso</a>. Podemos desativar links e suspender ou
              excluir contas, a qualquer momento, em caso de suspeita de violação destes termos, sem aviso prévio. Links desativados
              por moderação não podem ser reativados pelo dono.
            </p>
          </section>
          <section>
            <h2 className="mb-1 font-semibold">5. Limites</h2>
            <p>Há limite de links por conta e de requisições. Podemos alterar limites para proteger o serviço.</p>
          </section>
          <section>
            <h2 className="mb-1 font-semibold">6. Dados, retenção e exclusão</h2>
            <p>
              Eventos de acesso identificáveis são eliminados automaticamente após 30 dias. Você pode excluir sua conta a qualquer momento em
              “Minha conta”, o que apaga seus links, eventos e alertas. Veja o Aviso de Privacidade para detalhes e canais de contato.
            </p>
          </section>
          <section>
            <h2 className="mb-1 font-semibold">7. Sem garantias</h2>
            <p>
              O serviço é fornecido “como está”, sem garantia de disponibilidade. Reputação, geolocalização e classificações são
              <strong> estimativas</strong> e não constituem prova. Em caso de indisponibilidade do banco de dados, os acessos podem
              não ser registrados.
            </p>
          </section>
          <section>
            <h2 className="mb-1 font-semibold">8. Código aberto</h2>
            <p>O código da plataforma é aberto; a licença do código não altera estes Termos de Uso do serviço hospedado.</p>
          </section>
        </div>
      </Card>
    </>
  );
}
