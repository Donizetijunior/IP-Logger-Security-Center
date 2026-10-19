import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { api, qs } from '../api';
import { Badge, Button, Card, Empty, ErrorBox, Field, PageHeader, Spinner, Time } from '../ui';
import type { Page, UserItem } from '../types';

const STATUS: Record<UserItem['status'], { label: string; kind: 'ok' | 'warn' | 'bad' }> = {
  active: { label: 'Ativo', kind: 'ok' },
  pending: { label: 'Aguardando aprovação', kind: 'warn' },
  suspended: { label: 'Suspenso', kind: 'bad' },
};

export function UsersPage() {
  const [items, setItems] = useState<UserItem[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [status, setStatus] = useState('');
  const [q, setQ] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [temp, setTemp] = useState<{ email: string; password: string } | null>(null);

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [quota, setQuota] = useState('');
  const [formError, setFormError] = useState<unknown>(null);

  const load = useCallback(async (reset: boolean, from?: string | null) => {
    setLoading(true);
    setError(null);
    try {
      const r = await api.get<Page<UserItem>>(`/users${qs({ status, q, limit: 50, cursor: reset ? undefined : from })}`);
      setItems((p) => (reset ? r.items : [...p, ...r.items]));
      setCursor(r.nextCursor);
    } catch (e) {
      setError(e);
    } finally {
      setLoading(false);
    }
  }, [status, q]);

  useEffect(() => {
    const t = setTimeout(() => void load(true), 250);
    return () => clearTimeout(t);
  }, [load]);

  const create = async (e: FormEvent) => {
    e.preventDefault();
    setFormError(null);
    setTemp(null);
    try {
      const r = await api.post<{ id: string; email: string; temporaryPassword?: string }>('/users', {
        email, password: password || undefined, linkQuota: quota ? Number(quota) : undefined,
      });
      if (r.temporaryPassword) setTemp({ email: r.email, password: r.temporaryPassword });
      setNotice(`Usuário ${r.email} criado. Ele precisará trocar a senha e aceitar os Termos no primeiro acesso.`);
      setEmail(''); setPassword(''); setQuota('');
      await load(true);
    } catch (err) {
      setFormError(err);
    }
  };

  const act = async (fn: () => Promise<unknown>) => {
    setNotice(null);
    setTemp(null);
    try {
      await fn();
      await load(true);
    } catch (err) {
      setError(err);
    }
  };

  const setUserStatus = (u: UserItem, s: UserItem['status']) => act(() => api.patch(`/users/${u.id}`, { status: s }));
  const setQuotaFor = (u: UserItem) => {
    const v = window.prompt(`Novo limite de links para ${u.email}:`, String(u.linkQuota));
    if (v === null) return;
    const n = Number(v);
    if (!Number.isInteger(n) || n < 0) return;
    void act(() => api.patch(`/users/${u.id}`, { linkQuota: n }));
  };
  const reset = (u: UserItem) => {
    if (!window.confirm(`Gerar nova senha temporária para ${u.email}? As sessões dele serão encerradas.`)) return;
    void act(async () => {
      const r = await api.post<{ temporaryPassword: string }>(`/users/${u.id}/reset-password`);
      setTemp({ email: u.email, password: r.temporaryPassword });
    });
  };
  const remove = (u: UserItem) => {
    if (!window.confirm(`EXCLUIR ${u.email}? Apaga a conta, ${u.links} link(s) e ${u.events} evento(s). Não pode ser desfeito.`)) return;
    void act(() => api.del(`/users/${u.id}`));
  };

  return (
    <>
      <PageHeader title="Usuários" subtitle="Crie, aprove, suspenda e remova contas. Cada usuário enxerga somente os próprios links e eventos." />

      <Card title="Novo usuário" className="mb-5">
        <form onSubmit={create} className="grid grid-cols-1 gap-3 md:grid-cols-4">
          <Field label="E-mail" className="md:col-span-2"><input type="email" required value={email} onChange={(e) => setEmail(e.target.value)} className="w-full" /></Field>
          <Field label="Senha (vazio = gerar temporária)"><input type="text" autoComplete="off" value={password} onChange={(e) => setPassword(e.target.value)} className="w-full" /></Field>
          <Field label="Limite de links"><input type="number" min={0} value={quota} onChange={(e) => setQuota(e.target.value)} placeholder="padrão" className="w-full" /></Field>
          <div className="md:col-span-4"><Button type="submit">Criar usuário</Button></div>
        </form>
        {formError ? <div className="mt-3"><ErrorBox error={formError} /></div> : null}
      </Card>

      {temp && (
        <div role="status" className="mb-4 rounded-lg p-4 text-sm" style={{ background: 'var(--warn-bg)', color: 'var(--warn-fg)' }}>
          <strong>Senha temporária de {temp.email} (exibida uma única vez):</strong>{' '}
          <code className="select-all font-semibold">{temp.password}</code>
          <div className="mt-1 text-xs">Entregue por um canal seguro. O usuário será obrigado a trocá-la no primeiro acesso.</div>
        </div>
      )}
      {notice && !temp && <p role="status" className="mb-4 text-sm" style={{ color: 'var(--ok-fg)' }}>{notice}</p>}

      <Card
        title="Contas"
        actions={
          <div className="flex flex-wrap gap-2">
            <input type="search" aria-label="Buscar usuário" placeholder="Buscar e-mail" value={q} onChange={(e) => setQ(e.target.value)} className="w-52 max-w-full" />
            <select aria-label="Filtrar por estado" value={status} onChange={(e) => setStatus(e.target.value)}>
              <option value="">Todos</option><option value="pending">Aguardando aprovação</option><option value="active">Ativos</option><option value="suspended">Suspensos</option>
            </select>
          </div>
        }
      >
        {error ? <ErrorBox error={error} onRetry={() => void load(true)} /> : null}
        {!loading && items.length === 0 && !error ? <Empty>Nenhum usuário encontrado.</Empty> : null}
        {items.length > 0 && (
          <div className="overflow-x-auto">
            <table>
              <thead><tr><th>E-mail</th><th>Estado</th><th>Links</th><th>Eventos</th><th>Origem</th><th>Criado em</th><th><span className="sr-only">Ações</span></th></tr></thead>
              <tbody>
                {items.map((u) => (
                  <tr key={u.id}>
                    <td className="break-all">{u.email}{u.role === 'admin' && <> <Badge kind="info">Admin</Badge></>}{u.mustChangePassword && <div className="text-xs" style={{ color: 'var(--muted)' }}>senha temporária pendente</div>}</td>
                    <td><Badge kind={STATUS[u.status].kind}>{STATUS[u.status].label}</Badge></td>
                    <td className="text-sm">{u.links} / {u.role === 'admin' ? '∞' : u.linkQuota}</td>
                    <td className="text-sm">{u.events}</td>
                    <td className="text-sm">{{ self: 'Cadastro', admin: 'Criado pelo admin', cli: 'Instalação' }[u.signupSource] ?? u.signupSource}</td>
                    <td className="text-sm"><Time iso={u.createdAt} /></td>
                    <td>
                      {u.role !== 'admin' && (
                        <div className="flex flex-wrap gap-1.5">
                          {u.status === 'pending' && <Button onClick={() => void setUserStatus(u, 'active')}>Aprovar</Button>}
                          {u.status === 'active' && <Button variant="secondary" onClick={() => void setUserStatus(u, 'suspended')}>Suspender</Button>}
                          {u.status === 'suspended' && <Button variant="secondary" onClick={() => void setUserStatus(u, 'active')}>Reativar</Button>}
                          <Button variant="secondary" onClick={() => setQuotaFor(u)}>Limite</Button>
                          <Button variant="secondary" onClick={() => reset(u)}>Redefinir senha</Button>
                          <Button variant="danger" onClick={() => remove(u)}>Excluir</Button>
                        </div>
                      )}
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
    </>
  );
}
