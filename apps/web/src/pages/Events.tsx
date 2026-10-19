import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { Link as RouterLink, useSearchParams } from 'react-router-dom';
import { ApiError, api, qs } from '../api';
import {
  Button, Card, CLIENT_LABEL, Empty, ENRICHMENT_LABEL, ErrorBox, Field, PageHeader, RiskBadge, Spinner, Time,
} from '../ui';
import type { EventItem, ExportItem, Link, Page } from '../types';

const FILTER_KEYS = ['ip', 'linkId', 'from', 'to', 'country', 'riskLevel', 'method', 'clientClass', 'enrichmentStatus', 'minScore'] as const;

export function EventsPage() {
  const [params, setParams] = useSearchParams();
  const [items, setItems] = useState<EventItem[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);
  const [links, setLinks] = useState<Link[]>([]);
  const [showExport, setShowExport] = useState(false);

  const filters = Object.fromEntries(FILTER_KEYS.map((k) => [k, params.get(k) ?? '']));
  const query = JSON.stringify(filters);

  useEffect(() => {
    api.get<Page<Link>>('/links?limit=100').then((r) => setLinks(r.items)).catch(() => undefined);
  }, []);

  const load = useCallback(async (reset: boolean, from?: string | null) => {
    setLoading(true);
    setError(null);
    try {
      const f = JSON.parse(query) as Record<string, string>;
      const apiFilters = { ...f, from: f.from ? new Date(f.from).toISOString() : '', to: f.to ? new Date(f.to).toISOString() : '' };
      const r = await api.get<Page<EventItem>>(`/events${qs({ ...apiFilters, limit: 50, cursor: reset ? undefined : from })}`);
      setItems((prev) => (reset ? r.items : [...prev, ...r.items]));
      setCursor(r.nextCursor);
    } catch (e) {
      setError(e);
    } finally {
      setLoading(false);
    }
  }, [query]);

  useEffect(() => {
    void load(true);
  }, [load]);

  const apply = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const fd = new FormData(e.currentTarget);
    const next = new URLSearchParams();
    for (const k of FILTER_KEYS) {
      const v = String(fd.get(k) ?? '').trim();
      if (v) next.set(k, v);
    }
    setParams(next);
  };

  return (
    <>
      <PageHeader
        title="Eventos"
        subtitle="Cada linha é uma requisição ao link curto — não necessariamente um clique humano. Horários exibidos no fuso local (passe o mouse para ver UTC)."
        actions={<Button variant="secondary" onClick={() => setShowExport(true)}>Exportar…</Button>}
      />

      <Card className="mb-5">
        <form onSubmit={apply} key={query} className="grid grid-cols-2 gap-3 md:grid-cols-4 lg:grid-cols-5">
          <Field label="IP"><input name="ip" defaultValue={filters.ip} placeholder="203.0.113.42" className="mono w-full" /></Field>
          <Field label="Link">
            <select name="linkId" defaultValue={filters.linkId} className="w-full">
              <option value="">Todos</option>
              {links.map((l) => <option key={l.id} value={l.id}>{l.slug}</option>)}
            </select>
          </Field>
          <Field label="De"><input type="datetime-local" name="from" defaultValue={filters.from} className="w-full" /></Field>
          <Field label="Até"><input type="datetime-local" name="to" defaultValue={filters.to} className="w-full" /></Field>
          <Field label="País (ISO)"><input name="country" maxLength={2} defaultValue={filters.country} placeholder="BR" className="w-full uppercase" /></Field>
          <Field label="Risco">
            <select name="riskLevel" defaultValue={filters.riskLevel} className="w-full">
              <option value="">Todos</option><option value="high">Alto</option><option value="medium">Médio</option><option value="low">Baixo</option><option value="not_evaluated">Não avaliado</option>
            </select>
          </Field>
          <Field label="Score mínimo"><input type="number" min={0} max={100} name="minScore" defaultValue={filters.minScore} className="w-full" /></Field>
          <Field label="Método">
            <select name="method" defaultValue={filters.method} className="w-full"><option value="">Todos</option><option>GET</option><option>HEAD</option></select>
          </Field>
          <Field label="Classe do cliente">
            <select name="clientClass" defaultValue={filters.clientClass} className="w-full">
              <option value="">Todas</option>
              {Object.entries(CLIENT_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
            </select>
          </Field>
          <Field label="Enriquecimento">
            <select name="enrichmentStatus" defaultValue={filters.enrichmentStatus} className="w-full">
              <option value="">Todos</option>
              {Object.entries(ENRICHMENT_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
            </select>
          </Field>
          <div className="col-span-2 flex items-end gap-2 md:col-span-4 lg:col-span-5">
            <Button type="submit">Filtrar</Button>
            <Button type="button" variant="secondary" onClick={() => setParams(new URLSearchParams())}>Limpar</Button>
          </div>
        </form>
      </Card>

      <Card>
        {error ? <ErrorBox error={error} onRetry={() => void load(true)} /> : null}
        {!loading && !error && items.length === 0 ? <Empty>Nenhum evento para os filtros selecionados.</Empty> : null}
        {items.length > 0 && (
          <div className="overflow-x-auto">
            <table>
              <thead><tr><th>Quando</th><th>IP</th><th>Link</th><th>Cliente</th><th>Local (estimado)</th><th>Risco</th><th>Enriquecimento</th></tr></thead>
              <tbody>
                {items.map((ev) => (
                  <tr key={ev.id}>
                    <td className="whitespace-nowrap text-sm"><RouterLink to={`/eventos/${ev.id}`}><Time iso={ev.occurredAt} /></RouterLink></td>
                    <td className="mono"><RouterLink to={`/ips/${encodeURIComponent(ev.ipAddress)}`}>{ev.ipAddress}</RouterLink></td>
                    <td className="mono text-sm">{ev.slug}</td>
                    <td className="text-sm">{CLIENT_LABEL[ev.clientClass] ?? ev.clientClass}<div className="text-xs" style={{ color: 'var(--muted)' }}>{ev.method} · {ev.device.browser ?? '—'}{ev.device.os ? ` / ${ev.device.os}` : ''}</div></td>
                    <td className="text-sm">{[ev.geo.city, ev.geo.country].filter(Boolean).join(', ') || '—'}{ev.geo.asn && <div className="text-xs" style={{ color: 'var(--muted)' }}>AS{ev.geo.asn} {ev.geo.asnOrg}</div>}</td>
                    <td><RiskBadge level={ev.risk.level} score={ev.risk.score} /></td>
                    <td className="text-sm">{ENRICHMENT_LABEL[ev.enrichmentStatus] ?? ev.enrichmentStatus}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {loading && <Spinner />}
        {cursor && !loading && <div className="mt-3 text-center"><Button variant="secondary" onClick={() => void load(false, cursor)}>Carregar mais</Button></div>}
      </Card>

      {showExport && <ExportDialog filters={filters} onClose={() => setShowExport(false)} />}
    </>
  );
}

function ExportDialog({ filters, onClose }: { filters: Record<string, string>; onClose: () => void }) {
  const [format, setFormat] = useState<'csv' | 'json'>('csv');
  const [fullIp, setFullIp] = useState(false);
  const [password, setPassword] = useState('');
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const [job, setJob] = useState<ExportItem | null>(null);

  useEffect(() => {
    if (!job || job.status === 'ready' || job.status === 'failed') return;
    const t = setInterval(async () => {
      try {
        const r = await api.get<ExportItem>(`/exports/${job.id}`);
        setJob((j) => (j ? { ...j, ...r } : j));
      } catch (e) {
        setError(e);
      }
    }, 2000);
    return () => clearInterval(t);
  }, [job]);

  const start = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.post('/auth/reauth', { password });
      setPassword('');
      const f = { ...filters, from: filters.from ? new Date(filters.from).toISOString() : '', to: filters.to ? new Date(filters.to).toISOString() : '' };
      const clean = Object.fromEntries(Object.entries(f).filter(([, v]) => v !== ''));
      if (clean.minScore) clean.minScore = Number(clean.minScore) as unknown as string;
      const r = await api.post<{ id: string; status: string; expiresAt: string }>('/exports', { format, filters: clean, fullIp });
      setJob({ id: r.id, format, status: r.status, rowCount: null, maskedIp: !fullIp, createdAt: new Date().toISOString(), expiresAt: r.expiresAt });
    } catch (err) {
      setError(err instanceof ApiError && err.status === 401 ? new Error('Senha incorreta') : err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div role="dialog" aria-modal="true" aria-label="Exportar eventos" className="fixed inset-0 z-40 flex items-center justify-center bg-black/50 p-4">
      <div className="w-full max-w-lg rounded-xl border p-5" style={{ background: 'var(--surface)', borderColor: 'var(--border)' }}>
        <h2 className="mb-1 text-lg font-semibold">Exportar eventos filtrados</h2>
        <p className="mb-4 text-sm" style={{ color: 'var(--muted)' }}>Exige confirmação da senha. A ação é auditada e o arquivo expira em minutos. Por padrão o IP é mascarado (IPv4 /24, IPv6 /48).</p>
        {!job ? (
          <form onSubmit={start} className="flex flex-col gap-3">
            <Field label="Formato">
              <select value={format} onChange={(e) => setFormat(e.target.value as 'csv' | 'json')} className="w-full"><option value="csv">CSV</option><option value="json">JSON</option></select>
            </Field>
            <label className="flex items-start gap-2 text-sm" style={{ color: 'var(--text)' }}>
              <input type="checkbox" checked={fullIp} onChange={(e) => setFullIp(e.target.checked)} className="mt-1" />
              <span>Incluir IP completo (use somente se a investigação exigir; ficará registrado na auditoria)</span>
            </label>
            <Field label="Confirme sua senha"><input type="password" required autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} className="w-full" /></Field>
            {error ? <ErrorBox error={error} /> : null}
            <div className="flex justify-end gap-2"><Button type="button" variant="secondary" onClick={onClose}>Cancelar</Button><Button type="submit" disabled={busy}>Gerar exportação</Button></div>
          </form>
        ) : (
          <div className="flex flex-col gap-3">
            {job.status === 'ready' ? (
              <>
                <p className="text-sm">Pronto: {job.rowCount} linha(s). Expira em <Time iso={job.expiresAt} />.</p>
                <Button onClick={() => void api.download(`/exports/${job.id}/download`, `eventos.${job.format}`)}>Baixar arquivo</Button>
              </>
            ) : job.status === 'failed' ? (
              <ErrorBox error={new Error('A exportação falhou. Revise os filtros e tente novamente.')} />
            ) : (
              <Spinner label="Gerando exportação…" />
            )}
            {error ? <ErrorBox error={error} /> : null}
            <div className="flex justify-end"><Button variant="secondary" onClick={onClose}>Fechar</Button></div>
          </div>
        )}
      </div>
    </div>
  );
}
