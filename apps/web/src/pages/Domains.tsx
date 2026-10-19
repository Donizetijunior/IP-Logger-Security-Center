import { useCallback, useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { api } from '../api';
import { useSession } from '../session';
import { Badge, Button, Card, Empty, ErrorBox, Field, PageHeader, Spinner, Time } from '../ui';
import type { DomainItem, DomainPolicy } from '../types';

const STATUS: Record<DomainItem['status'], { label: string; kind: 'ok' | 'warn' | 'bad' | 'info' }> = {
  pending_dns: { label: 'Aguardando DNS', kind: 'warn' },
  pending_approval: { label: 'Aguardando aprovação', kind: 'info' },
  active: { label: 'Ativo', kind: 'ok' },
  disabled: { label: 'Desativado', kind: 'bad' },
};

const MODE_TEXT: Record<DomainPolicy['mode'], string> = {
  admin: 'Neste serviço, somente o administrador cadastra domínios personalizados.',
  approval: 'Você cadastra e verifica o domínio; o administrador precisa aprová-lo antes de ele funcionar.',
  open: 'Você cadastra e verifica o domínio; ele passa a funcionar assim que a propriedade é comprovada.',
};

function Copy({ text, label }: { text: string; label: string }) {
  const [done, setDone] = useState(false);
  return (
    <Button
      variant="secondary"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text);
          setDone(true);
          setTimeout(() => setDone(false), 1200);
        } catch {
          window.prompt('Copie:', text);
        }
      }}
    >
      {done ? 'Copiado!' : label}
    </Button>
  );
}

function Step({ n, done, title, children }: { n: number; done: boolean | null; title: string; children: ReactNode }) {
  return (
    <div className="flex gap-3 border-t py-3 first:border-t-0" style={{ borderColor: 'var(--border)' }}>
      <div
        className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-xs font-bold"
        style={{ background: done ? 'var(--ok-bg)' : 'var(--neutral-bg)', color: done ? 'var(--ok-fg)' : 'var(--neutral-fg)' }}
        aria-label={done ? 'concluído' : 'pendente'}
      >
        {done ? '✓' : n}
      </div>
      <div className="min-w-0 flex-1 text-sm">
        <div className="mb-1 font-semibold">{title}</div>
        {children}
      </div>
    </div>
  );
}

export function DomainsPage() {
  const { me } = useSession();
  const admin = me.role === 'admin';
  const [items, setItems] = useState<DomainItem[]>([]);
  const [policy, setPolicy] = useState<DomainPolicy | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const [hostname, setHostname] = useState('');
  const [root, setRoot] = useState('');
  const [formError, setFormError] = useState<unknown>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const r = await api.get<{ items: DomainItem[]; policy: DomainPolicy }>('/domains');
      setItems(r.items);
      setPolicy(r.policy);
      setError(null);
    } catch (e) {
      setError(e);
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => { void load(); }, [load]);

  const create = async (e: FormEvent) => {
    e.preventDefault();
    setFormError(null);
    try {
      await api.post('/domains', { hostname, rootRedirectUrl: root || undefined });
      setHostname('');
      setRoot('');
      await load();
    } catch (err) {
      setFormError(err);
    }
  };

  const act = async (id: string, fn: () => Promise<unknown>, okMsg?: string) => {
    setBusy(id);
    setNotice(null);
    setError(null);
    try {
      await fn();
      if (okMsg) setNotice(okMsg);
      await load();
    } catch (e) {
      setError(e);
    } finally {
      setBusy(null);
    }
  };

  const verify = (d: DomainItem) =>
    act(d.id, async () => {
      const r = await api.post<{ verified: boolean; message: string | null }>(`/domains/${d.id}/verify`);
      setNotice(r.message ?? (r.verified ? 'Propriedade verificada.' : null));
    });

  const editRoot = (d: DomainItem) => {
    const v = window.prompt(`Para onde a raiz de ${d.hostname} deve redirecionar? (vazio = nenhuma)`, d.rootRedirectUrl ?? '');
    if (v === null) return;
    void act(d.id, () => api.patch(`/domains/${d.id}`, { rootRedirectUrl: v.trim() || null }));
  };

  const remove = (d: DomainItem) => {
    if (!window.confirm(`Excluir o domínio ${d.hostname}?`)) return;
    void act(d.id, () => api.del(`/domains/${d.id}`));
  };

  return (
    <>
      <PageHeader
        title="Domínios personalizados"
        subtitle="Use seus próprios domínios nos links (ex.: go.seusite.com.br/oferta). O mesmo código pode existir em domínios diferentes."
      />
      {policy && <p className="mb-4 text-sm" style={{ color: 'var(--muted)' }}>{MODE_TEXT[policy.mode]}{policy.max !== null && <> Você usa <strong>{policy.used}</strong> de <strong>{policy.max}</strong>.</>}</p>}

      {policy?.canCreate && (
        <Card title="Adicionar domínio" className="mb-5">
          <form onSubmit={create} className="grid grid-cols-1 gap-3 md:grid-cols-3">
            <Field label="Domínio ou subdomínio"><input required value={hostname} onChange={(e) => setHostname(e.target.value)} placeholder="go.seusite.com.br" className="w-full" /></Field>
            <Field label="Raiz redireciona para (opcional)"><input type="url" value={root} onChange={(e) => setRoot(e.target.value)} placeholder="https://seusite.com.br" className="w-full" /></Field>
            <div className="flex items-end"><Button type="submit">Adicionar</Button></div>
          </form>
          {formError ? <div className="mt-3"><ErrorBox error={formError} /></div> : null}
        </Card>
      )}

      {notice && <p role="status" className="mb-3 rounded-lg p-3 text-sm" style={{ background: 'var(--info-bg)', color: 'var(--info-fg)' }}>{notice}</p>}
      {error ? <ErrorBox error={error} onRetry={() => void load()} /> : null}
      {loading && items.length === 0 && <Spinner />}
      {!loading && items.length === 0 && !error && <Card><Empty>Nenhum domínio cadastrado.</Empty></Card>}

      <div className="flex flex-col gap-4">
        {items.map((d) => {
          const verified = !!d.verifiedAt;
          return (
            <Card
              key={d.id}
              title={<span className="mono break-all">{d.hostname}</span>}
              actions={<div className="flex items-center gap-2"><Badge kind={STATUS[d.status].kind}>{STATUS[d.status].label}</Badge><Badge kind="neutral">{d.links} link(s)</Badge></div>}
            >
              {admin && d.owner && <p className="mb-2 text-xs" style={{ color: 'var(--muted)' }}>Dono: {d.owner.email}</p>}

              <Step n={1} done={verified} title="Comprovar a propriedade (registro TXT no DNS)">
                <p className="mb-2" style={{ color: 'var(--muted)' }}>No painel de DNS do domínio, crie um registro <strong>TXT</strong> com:</p>
                <div className="mb-1 flex flex-wrap items-center gap-2"><span className="w-14 text-xs" style={{ color: 'var(--muted)' }}>Nome</span><code className="mono break-all">{d.dns.txtName}</code><Copy text={d.dns.txtName} label="Copiar" /></div>
                <div className="flex flex-wrap items-center gap-2"><span className="w-14 text-xs" style={{ color: 'var(--muted)' }}>Valor</span><code className="mono break-all">{d.dns.txtValue}</code><Copy text={d.dns.txtValue} label="Copiar" /></div>
                {verified && <p className="mt-2 text-xs" style={{ color: 'var(--ok-fg)' }}>Verificado em <Time iso={d.verifiedAt} />.</p>}
              </Step>

              <Step n={2} done={d.routingOk} title="Fazer o domínio chegar até aqui (rota do túnel Cloudflare)">
                <p style={{ color: 'var(--muted)' }}>
                  O domínio precisa estar na mesma conta Cloudflare do túnel. Em <strong>Zero Trust → Redes → Túneis → (seu túnel) → Rotas → Adicionar rota → Aplicativo publicado</strong>:
                  hostname <code className="mono">{d.hostname}</code>, URL do serviço <code className="mono">{d.routing.serviceUrl}</code>.
                </p>
                {d.routingOk === false && d.lastCheckError && <p className="mt-1 text-xs" style={{ color: 'var(--bad-fg)' }}>{d.lastCheckError}</p>}
                {d.routingOk && <p className="mt-1 text-xs" style={{ color: 'var(--ok-fg)' }}>O tráfego do domínio está chegando corretamente.</p>}
              </Step>

              <Step n={3} done={d.status === 'active'} title="Ativação">
                {d.status === 'pending_approval' ? 'Aguardando a aprovação do administrador.' : d.status === 'disabled' ? 'Desativado pelo administrador: os links deste domínio não respondem.' : d.status === 'active' ? 'Ativo: já é possível criar links neste domínio (página Links).' : 'Conclua os passos acima e clique em “Verificar agora”.'}
                {d.status === 'pending_dns' && !verified && d.lastCheckError && <p className="mt-1 text-xs" style={{ color: 'var(--warn-fg)' }}>{d.lastCheckError}</p>}
              </Step>

              <div className="mt-2 flex flex-wrap gap-1.5">
                {d.status !== 'disabled' && <Button disabled={busy === d.id} onClick={() => void verify(d)}>{busy === d.id ? 'Verificando…' : 'Verificar agora'}</Button>}
                {admin && d.status === 'pending_approval' && <Button onClick={() => void act(d.id, () => api.patch(`/domains/${d.id}`, { status: 'active' }))}>Aprovar</Button>}
                {admin && d.status === 'active' && <Button variant="secondary" onClick={() => void act(d.id, () => api.patch(`/domains/${d.id}`, { status: 'disabled' }))}>Desativar</Button>}
                {admin && d.status === 'disabled' && verified && <Button variant="secondary" onClick={() => void act(d.id, () => api.patch(`/domains/${d.id}`, { status: 'active' }))}>Reativar</Button>}
                <Button variant="secondary" onClick={() => editRoot(d)}>Raiz: {d.rootRedirectUrl ? 'alterar' : 'definir'}</Button>
                <Button variant="danger" onClick={() => remove(d)}>Excluir</Button>
              </div>
            </Card>
          );
        })}
      </div>
    </>
  );
}
