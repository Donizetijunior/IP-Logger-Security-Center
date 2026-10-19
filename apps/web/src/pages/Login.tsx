import { useState, type FormEvent } from 'react';
import { ApiError, api } from '../api';
import { Button, Card, ErrorBox, Field } from '../ui';

export function LoginPage({ onLoggedIn }: { onLoggedIn: () => Promise<void> }) {
  const [step, setStep] = useState<'password' | 'code'>('password');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [challenge, setChallenge] = useState('');
  const [mfaSetupPending, setMfaSetupPending] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);

  const submitPassword = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const r = await api.post<{ challenge: string; mfaSetupPending: boolean }>('/auth/login', { email, password });
      setChallenge(r.challenge);
      setMfaSetupPending(r.mfaSetupPending);
      setPassword('');
      setStep('code');
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  const submitCode = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.post('/auth/totp/verify', { challenge, code: code.trim() });
      await onLoggedIn();
    } catch (err) {
      setError(err);
      if (err instanceof ApiError && err.status === 401) setCode('');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex min-h-full items-center justify-center p-4">
      <div className="w-full max-w-sm">
        <h1 className="mb-1 text-center text-2xl font-semibold">IP Logger Security Center</h1>
        <p className="mb-6 text-center text-sm" style={{ color: 'var(--muted)' }}>Acesso restrito ao administrador</p>
        <Card>
          {step === 'password' ? (
            <form onSubmit={submitPassword} className="flex flex-col gap-4">
              <Field label="E-mail">
                <input type="email" required autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} className="w-full" />
              </Field>
              <Field label="Senha">
                <input type="password" required autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} className="w-full" />
              </Field>
              {error ? <ErrorBox error={error} /> : null}
              <Button type="submit" disabled={busy}>{busy ? 'Verificando…' : 'Continuar'}</Button>
            </form>
          ) : (
            <form onSubmit={submitCode} className="flex flex-col gap-4">
              {mfaSetupPending && (
                <p className="rounded-lg p-3 text-sm" style={{ background: 'var(--info-bg)', color: 'var(--info-fg)' }}>
                  Primeiro acesso: confirme o MFA com o código atual do aplicativo autenticador cadastrado pelo comando de criação do administrador.
                </p>
              )}
              <Field label="Código do autenticador (6 dígitos) ou código de recuperação">
                <input inputMode="text" autoComplete="one-time-code" autoFocus required value={code} onChange={(e) => setCode(e.target.value)} className="mono w-full" />
              </Field>
              {error ? <ErrorBox error={error} /> : null}
              <Button type="submit" disabled={busy}>{busy ? 'Validando…' : 'Entrar'}</Button>
              <button type="button" className="text-sm underline" onClick={() => { setStep('password'); setError(null); }}>Voltar</button>
            </form>
          )}
        </Card>
      </div>
    </div>
  );
}
