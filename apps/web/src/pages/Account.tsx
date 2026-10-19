import { useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api';
import { useSession } from '../session';
import { Button, Card, ErrorBox, Field, PageHeader } from '../ui';

export function AccountPage({ forced = false, onChanged, onLogout }: { forced?: boolean; onChanged: () => Promise<void>; onLogout: () => Promise<void> }) {
  const { me } = useSession();
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [accept, setAccept] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [ok, setOk] = useState(false);
  const [busy, setBusy] = useState(false);

  const [delPassword, setDelPassword] = useState('');
  const [delError, setDelError] = useState<unknown>(null);

  const change = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    setOk(false);
    if (next !== confirm) {
      setError(new Error('As senhas não conferem'));
      return;
    }
    setBusy(true);
    try {
      await api.post('/auth/change-password', { currentPassword: current, newPassword: next, acceptTerms: forced ? accept : undefined });
      setCurrent(''); setNext(''); setConfirm('');
      setOk(true);
      await onChanged();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  const remove = async (e: FormEvent) => {
    e.preventDefault();
    if (!window.confirm('Excluir sua conta apaga TODOS os seus links, eventos e alertas, e não pode ser desfeito. Continuar?')) return;
    setDelError(null);
    try {
      await api.post('/auth/delete-account', { password: delPassword });
      await onLogout();
    } catch (err) {
      setDelError(err);
    }
  };

  return (
    <>
      <PageHeader
        title={forced ? 'Defina uma nova senha' : 'Minha conta'}
        subtitle={forced ? 'Sua senha atual é temporária. Troque-a para continuar.' : <>Conectado como <strong>{me.email}</strong> · {me.role === 'admin' ? 'Administrador' : 'Usuário'}{me.linkQuota !== undefined && me.role !== 'admin' ? ` · limite de ${me.linkQuota} links` : ''}</>}
      />
      <Card title="Trocar senha" className="max-w-lg">
        <form onSubmit={change} className="flex flex-col gap-4">
          <Field label="Senha atual"><input type="password" required autoComplete="current-password" value={current} onChange={(e) => setCurrent(e.target.value)} className="w-full" /></Field>
          <Field label="Nova senha (mín. 12 caracteres, 3 tipos de caractere)"><input type="password" required minLength={12} autoComplete="new-password" value={next} onChange={(e) => setNext(e.target.value)} className="w-full" /></Field>
          <Field label="Confirmar nova senha"><input type="password" required autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} className="w-full" /></Field>
          {forced && (
            <label className="flex items-start gap-2 text-sm" style={{ color: 'var(--text)' }}>
              <input type="checkbox" checked={accept} onChange={(e) => setAccept(e.target.checked)} className="mt-1" required />
              <span>Li e aceito os <Link to="/termos" target="_blank">Termos de Uso</Link>.</span>
            </label>
          )}
          {error ? <ErrorBox error={error} /> : null}
          {ok && <p role="status" className="text-sm" style={{ color: 'var(--ok-fg)' }}>Senha alterada. As outras sessões foram encerradas.</p>}
          <div className="flex gap-2">
            <Button type="submit" disabled={busy}>{busy ? 'Salvando…' : 'Salvar nova senha'}</Button>
            {forced && <Button type="button" variant="secondary" onClick={() => void onLogout()}>Sair</Button>}
          </div>
        </form>
      </Card>

      {!forced && me.role !== 'admin' && (
        <Card title="Excluir minha conta" className="mt-5 max-w-lg">
          <p className="mb-3 text-sm" style={{ color: 'var(--muted)' }}>
            Remove permanentemente sua conta, seus links, os eventos de acesso e os alertas associados.
          </p>
          <form onSubmit={remove} className="flex flex-col gap-3">
            <Field label="Confirme sua senha"><input type="password" required autoComplete="current-password" value={delPassword} onChange={(e) => setDelPassword(e.target.value)} className="w-full" /></Field>
            {delError ? <ErrorBox error={delError} /> : null}
            <div><Button type="submit" variant="danger">Excluir conta e dados</Button></div>
          </form>
        </Card>
      )}
    </>
  );
}
