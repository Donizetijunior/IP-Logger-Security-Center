import { useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from './api';
import { Button } from './ui';

/** Aviso de alteração dos Termos de Uso / Aviso de Privacidade, com registro do aceite da versão vigente. */
export function TermsNotice({ version, privacyUrl, onAccepted }: { version?: string; privacyUrl?: string; onAccepted: () => Promise<void> | void }) {
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const accept = async () => {
    setBusy(true);
    setFailed(false);
    try {
      await api.post('/auth/accept-terms');
      await onAccepted();
    } catch {
      setFailed(true);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div role="status" className="mb-5 flex flex-wrap items-center gap-3 rounded-lg p-4 text-sm" style={{ background: 'var(--info-bg)', color: 'var(--info-fg)' }}>
      <div className="min-w-0 flex-1">
        <strong>Atualizamos os Termos de Uso e o Aviso de Privacidade{version ? ` (versão ${version})` : ''}.</strong>{' '}
        Leia o <Link to="/termos" className="underline">que mudou nos Termos</Link>
        {privacyUrl ? <> e o <a href={privacyUrl} target="_blank" rel="noopener noreferrer" className="underline">Aviso de Privacidade</a></> : null}.
        Continuar usando o serviço significa concordar com a nova versão.
        {failed ? <span className="ml-2 font-semibold">Não foi possível registrar agora; tente de novo.</span> : null}
      </div>
      <Button onClick={() => void accept()} disabled={busy}>Li e concordo</Button>
    </div>
  );
}
