import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api } from '../api';
import { decryptNote } from '../notecrypto';
import { Button, Card, ErrorBox, PageHeader, Spinner, Time, useAsync } from '../ui';

/** Página pública: o destinatário não precisa de conta. A nota é destruída ao ser revelada. */
export function NotePage() {
  const { id = '' } = useParams();
  const key = window.location.hash.replace(/^#/, '');
  const meta = useAsync(() => api.get<{ exists: boolean; expiresAt: string }>(`/public/notes/${id}`), [id]);
  const [text, setText] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);

  const reveal = async () => {
    setBusy(true);
    setError(null);
    try {
      const r = await api.post<{ ciphertext: string; iv: string }>(`/public/notes/${id}/read`);
      try {
        setText(await decryptNote(r.ciphertext, r.iv, key));
      } catch {
        setError(new Error('Não foi possível decifrar: o link está incompleto ou a chave está incorreta. A nota já foi destruída.'));
      }
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };

  if (text !== null) {
    return (
      <>
        <PageHeader title="Nota privada" subtitle="Esta nota foi destruída no servidor. Copie o conteúdo agora: não será possível abri-la de novo." />
        <Card>
          <pre className="whitespace-pre-wrap break-words text-sm">{text}</pre>
          <div className="mt-3"><Button variant="secondary" onClick={() => void navigator.clipboard.writeText(text)}>Copiar</Button></div>
        </Card>
      </>
    );
  }

  return (
    <>
      <PageHeader title="Nota privada" subtitle="Alguém enviou uma nota cifrada que pode ser lida uma única vez." />
      <Card>
        {meta.loading ? <Spinner /> : meta.error ? (
          <p className="text-sm">Esta nota não existe, já foi lida ou expirou. <Link to="/">Voltar</Link></p>
        ) : (
          <div className="flex max-w-lg flex-col gap-3">
            {!key && <ErrorBox error={new Error('O link não contém a chave de decifragem (a parte depois do #).')} />}
            <p className="text-sm">
              Ao clicar em <strong>Revelar nota</strong>, ela será exibida e <strong>destruída</strong> em seguida. Expira em <Time iso={meta.data?.expiresAt} />.
            </p>
            {error ? <ErrorBox error={error} /> : null}
            <div><Button onClick={() => void reveal()} disabled={busy || !key}>{busy ? 'Abrindo…' : 'Revelar nota'}</Button></div>
          </div>
        )}
      </Card>
    </>
  );
}
