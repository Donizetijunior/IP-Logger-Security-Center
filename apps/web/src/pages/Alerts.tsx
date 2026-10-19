import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, qs } from '../api';
import { Badge, Button, Card, Empty, ErrorBox, Field, PageHeader, SEVERITY_LABEL, STATUS_LABEL, Spinner, Time, severityKind } from '../ui';
import type { AlertItem, Page } from '../types';

const TYPE_LABEL: Record<string, string> = {
  ip_high_risk: 'IP com risco alto',
  ip_rate_anomaly: 'Taxa anômala por IP',
  link_traffic_spike: 'Pico de acessos em link',
  ip_multi_link: 'IP em vários links',
  provider_unavailable: 'Provedor indisponível',
  provider_quota_exhausted: 'Cota de provedor esgotada',
  capture_failure: 'Falha de captura',
  outbox_lag: 'Outbox atrasada',
  queue_stuck: 'Fila travada',
  storage_critical: 'Armazenamento crítico',
  worker_down: 'Worker parado',
};

export function AlertsPage() {
  const [status, setStatus] = useState('open');
  const [severity, setSeverity] = useState('');
  const [items, setItems] = useState<AlertItem[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);

  const load = useCallback(async (reset: boolean, from?: string | null) => {
    setLoading(true);
    setError(null);
    try {
      const r = await api.get<Page<AlertItem>>(`/alerts${qs({ status, severity, limit: 20, cursor: reset ? undefined : from })}`);
      setItems((p) => (reset ? r.items : [...p, ...r.items]));
      setCursor(r.nextCursor);
    } catch (e) {
      setError(e);
    } finally {
      setLoading(false);
    }
  }, [status, severity]);

  useEffect(() => {
    void load(true);
  }, [load]);

  const setAlertStatus = async (a: AlertItem, next: AlertItem['status']) => {
    await api.patch(`/alerts/${a.id}`, { status: next });
    await load(true);
  };

  return (
    <>
      <PageHeader title="Alertas" subtitle="Alertas internos, exibidos somente no painel. Não há bloqueio automático por score." />
      <Card className="mb-4">
        <div className="flex flex-wrap gap-3">
          <Field label="Estado">
            <select value={status} onChange={(e) => setStatus(e.target.value)}>
              <option value="">Todos</option><option value="open">Abertos</option><option value="investigating">Em investigação</option><option value="resolved">Resolvidos</option>
            </select>
          </Field>
          <Field label="Severidade">
            <select value={severity} onChange={(e) => setSeverity(e.target.value)}>
              <option value="">Todas</option>
              {Object.entries(SEVERITY_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
            </select>
          </Field>
        </div>
      </Card>

      {error ? <ErrorBox error={error} onRetry={() => void load(true)} /> : null}
      {!loading && !error && items.length === 0 ? <Card><Empty>Nenhum alerta para os filtros selecionados.</Empty></Card> : null}

      <div className="flex flex-col gap-3">
        {items.map((a) => (
          <Card key={a.id}>
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="min-w-0">
                <div className="mb-1 flex flex-wrap items-center gap-2">
                  <Badge kind={severityKind(a.severity)}>{SEVERITY_LABEL[a.severity] ?? a.severity}</Badge>
                  <Badge kind={a.status === 'resolved' ? 'ok' : a.status === 'investigating' ? 'info' : 'warn'}>{STATUS_LABEL[a.status]}</Badge>
                  <span className="text-xs" style={{ color: 'var(--muted)' }}>{TYPE_LABEL[a.type] ?? a.type} · regra v{a.ruleVersion}</span>
                </div>
                <h2 className="text-base font-semibold">{a.title}</h2>
                <p className="mt-1 text-xs" style={{ color: 'var(--muted)' }}>
                  Criado <Time iso={a.createdAt} /> · atualizado <Time iso={a.updatedAt} /> · {a.occurrences} ocorrência(s)
                </p>
                <div className="mt-2 flex flex-wrap gap-3 text-sm">
                  {a.ipAddress && <Link to={`/ips/${encodeURIComponent(a.ipAddress)}`}>Investigar IP {a.ipAddress}</Link>}
                  {a.shortLinkId && <Link to={`/eventos?linkId=${a.shortLinkId}`}>Ver eventos do link {a.slug}</Link>}
                </div>
                <details className="mt-2">
                  <summary className="cursor-pointer text-sm">Evidências</summary>
                  <pre className="mono mt-2 overflow-x-auto rounded-lg p-3 text-xs" style={{ background: 'var(--surface-2)' }}>{JSON.stringify(a.evidence, null, 2)}</pre>
                </details>
              </div>
              <div className="flex gap-1.5">
                {a.status !== 'investigating' && a.status !== 'resolved' && <Button variant="secondary" onClick={() => void setAlertStatus(a, 'investigating')}>Investigar</Button>}
                {a.status !== 'resolved' && <Button variant="secondary" onClick={() => void setAlertStatus(a, 'resolved')}>Resolver</Button>}
                {a.status === 'resolved' && <Button variant="secondary" onClick={() => void setAlertStatus(a, 'open')}>Reabrir</Button>}
              </div>
            </div>
          </Card>
        ))}
      </div>
      {loading && <Spinner />}
      {cursor && !loading && <div className="mt-3 text-center"><Button variant="secondary" onClick={() => void load(false, cursor)}>Carregar mais</Button></div>}
    </>
  );
}
