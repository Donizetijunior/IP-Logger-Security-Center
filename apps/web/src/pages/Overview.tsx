import { useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api';
import { useSession } from '../session';
import { Card, ErrorBox, PageHeader, Spinner, Time, useAsync } from '../ui';
import type { SeriesPoint, Summary } from '../types';

const PERIODS = [
  { id: '24h', label: '24 horas' },
  { id: '7d', label: '7 dias' },
  { id: '30d', label: '30 dias' },
];

function Kpi({ label, value, hint, tone }: { label: string; value: number | string; hint?: string; tone?: 'bad' | 'warn' }) {
  const color = tone === 'bad' ? 'var(--bad-fg)' : tone === 'warn' ? 'var(--warn-fg)' : 'var(--text)';
  return (
    <div className="rounded-xl border p-4" style={{ background: 'var(--surface)', borderColor: 'var(--border)' }}>
      <div className="text-xs font-semibold uppercase tracking-wide" style={{ color: 'var(--muted)' }}>{label}</div>
      <div className="mt-1 text-3xl font-semibold" style={{ color }}>{value}</div>
      {hint && <div className="mt-1 text-xs" style={{ color: 'var(--muted)' }}>{hint}</div>}
    </div>
  );
}

function TimeSeries({ points, period }: { points: SeriesPoint[]; period: string }) {
  const W = 800;
  const H = 220;
  const pad = { l: 36, r: 8, t: 8, b: 24 };
  const max = Math.max(1, ...points.map((p) => p.total));
  const bw = (W - pad.l - pad.r) / Math.max(points.length, 1);
  const y = (v: number) => pad.t + (H - pad.t - pad.b) * (1 - v / max);
  const fmt = (iso: string) => {
    const d = new Date(iso);
    return period === '30d' ? d.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' }) : d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
  };
  const labelEvery = Math.max(1, Math.ceil(points.length / 8));
  const alt = points.map((p) => `${fmt(p.at)}: ${p.total} requisições`).join('; ');
  return (
    <figure>
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`Requisições por intervalo. ${alt}`} className="w-full">
        {[0, 0.5, 1].map((f) => (
          <g key={f}>
            <line x1={pad.l} x2={W - pad.r} y1={y(max * f)} y2={y(max * f)} stroke="var(--border)" />
            <text x={pad.l - 6} y={y(max * f) + 4} textAnchor="end" fontSize="11" fill="var(--muted)">{Math.round(max * f)}</text>
          </g>
        ))}
        {points.map((p, i) => {
          const x = pad.l + i * bw + 1;
          const w = Math.max(bw - 2, 1);
          const other = Math.max(p.total - p.estimatedVisits - p.bots - p.previews, 0);
          let acc = 0;
          const seg = (v: number, fill: string, key: string) => {
            const top = y(acc + v);
            const h = y(acc) - top;
            acc += v;
            return h > 0 ? <rect key={key} x={x} y={top} width={w} height={h} fill={fill} /> : null;
          };
          return (
            <g key={p.at}>
              <title>{`${fmt(p.at)} — total ${p.total}; prováveis usuários ${p.estimatedVisits}; robôs ${p.bots}; prévias ${p.previews}`}</title>
              {seg(p.estimatedVisits, 'var(--chart-1)', 'h')}
              {seg(p.bots, 'var(--chart-2)', 'b')}
              {seg(p.previews, 'var(--chart-3)', 'p')}
              {seg(other, 'var(--chart-4)', 'o')}
              {i % labelEvery === 0 && (
                <text x={x + w / 2} y={H - 6} textAnchor="middle" fontSize="11" fill="var(--muted)">{fmt(p.at)}</text>
              )}
            </g>
          );
        })}
      </svg>
      <figcaption className="mt-2 flex flex-wrap gap-4 text-xs" style={{ color: 'var(--muted)' }}>
        {[['Prováveis usuários', 'var(--chart-1)'], ['Robôs/ferramentas', 'var(--chart-2)'], ['Prévias de link', 'var(--chart-3)'], ['Demais (HEAD/desconhecido)', 'var(--chart-4)']].map(([l, c]) => (
          <span key={l} className="inline-flex items-center gap-1.5"><span className="inline-block h-3 w-3 rounded-sm" style={{ background: c }} />{l}</span>
        ))}
      </figcaption>
    </figure>
  );
}

export function OverviewPage() {
  const { me } = useSession();
  const [period, setPeriod] = useState('24h');
  const summary = useAsync(() => api.get<Summary>(`/dashboard/summary?period=${period}`), [period]);
  const series = useAsync(() => api.get<{ points: SeriesPoint[] }>(`/dashboard/timeseries?period=${period}`), [period]);
  const s = summary.data;
  const openAlerts = s ? Object.values(s.openAlerts).reduce((a, b) => a + b, 0) : 0;
  const hbStale = s && me.role === 'admin' && (!s.workerHeartbeatAt || Date.now() - Date.parse(s.workerHeartbeatAt) > 180_000);

  return (
    <>
      <PageHeader
        title="Visão geral"
        subtitle="Acessos a links curtos para análise de segurança. Valores são estimativas sobre endereços de rede."
        actions={
          <div role="tablist" aria-label="Período" className="inline-flex overflow-hidden rounded-lg border" style={{ borderColor: 'var(--border)' }}>
            {PERIODS.map((p) => (
              <button
                key={p.id}
                role="tab"
                aria-selected={period === p.id}
                onClick={() => setPeriod(p.id)}
                className="px-3 py-1.5 text-sm"
                style={{ background: period === p.id ? 'var(--accent)' : 'var(--surface)', color: period === p.id ? 'var(--accent-contrast)' : 'var(--text)' }}
              >
                {p.label}
              </button>
            ))}
          </div>
        }
      />

      {summary.error ? <ErrorBox error={summary.error} onRetry={summary.reload} /> : null}
      {summary.loading && !s ? <Spinner /> : null}

      {s && (
        <>
          {(s.captureFailures > 0 || hbStale) && (
            <div role="alert" className="mb-4 rounded-lg p-3 text-sm" style={{ background: 'var(--bad-bg)', color: 'var(--bad-fg)' }}>
              {s.captureFailures > 0 && <div><strong>Telemetria perdida:</strong> {s.captureFailures} acesso(s) não puderam ser registrados no período (banco indisponível). O redirecionamento seguiu normalmente.</div>}
              {hbStale && <div><strong>Worker sem sinal de vida</strong>: enriquecimento e alertas podem estar parados.</div>}
            </div>
          )}
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <Kpi label="Requisições" value={s.requestsTotal} hint="Todas as chamadas aos links" />
            <Kpi label="IPs únicos" value={s.uniqueIps} />
            <Kpi label="Visitas estimadas" value={s.estimatedVisits} hint="GET com navegador convencional — não é clique confirmado" />
            <Kpi label="Links ativos" value={s.activeLinks} />
            <Kpi label="Risco alto" value={s.highRiskEvents} tone={s.highRiskEvents ? 'bad' : undefined} hint="Eventos com score ≥ 70" />
            <Kpi label="Alertas abertos" value={openAlerts} tone={openAlerts ? 'warn' : undefined} />
            <Kpi label="Falhas de enriquecimento" value={s.enrichmentFailures} tone={s.enrichmentFailures ? 'warn' : undefined} hint={`${s.enrichmentPending} pendente(s)`} />
            <Kpi label="Robôs / prévias / HEAD" value={`${s.breakdown.bots} / ${s.breakdown.previews} / ${s.breakdown.headProbes}`} />
          </div>
          <p className="mt-2 text-xs" style={{ color: 'var(--muted)' }}>{s.estimatedVisitsNote}</p>
        </>
      )}

      <Card title="Requisições por intervalo" className="mt-5">
        {series.error ? <ErrorBox error={series.error} onRetry={series.reload} /> : series.data ? <TimeSeries points={series.data.points} period={period} /> : <Spinner />}
      </Card>

      {s && openAlerts > 0 && (
        <p className="mt-4 text-sm">
          Há {openAlerts} alerta(s) em aberto. <Link to="/alertas">Ver alertas</Link>
          {s.workerHeartbeatAt && <span style={{ color: 'var(--muted)' }}> · último sinal do worker: <Time iso={s.workerHeartbeatAt} /></span>}
        </p>
      )}
    </>
  );
}
