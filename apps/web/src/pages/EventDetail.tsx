import type { ReactNode } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api } from '../api';
import {
  Badge, Card, CLIENT_LABEL, ENRICHMENT_LABEL, ErrorBox, INTEL_STATUS_LABEL, PageHeader, RiskBadge, Spinner, Time, intelKind, useAsync,
} from '../ui';
import type { EventDetail, Evidence, IntelRow } from '../types';

function Row({ k, children }: { k: string; children: ReactNode }) {
  return (
    <div className="grid grid-cols-3 gap-2 border-b py-2 text-sm last:border-b-0" style={{ borderColor: 'var(--border)' }}>
      <dt style={{ color: 'var(--muted)' }}>{k}</dt>
      <dd className="col-span-2 break-words">{children}</dd>
    </div>
  );
}

export function EvidenceTable({ evidence }: { evidence: Evidence[] }) {
  if (evidence.length === 0) return <p className="text-sm" style={{ color: 'var(--muted)' }}>Sem evidências aplicáveis (risco não avaliado por falta de fontes mínimas).</p>;
  return (
    <div className="overflow-x-auto">
      <table>
        <thead><tr><th>Regra</th><th>Pontos</th><th>Valor observado</th><th>Fonte</th><th>Consultado em</th><th>Versão</th></tr></thead>
        <tbody>
          {evidence.map((e, i) => (
            <tr key={`${e.rule}-${i}`}>
              <td><code>{e.rule}</code>{e.note && <div className="text-xs" style={{ color: 'var(--muted)' }}>{e.note}</div>}</td>
              <td className="font-semibold">+{e.points}</td>
              <td>{String(e.observed)}</td>
              <td>{e.source}</td>
              <td className="text-sm"><Time iso={e.at} /></td>
              <td className="mono">{e.version}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function IntelTable({ rows }: { rows: IntelRow[] }) {
  if (rows.length === 0) return <p className="text-sm" style={{ color: 'var(--muted)' }}>Nenhum provedor consultado para este IP.</p>;
  return (
    <div className="overflow-x-auto">
      <table>
        <thead><tr><th>Fonte</th><th>Estado</th><th>Verificado em</th><th>Expira em</th><th>Detalhes</th></tr></thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.source}>
              <td className="font-medium">{r.source}</td>
              <td><Badge kind={intelKind(r.status)}>{INTEL_STATUS_LABEL[r.status] ?? r.status}</Badge>{r.errorCode && <div className="text-xs" style={{ color: 'var(--muted)' }}>{r.errorCode}</div>}</td>
              <td className="text-sm"><Time iso={r.checkedAt} /></td>
              <td className="text-sm"><Time iso={r.expiresAt} /></td>
              <td className="mono text-xs">{r.data ? JSON.stringify(r.data) : '—'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function EventDetailPage() {
  const { id } = useParams();
  const { data: ev, error, loading, reload } = useAsync(() => api.get<EventDetail>(`/events/${id}`), [id]);

  if (loading && !ev) return <Spinner />;
  if (error || !ev) return <ErrorBox error={error ?? new Error('Evento não encontrado')} onRetry={reload} />;

  return (
    <>
      <PageHeader
        title="Detalhe do evento"
        subtitle={<><Link to="/eventos">← Voltar aos eventos</Link></>}
        actions={<RiskBadge level={ev.risk.level} score={ev.risk.score} />}
      />
      <p className="mb-4 rounded-lg p-3 text-sm" style={{ background: 'var(--info-bg)', color: 'var(--info-fg)' }}>{ev.notice}</p>
      <div className="grid gap-4 lg:grid-cols-2">
        <Card title="Origem e requisição">
          <dl>
            <Row k="Quando"><Time iso={ev.occurredAt} /> <span style={{ color: 'var(--muted)' }}>(UTC {ev.occurredAt})</span></Row>
            <Row k="IP"><Link className="mono" to={`/ips/${encodeURIComponent(ev.ipAddress)}`}>{ev.ipAddress}</Link></Row>
            <Row k="Link">{ev.slug}{ev.link.label ? ` — ${ev.link.label}` : ''}{ev.link.targetUrl && <div className="break-all text-xs" style={{ color: 'var(--muted)' }}>→ {ev.link.targetUrl}</div>}</Row>
            <Row k="Método / status">{ev.method} · HTTP {ev.httpStatus}</Row>
            <Row k="Classificação">{CLIENT_LABEL[ev.clientClass] ?? ev.clientClass} <span className="text-xs" style={{ color: 'var(--muted)' }}>(heurística; não é clique confirmado)</span></Row>
            <Row k="User-Agent declarado"><span className="mono">{ev.userAgent ?? '—'}</span></Row>
            <Row k="Idioma">{ev.acceptLanguage ?? '—'}</Row>
            <Row k="Origem do Referer">{ev.refererOrigin ?? '—'}</Row>
          </dl>
        </Card>
        <Card title="Dados estimados">
          <dl>
            <Row k="Dispositivo">{[ev.device.class, ev.device.browser, ev.device.os].filter(Boolean).join(' · ') || '—'}</Row>
            <Row k="Local aproximado">{[ev.geo.city, ev.geo.region, ev.geo.country].filter(Boolean).join(', ') || '—'}</Row>
            <Row k="ASN">{ev.geo.asn ? `AS${ev.geo.asn} ${ev.geo.asnOrg ?? ''}` : '—'}</Row>
            <Row k="DNS reverso">{ev.rdns ?? '—'}</Row>
            <Row k="Saída Tor">{ev.torExit === 'true' ? 'Sim' : ev.torExit === 'false' ? 'Não' : 'Desconhecido'}</Row>
            <Row k="Enriquecimento">{ENRICHMENT_LABEL[ev.enrichmentStatus] ?? ev.enrichmentStatus}{ev.enrichedAt && <> · <Time iso={ev.enrichedAt} /></>}</Row>
          </dl>
        </Card>
      </div>

      <Card title="Avaliação de risco" className="mt-4">
        {ev.assessment ? (
          <>
            <p className="mb-3 text-sm">Motor <code>v{ev.assessment.engineVersion}</code> · avaliado em <Time iso={ev.assessment.assessedAt} /> · resultado: <RiskBadge level={ev.assessment.level} score={ev.assessment.score} /></p>
            <EvidenceTable evidence={ev.assessment.evidence} />
          </>
        ) : (
          <p className="text-sm" style={{ color: 'var(--muted)' }}>Ainda não avaliado ({ENRICHMENT_LABEL[ev.enrichmentStatus] ?? ev.enrichmentStatus}). Ausência de avaliação não significa que o endereço seja seguro.</p>
        )}
      </Card>

      <Card title="Fontes de inteligência" className="mt-4"><IntelTable rows={ev.intelligence} /></Card>
    </>
  );
}
