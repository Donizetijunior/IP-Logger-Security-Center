import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { Link as RouterLink } from 'react-router-dom';
import { api, qs } from '../api';
import { useSession } from '../session';
import { Badge, Button, Card, Empty, ErrorBox, Field, PageHeader, Spinner, Time } from '../ui';
import type { Link, Page } from '../types';

const STATUS: Record<Link['status'], { label: string; kind: 'ok' | 'neutral' | 'warn' }> = {
  active: { label: 'Ativo', kind: 'ok' },
  inactive: { label: 'Desativado', kind: 'neutral' },
  expired: { label: 'Expirado', kind: 'warn' },
  deleted: { label: 'Removido', kind: 'neutral' },
};

function toIsoOrNull(local: string): string | null {
  return local ? new Date(local).toISOString() : null;
}

export function LinksPage() {
  const { me, config } = useSession();
  const [items, setItems] = useState<Link[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [q, setQ] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);
  const [formError, setFormError] = useState<unknown>(null);
  const [copied, setCopied] = useState<string | null>(null);
  const [editing, setEditing] = useState<Link | null>(null);

  const [domains, setDomains] = useState<Array<{ id: string; hostname: string }>>([]);
  const [domainId, setDomainId] = useState('');
  useEffect(() => {
    api.get<{ items: Array<{ id: string; hostname: string; status: string }> }>('/domains')
      .then((r) => setDomains(r.items.filter((d) => d.status === 'active')))
      .catch(() => undefined);
  }, []);

  const [targetUrl, setTargetUrl] = useState('');
  const [slug, setSlug] = useState('');
  const [label, setLabel] = useState('');
  const [expiresAt, setExpiresAt] = useState('');

  const load = useCallback(async (reset: boolean, from?: string | null) => {
    setLoading(true);
    setError(null);
    try {
      const r = await api.get<Page<Link>>(`/links${qs({ q, limit: 20, cursor: reset ? undefined : from })}`);
      setItems((prev) => (reset ? r.items : [...prev, ...r.items]));
      setCursor(r.nextCursor);
    } catch (e) {
      setError(e);
    } finally {
      setLoading(false);
    }
  }, [q]);

  useEffect(() => {
    const t = setTimeout(() => void load(true), 250);
    return () => clearTimeout(t);
  }, [load]);

  const create = async (e: FormEvent) => {
    e.preventDefault();
    setFormError(null);
    try {
      await api.post('/links', { targetUrl, slug: slug || undefined, label: label || null, expiresAt: toIsoOrNull(expiresAt), domainId: domainId || undefined });
      setTargetUrl(''); setSlug(''); setLabel(''); setExpiresAt('');
      await load(true);
    } catch (err) {
      setFormError(err);
    }
  };

  const copy = async (l: Link) => {
    try {
      await navigator.clipboard.writeText(l.publicUrl);
      setCopied(l.id);
      setTimeout(() => setCopied(null), 1500);
    } catch {
      window.prompt('Copie a URL:', l.publicUrl);
    }
  };

  const toggle = async (l: Link) => {
    await api.patch(`/links/${l.id}`, { isActive: !l.isActive });
    await load(true);
  };

  const remove = async (l: Link) => {
    if (!window.confirm(`Remover o link "${l.slug}"? Ele deixará de redirecionar; os eventos já registrados seguem a política de retenção.`)) return;
    await api.del(`/links/${l.id}`);
    await load(true);
  };

  return (
    <>
      <PageHeader
        title="Links"
        subtitle={<>Crie e gerencie os links curtos. O destino é validado no cadastro e novamente antes de cada redirecionamento.{me.role !== 'admin' && me.linkQuota !== undefined && <> Seu limite: <strong>{me.linkQuota}</strong> links.</>}</>}
      />

      <Card title="Novo link" className="mb-5">
        <form onSubmit={create} className="grid grid-cols-1 gap-3 md:grid-cols-2 lg:grid-cols-4">
          <Field label="URL de destino (http/https)" className="md:col-span-2 lg:col-span-2">
            <input required type="url" value={targetUrl} onChange={(e) => setTargetUrl(e.target.value)} placeholder="https://exemplo.org/recurso" className="w-full" />
          </Field>
          <Field label="Slug (opcional)">
            <input value={slug} onChange={(e) => setSlug(e.target.value)} placeholder="gerado automaticamente" pattern="[A-Za-z0-9][A-Za-z0-9_\-]{2,63}" className="w-full" />
          </Field>
          <Field label="Validade (opcional)">
            <input type="datetime-local" value={expiresAt} onChange={(e) => setExpiresAt(e.target.value)} className="w-full" />
          </Field>
          {domains.length > 0 && (
            <Field label="Domínio do link" className="md:col-span-2 lg:col-span-4">
              <select value={domainId} onChange={(e) => setDomainId(e.target.value)} className="w-full">
                <option value="">Domínio principal ({config?.shortBaseUrl.replace(/^https?:\/\//, '')})</option>
                {domains.map((d) => <option key={d.id} value={d.id}>{d.hostname}</option>)}
              </select>
            </Field>
          )}
          <Field label="Rótulo / finalidade" className="md:col-span-2 lg:col-span-3">
            <input value={label} maxLength={200} onChange={(e) => setLabel(e.target.value)} placeholder="Ex.: monitoramento de campanha autorizada" className="w-full" />
          </Field>
          <div className="flex items-end"><Button type="submit" className="w-full">Criar link</Button></div>
        </form>
        {formError ? <div className="mt-3"><ErrorBox error={formError} /></div> : null}
      </Card>

      <Card
        title="Links cadastrados"
        actions={<input type="search" aria-label="Buscar links" placeholder="Buscar por slug, rótulo ou destino" value={q} onChange={(e) => setQ(e.target.value)} className="w-64 max-w-full" />}
      >
        {error ? <ErrorBox error={error} onRetry={() => void load(true)} /> : null}
        {!loading && items.length === 0 && !error ? <Empty>Nenhum link encontrado.</Empty> : null}
        {items.length > 0 && (
          <div className="overflow-x-auto">
            <table>
              <thead>
                <tr><th>Link</th><th>Destino</th><th>Estado</th><th>Acessos</th><th>Validade</th><th><span className="sr-only">Ações</span></th></tr>
              </thead>
              <tbody>
                {items.map((l) => (
                  <tr key={l.id}>
                    <td>
                      <div className="mono break-all">{l.publicUrl}</div>
                      {l.label && <div className="text-xs" style={{ color: 'var(--muted)' }}>{l.label}</div>}
                      {l.owner && <div className="text-xs" style={{ color: 'var(--muted)' }}>Dono: {l.owner.email}</div>}
                    </td>
                    <td className="max-w-xs break-all text-sm">{l.targetUrl}</td>
                    <td><Badge kind={STATUS[l.status].kind}>{STATUS[l.status].label}</Badge></td>
                    <td className="text-sm">
                      <RouterLink to={`/eventos?linkId=${l.id}`}>{l.metrics?.requests ?? 0} req.</RouterLink>
                      <div className="text-xs" style={{ color: 'var(--muted)' }}>{l.metrics?.uniqueIps ?? 0} IPs · último: <Time iso={l.metrics?.lastAccessAt} /></div>
                    </td>
                    <td className="text-sm">{l.expiresAt ? <Time iso={l.expiresAt} /> : 'Sem validade'}</td>
                    <td>
                      <div className="flex flex-wrap gap-1.5">
                        <Button variant="secondary" onClick={() => void copy(l)}>{copied === l.id ? 'Copiado!' : 'Copiar URL'}</Button>
                        <Button variant="secondary" onClick={() => setEditing(l)}>Editar</Button>
                        <Button variant="secondary" onClick={() => void toggle(l)}>{l.isActive ? 'Desativar' : 'Ativar'}</Button>
                        <Button variant="danger" onClick={() => void remove(l)}>Remover</Button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {loading && <Spinner />}
        {cursor && !loading && <div className="mt-3 text-center"><Button variant="secondary" onClick={() => void load(false, cursor)}>Carregar mais</Button></div>}
      </Card>

      {editing && <EditDialog link={editing} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); void load(true); }} />}
    </>
  );
}

function EditDialog({ link, onClose, onSaved }: { link: Link; onClose: () => void; onSaved: () => void }) {
  const [targetUrl, setTargetUrl] = useState(link.targetUrl);
  const [label, setLabel] = useState(link.label ?? '');
  const [expiresAt, setExpiresAt] = useState(link.expiresAt ? new Date(link.expiresAt).toISOString().slice(0, 16) : '');
  const [error, setError] = useState<unknown>(null);

  const save = async (e: FormEvent) => {
    e.preventDefault();
    try {
      await api.patch(`/links/${link.id}`, { targetUrl, label: label || null, expiresAt: expiresAt ? new Date(expiresAt + 'Z').toISOString() : null });
      onSaved();
    } catch (err) {
      setError(err);
    }
  };

  return (
    <div role="dialog" aria-modal="true" aria-label={`Editar ${link.slug}`} className="fixed inset-0 z-40 flex items-center justify-center bg-black/50 p-4">
      <form onSubmit={save} className="w-full max-w-lg rounded-xl border p-5" style={{ background: 'var(--surface)', borderColor: 'var(--border)' }}>
        <h2 className="mb-4 text-lg font-semibold">Editar <span className="mono">{link.slug}</span></h2>
        <div className="flex flex-col gap-3">
          <Field label="URL de destino"><input required type="url" value={targetUrl} onChange={(e) => setTargetUrl(e.target.value)} className="w-full" /></Field>
          <Field label="Rótulo"><input value={label} maxLength={200} onChange={(e) => setLabel(e.target.value)} className="w-full" /></Field>
          <Field label="Validade (UTC)"><input type="datetime-local" value={expiresAt} onChange={(e) => setExpiresAt(e.target.value)} className="w-full" /></Field>
          {error ? <ErrorBox error={error} /> : null}
        </div>
        <div className="mt-5 flex justify-end gap-2">
          <Button type="button" variant="secondary" onClick={onClose}>Cancelar</Button>
          <Button type="submit">Salvar</Button>
        </div>
      </form>
    </div>
  );
}
