import { useCallback, useEffect, useState } from 'react';
import { api, qs } from '../api';
import { Badge, Button, Card, Empty, ErrorBox, Field, PageHeader, Spinner, Time } from '../ui';
import type { Page, ReportItem } from '../types';

const REASON: Record<string, string> = {
  tracking_without_consent: 'Rastreamento sem consentimento',
  phishing_or_fraud: 'Phishing / fraude',
  harassment: 'Assédio',
  illegal_content: 'Conteúdo ilegal',
  other: 'Outro',
};
const STATUS: Record<ReportItem['status'], { label: string; kind: 'warn' | 'info' | 'bad' | 'neutral' }> = {
  open: { label: 'Aberta', kind: 'warn' },
  reviewing: { label: 'Em análise', kind: 'info' },
  link_disabled: { label: 'Link desativado', kind: 'bad' },
  dismissed: { label: 'Arquivada', kind: 'neutral' },
};

export function ReportsPage() {
  const [status, setStatus] = useState('open');
  const [items, setItems] = useState<ReportItem[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);

  const load = useCallback(async (reset: boolean, from?: string | null) => {
    setLoading(true);
    setError(null);
    try {
      const r = await api.get<Page<ReportItem>>(`/reports${qs({ status, limit: 25, cursor: reset ? undefined : from })}`);
      setItems((p) => (reset ? r.items : [...p, ...r.items]));
      setCursor(r.nextCursor);
    } catch (e) {
      setError(e);
    } finally {
      setLoading(false);
    }
  }, [status]);
  useEffect(() => { void load(true); }, [load]);

  const act = async (r: ReportItem, body: { status: ReportItem['status']; suspendOwner?: boolean }, confirm?: string) => {
    if (confirm && !window.confirm(confirm)) return;
    try {
      await api.patch(`/reports/${r.id}`, body);
      await load(true);
    } catch (e) {
      setError(e);
    }
  };

  return (
    <>
      <PageHeader title="Denúncias de abuso" subtitle="Enviadas publicamente, sem login. O IP do denunciante não é registrado." />
      <Card className="mb-4">
        <Field label="Estado">
          <select value={status} onChange={(e) => setStatus(e.target.value)}>
            <option value="">Todas</option><option value="open">Abertas</option><option value="reviewing">Em análise</option><option value="link_disabled">Link desativado</option><option value="dismissed">Arquivadas</option>
          </select>
        </Field>
      </Card>
      {error ? <ErrorBox error={error} onRetry={() => void load(true)} /> : null}
      {!loading && !error && items.length === 0 ? <Card><Empty>Nenhuma denúncia.</Empty></Card> : null}
      <div className="flex flex-col gap-3">
        {items.map((r) => (
          <Card key={r.id}>
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="min-w-0">
                <div className="mb-1 flex flex-wrap items-center gap-2">
                  <Badge kind={STATUS[r.status].kind}>{STATUS[r.status].label}</Badge>
                  <Badge kind="neutral">{REASON[r.reason] ?? r.reason}</Badge>
                  <span className="text-xs" style={{ color: 'var(--muted)' }}><Time iso={r.createdAt} /></span>
                </div>
                <h2 className="mono text-base font-semibold">{r.slug.includes('/') ? r.slug : `/${r.slug}`}</h2>
                {r.targetUrl && <p className="break-all text-sm" style={{ color: 'var(--muted)' }}>Destino: {r.targetUrl}</p>}
                <p className="text-sm">Dono: {r.owner ? <>{r.owner.email} <Badge kind={r.owner.status === 'active' ? 'ok' : 'bad'}>{r.owner.status}</Badge></> : <em>link não encontrado</em>}</p>
                {r.details && <p className="mt-2 whitespace-pre-wrap text-sm">{r.details}</p>}
                {r.contact && <p className="mt-1 text-xs" style={{ color: 'var(--muted)' }}>Contato do denunciante: {r.contact}</p>}
              </div>
              <div className="flex flex-wrap gap-1.5">
                {r.status !== 'reviewing' && r.status !== 'link_disabled' && <Button variant="secondary" onClick={() => void act(r, { status: 'reviewing' })}>Analisar</Button>}
                {r.linkId && r.status !== 'link_disabled' && <Button variant="danger" onClick={() => void act(r, { status: 'link_disabled' }, `Desativar o link /${r.slug}?`)}>Desativar link</Button>}
                {r.linkId && r.owner && r.owner.status === 'active' && <Button variant="danger" onClick={() => void act(r, { status: 'link_disabled', suspendOwner: true }, `Desativar o link e SUSPENDER a conta ${r.owner?.email} (todos os links dela serão desativados)?`)}>Suspender dono</Button>}
                {r.status !== 'dismissed' && <Button variant="secondary" onClick={() => void act(r, { status: 'dismissed' })}>Arquivar</Button>}
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
