import { useCallback, useEffect, useState } from 'react';
import { api, qs } from '../api';
import { Badge, Button, Card, ErrorBox, PageHeader, Spinner, Time, useAsync } from '../ui';
import type { Page } from '../types';

interface Provider {
  source: string;
  enabled: boolean;
  configured?: boolean;
  state?: string;
  dailyQuota?: number;
  usedToday?: number;
  circuit?: { state?: string; openUntil?: string | null; lastStatus?: string; lastError?: string | null };
  last24h?: Record<string, number>;
  lastCheckedAt?: string | null;
  cacheTtlHours?: number;
  count?: number;
  fetchedAt?: string;
  updatedAt?: string | null;
  cityUpdatedAt?: string | null;
  asnUpdatedAt?: string | null;
  error?: string | null;
}
interface Integrations {
  providers: Provider[];
  jobs: { workerHeartbeatAt: string | null; worker: { queue?: { waiting: number; active: number; failed: number } | null; redisReachable?: boolean } | null; outbox: { pending: number; oldestSeconds: number; redisReachable: boolean } | null; lastPurge: { at: string; retentionDays: number; deleted: Record<string, number> } | null };
}
interface Settings {
  retentionDays: number;
  auditRetentionDays: number;
  exportTtlMinutes: number;
  shortBaseUrl: string;
  dashboardUrl: string;
  allowedTargetDomains: string[];
  trustedProxyConfigured: boolean;
  privacyUrl: string;
  legalReviewAcknowledged: boolean;
  risk: { engineVersion: string; config: { abuseTiers: Array<{ min: number; points: number }>; greynoiseMaliciousPoints: number; corroborationPoints: number; rateAnomalyPoints: number; rateAnomalyThreshold: number; levels: { mediumMin: number; highMin: number } } };
  failOpenPolicy: string;
}
interface AuditItem { id: string; action: string; resource: string | null; result: string; at: string; metadata: Record<string, unknown> }

const STATE_LABEL: Record<string, { label: string; kind: 'ok' | 'warn' | 'bad' | 'neutral' }> = {
  active: { label: 'Ativo', kind: 'ok' }, ready: { label: 'Pronto', kind: 'ok' }, disabled: { label: 'Desabilitado', kind: 'neutral' },
  missing_key: { label: 'Chave ausente', kind: 'warn' }, missing_databases: { label: 'Bases ausentes', kind: 'warn' },
  error: { label: 'Erro', kind: 'bad' }, unknown: { label: 'Sem informação', kind: 'neutral' },
};

export function SettingsPage() {
  const integ = useAsync(() => api.get<Integrations>('/integrations/status'), []);
  const settings = useAsync(() => api.get<Settings>('/settings'), []);
  const hb = integ.data?.jobs.workerHeartbeatAt;
  const hbOk = hb ? Date.now() - Date.parse(hb) < 180_000 : false;

  return (
    <>
      <PageHeader title="Configurações e saúde" subtitle="Estado dos provedores, jobs, política de privacidade e retenção." actions={<Button variant="secondary" onClick={() => { integ.reload(); settings.reload(); }}>Atualizar</Button>} />

      <Card title="Jobs e fila">
        {integ.error ? <ErrorBox error={integ.error} onRetry={integ.reload} /> : !integ.data ? <Spinner /> : (
          <dl className="grid gap-3 text-sm md:grid-cols-4">
            <div><dt style={{ color: 'var(--muted)' }}>Worker</dt><dd><Badge kind={hbOk ? 'ok' : 'bad'}>{hbOk ? 'Em execução' : 'Sem sinal'}</Badge> <span className="text-xs" style={{ color: 'var(--muted)' }}><Time iso={hb} /></span></dd></div>
            <div><dt style={{ color: 'var(--muted)' }}>Fila (aguardando / ativos / falhos)</dt><dd>{integ.data.jobs.worker?.queue ? `${integ.data.jobs.worker.queue.waiting} / ${integ.data.jobs.worker.queue.active} / ${integ.data.jobs.worker.queue.failed}` : 'indisponível'}</dd></div>
            <div><dt style={{ color: 'var(--muted)' }}>Outbox pendente</dt><dd>{integ.data.jobs.outbox ? `${integ.data.jobs.outbox.pending} (mais antigo: ${integ.data.jobs.outbox.oldestSeconds}s)` : '0'}</dd></div>
            <div><dt style={{ color: 'var(--muted)' }}>Último expurgo</dt><dd>{integ.data.jobs.lastPurge ? <><Time iso={integ.data.jobs.lastPurge.at} /> · {integ.data.jobs.lastPurge.deleted.access_events ?? 0} evento(s)</> : 'ainda não executado'}</dd></div>
          </dl>
        )}
      </Card>

      <Card title="Fontes de inteligência" className="mt-4">
        {!integ.data ? <Spinner /> : (
          <div className="overflow-x-auto">
            <table>
              <thead><tr><th>Fonte</th><th>Estado</th><th>Uso / cota diária</th><th>Últimas 24 h</th><th>Observações</th></tr></thead>
              <tbody>
                {integ.data.providers.map((p) => {
                  const st = STATE_LABEL[p.state ?? (p.enabled ? 'active' : 'disabled')] ?? { label: p.state ?? '—', kind: 'neutral' as const };
                  return (
                    <tr key={p.source}>
                      <td className="font-medium">{p.source}</td>
                      <td><Badge kind={st.kind}>{st.label}</Badge>{p.circuit?.state === 'open' && <div className="mt-1"><Badge kind="warn">Circuito aberto</Badge></div>}</td>
                      <td className="text-sm">{p.dailyQuota ? `${p.usedToday ?? 0} / ${p.dailyQuota}` : '—'}</td>
                      <td className="text-sm">{p.last24h && Object.keys(p.last24h).length ? Object.entries(p.last24h).map(([k, v]) => `${k}: ${v}`).join(' · ') : '—'}</td>
                      <td className="text-xs" style={{ color: 'var(--muted)' }}>
                        {p.source === 'tor' && (p.count ? `${p.count} nós · atualizado ${p.fetchedAt ? new Date(p.fetchedAt).toLocaleString('pt-BR') : ''}` : '')}
                        {p.source === 'geolite2' && (p.cityUpdatedAt ? `Cidade: ${new Date(p.cityUpdatedAt).toLocaleDateString('pt-BR')} · ASN: ${p.asnUpdatedAt ? new Date(p.asnUpdatedAt).toLocaleDateString('pt-BR') : '—'}` : '')}
                        {p.error ?? p.circuit?.lastError ?? ''}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
        <p className="mt-3 text-xs" style={{ color: 'var(--muted)' }}>Este produto inclui dados GeoLite2 criados pela MaxMind (https://www.maxmind.com), quando habilitado. “Sem resultado” e “não consultado” não significam que um endereço seja seguro.</p>
      </Card>

      <Card title="Privacidade, retenção e regras de risco" className="mt-4">
        {settings.error ? <ErrorBox error={settings.error} /> : !settings.data ? <Spinner /> : (
          <div className="grid gap-4 text-sm md:grid-cols-2">
            <dl className="flex flex-col gap-1">
              <div><dt className="inline" style={{ color: 'var(--muted)' }}>Retenção de eventos identificáveis: </dt><dd className="inline font-semibold">{settings.data.retentionDays} dias (definida por política, somente leitura)</dd></div>
              <div><dt className="inline" style={{ color: 'var(--muted)' }}>Retenção da auditoria: </dt><dd className="inline">{settings.data.auditRetentionDays} dias</dd></div>
              <div><dt className="inline" style={{ color: 'var(--muted)' }}>Validade das exportações: </dt><dd className="inline">{settings.data.exportTtlMinutes} min</dd></div>
              <div><dt className="inline" style={{ color: 'var(--muted)' }}>Domínio dos links: </dt><dd className="inline mono">{settings.data.shortBaseUrl}</dd></div>
              <div><dt className="inline" style={{ color: 'var(--muted)' }}>Proxy confiável configurado: </dt><dd className="inline">{settings.data.trustedProxyConfigured ? 'Sim' : 'Não (X-Forwarded-For ignorado)'}</dd></div>
              <div><dt className="inline" style={{ color: 'var(--muted)' }}>Aviso público: </dt><dd className="inline"><a href={settings.data.privacyUrl} target="_blank" rel="noreferrer">{settings.data.privacyUrl}</a></dd></div>
              <div><dt className="inline" style={{ color: 'var(--muted)' }}>Decisão jurídica (art. 15, Lei 12.965/2014): </dt><dd className="inline"><Badge kind={settings.data.legalReviewAcknowledged ? 'ok' : 'warn'}>{settings.data.legalReviewAcknowledged ? 'Registrada' : 'Pendente — produção bloqueada'}</Badge></dd></div>
              <p className="mt-2" style={{ color: 'var(--muted)' }}>{settings.data.failOpenPolicy}</p>
            </dl>
            <div>
              <h3 className="mb-2 font-semibold">Motor de risco v{settings.data.risk.engineVersion}</h3>
              <ul className="list-disc pl-5">
                {settings.data.risk.config.abuseTiers.map((t) => <li key={t.min}>AbuseIPDB ≥ {t.min}: +{t.points}</li>)}
                <li>GreyNoise “malicious”: +{settings.data.risk.config.greynoiseMaliciousPoints}</li>
                <li>Corroboração independente: +{settings.data.risk.config.corroborationPoints}</li>
                <li>Taxa anômala (≥ {settings.data.risk.config.rateAnomalyThreshold} req.): +{settings.data.risk.config.rateAnomalyPoints}</li>
                <li>Níveis: médio ≥ {settings.data.risk.config.levels.mediumMin}; alto ≥ {settings.data.risk.config.levels.highMin}</li>
                <li>Tor/VPN/proxy/datacenter: apenas contexto (0 ponto)</li>
              </ul>
            </div>
          </div>
        )}
      </Card>

      <AuditCard />
    </>
  );
}

function AuditCard() {
  const [items, setItems] = useState<AuditItem[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);

  const load = useCallback(async (reset: boolean, from?: string | null) => {
    setLoading(true);
    try {
      const r = await api.get<Page<AuditItem>>(`/audit${qs({ limit: 25, cursor: reset ? undefined : from })}`);
      setItems((p) => (reset ? r.items : [...p, ...r.items]));
      setCursor(r.nextCursor);
    } catch (e) {
      setError(e);
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => { void load(true); }, [load]);

  return (
    <Card title="Auditoria administrativa" className="mt-4">
      {error ? <ErrorBox error={error} /> : null}
      <div className="overflow-x-auto">
        <table>
          <thead><tr><th>Quando</th><th>Ação</th><th>Recurso</th><th>Resultado</th><th>Metadados (redigidos)</th></tr></thead>
          <tbody>
            {items.map((a) => (
              <tr key={a.id}>
                <td className="whitespace-nowrap text-sm"><Time iso={a.at} /></td>
                <td className="mono text-sm">{a.action}</td>
                <td className="mono text-xs">{a.resource ?? '—'}</td>
                <td><Badge kind={a.result === 'success' ? 'ok' : a.result === 'denied' ? 'warn' : 'bad'}>{a.result === 'success' ? 'Sucesso' : a.result === 'denied' ? 'Negado' : 'Falha'}</Badge></td>
                <td className="mono text-xs">{Object.keys(a.metadata).length ? JSON.stringify(a.metadata) : '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {loading && <Spinner />}
      {cursor && !loading && <div className="mt-3 text-center"><Button variant="secondary" onClick={() => void load(false, cursor)}>Carregar mais</Button></div>}
    </Card>
  );
}
