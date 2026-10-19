import { useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api';
import { Button, Card, ErrorBox, Field } from '../ui';
import type { PublicConfig } from '../types';

export function SignupPage({ config }: { config: PublicConfig | null }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [accept, setAccept] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<'active' | 'pending' | null>(null);

  if (config?.signupMode === 'closed') {
    return (
      <Card title="Cadastro fechado">
        <p className="text-sm">O cadastro público está fechado no momento. <Link to="/">Voltar ao login</Link></p>
      </Card>
    );
  }

  if (done) {
    return (
      <Card title={done === 'active' ? 'Conta criada' : 'Cadastro recebido'}>
        <p className="mb-4 text-sm">
          {done === 'active'
            ? 'Sua conta está pronta. Você já pode entrar com seu e-mail e senha.'
            : 'Sua conta foi criada e aguarda aprovação do administrador. Você poderá entrar depois da aprovação.'}
        </p>
        <Link to="/">Ir para o login</Link>
      </Card>
    );
  }

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    if (password !== confirm) {
      setError(new Error('As senhas não conferem'));
      return;
    }
    setBusy(true);
    try {
      const r = await api.post<{ status: 'active' | 'pending' }>('/auth/signup', { email, password, acceptTerms: accept });
      setDone(r.status);
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mx-auto w-full max-w-sm">
      <h1 className="mb-1 text-center text-2xl font-semibold">Criar conta</h1>
      <p className="mb-6 text-center text-sm" style={{ color: 'var(--muted)' }}>
        Para monitorar o acesso aos <strong>seus</strong> links, com finalidade de segurança.
        {config && ` Limite inicial: ${config.defaultLinkQuota} links.`}
      </p>
      <Card>
        <form onSubmit={submit} className="flex flex-col gap-4">
          <Field label="E-mail">
            <input type="email" required autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} className="w-full" />
          </Field>
          <Field label="Senha (mín. 12 caracteres, 3 tipos de caractere)">
            <input type="password" required minLength={12} autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} className="w-full" />
          </Field>
          <Field label="Confirmar senha">
            <input type="password" required autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} className="w-full" />
          </Field>
          <label className="flex items-start gap-2 text-sm" style={{ color: 'var(--text)' }}>
            <input type="checkbox" checked={accept} onChange={(e) => setAccept(e.target.checked)} className="mt-1" required />
            <span>
              Li e aceito os <Link to="/termos" target="_blank">Termos de Uso</Link>, inclusive a proibição de rastrear pessoas sem autorização ou consentimento.
            </span>
          </label>
          {error ? <ErrorBox error={error} /> : null}
          <Button type="submit" disabled={busy || !accept}>{busy ? 'Criando…' : 'Criar conta'}</Button>
        </form>
      </Card>
      <p className="mt-4 text-center text-sm">Já tem conta? <Link to="/">Entrar</Link></p>
    </div>
  );
}
