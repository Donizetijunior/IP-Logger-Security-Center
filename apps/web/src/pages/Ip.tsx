import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api } from '../api';
import { Button, Card, CLIENT_LABEL, ErrorBox, PageHeader, RiskBadge, Spinner, Time, useAsync } from '../ui';
import type { IpProfile } from '../types';
import { IntelTable } from './EventDetail';

export function IpPage() {
  const { ip = '' } = useParams();
  const [withRdap, setWithRdap] = useState(false);
  const { data, error, loading, reload } = useAsync(() => api.get<IpProfile>(`/ips/${encodeURIComponent(ip)}?rdap=${withRdap}`), [ip, withRdap]);

  if (loading && !data) return <Spinner />;
  if (error || !data) return <ErrorBox error={error ?? new Error('IP não encontrado')} onRetry={reload} />;
  const s = data.summary;

  return (
    <>
      <PageHeader
        title={`Investigação de IP`}
        subtitle={<><span className="mono text-base">{data.ip}</span> · <Link to="/eventos">← Eventos</Link></>}
        actions={<RiskBadge level={s.latestRiskLevel} score={s.maxRiskScore} />}
      />
      <p className="mb-4 rounded-lg p-3 text-sm" style={{ background: 'var(--info-bg)', color: 'var(--info-fg)' }}>{data.notice}</p>

      <div className="grid gap-4 lg:grid-cols-3">
        <Card title="Resumo">
          <dl className="text-sm">
            <div className="flex justify-between py-1"><dt style={{ color: 'var(--muted)' }}>Eventos</dt><dd>{s.totalEvents}</dd></div>
            <div className="flex justify-between py-1"><dt style={{ color: 'var(--muted)' }}>Primeiro visto</dt><dd><Time iso={s.firstSeenAt} /></dd></div>
            <div className="flex justify-between py-1"><dt style={{ color: 'var(--muted)' }}>Último visto</dt><dd><Time iso={s.lastSeenAt} /></dd></div>
            <div className="flex justify-between py-1"><dt style={{ color: 'var(--muted)' }}>Local aprox.</dt><dd>{s.geo ? [s.geo.city, s.geo.country].filter(Boolean).join(', ') || '—' : '—'}</dd></div>
            <div className="flex justify-between py-1"><dt style={{ color: 'var(--muted)' }}>ASN</dt><dd>{s.geo?.asn ? `AS${s.geo.asn}` : '—'}</dd></div>
            <div className="flex justify-between py-1"><dt style={{ color: 'var(--muted)' }}>DNS reverso</dt><dd className="break-all text-right">{s.rdns ?? '—'}</dd></div>
            <div className="flex justify-between py-1"><dt style={{ color: 'var(--muted)' }}>Saída Tor</dt><dd>{s.torExit === 'true' ? 'Sim' : s.torExit === 'false' ? 'Não' : 'Desconhecido'}</dd></div>
          </dl>
        </Card>
        <Card title="Links acessados" className="lg:col-span-2">
          {data.links.length === 0 ? <p className="text-sm" style={{ color: 'var(--muted)' }}>Nenhum.</p> : (
            <table>
              <thead><tr><th>Link</th><th>Acessos</th><th>Último</th></tr></thead>
              <tbody>{data.links.map((l) => <tr key={l.id}><td><Link to={`/eventos?linkId=${l.id}`}>{l.slug}</Link>{l.label && <span className="text-xs" style={{ color: 'var(--muted)' }}> — {l.label}</span>}</td><td>{l.hits}</td><td><Time iso={l.lastAt} /></td></tr>)}</tbody>
            </table>
          )}
        </Card>
      </div>

      <Card title="Reputação e inteligência" className="mt-4"><IntelTable rows={data.intelligence} /></Card>

      <Card
        title="RDAP (registro de alocação do bloco)"
        className="mt-4"
        actions={!withRdap ? <Button variant="secondary" onClick={() => setWithRdap(true)}>Consultar RDAP agora</Button> : undefined}
      >
        {data.rdap ? <pre className="mono overflow-x-auto text-xs">{JSON.stringify(data.rdap, null, 2)}</pre> : <p className="text-sm" style={{ color: 'var(--muted)' }}>Sem dado RDAP em cache. Use “Consultar RDAP agora” (somente IPs públicos; host fixo do serviço).</p>}
      </Card>

      <Card title="Linha do tempo" className="mt-4">
        <div className="overflow-x-auto">
          <table>
            <thead><tr><th>Quando</th><th>Link</th><th>Cliente</th><th>Risco</th></tr></thead>
            <tbody>
              {data.timeline.map((ev) => (
                <tr key={ev.id}>
                  <td className="whitespace-nowrap text-sm"><Link to={`/eventos/${ev.id}`}><Time iso={ev.occurredAt} /></Link></td>
                  <td className="mono text-sm">{ev.slug}</td>
                  <td className="text-sm">{CLIENT_LABEL[ev.clientClass] ?? ev.clientClass} · {ev.method}</td>
                  <td><RiskBadge level={ev.risk.level} score={ev.risk.score} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
    </>
  );
}
