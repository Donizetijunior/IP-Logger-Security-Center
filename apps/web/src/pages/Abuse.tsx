import { useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api';
import { Button, Card, ErrorBox, Field, PageHeader } from '../ui';

const REASONS: Record<string, string> = {
  tracking_without_consent: 'Fui rastreado(a) sem consentimento',
  phishing_or_fraud: 'Phishing, golpe ou fraude',
  harassment: 'Assédio ou perseguição',
  illegal_content: 'Conteúdo ilegal',
  other: 'Outro motivo',
};

/** Página pública: qualquer pessoa pode denunciar um link, sem login e sem informar IP. */
export function AbusePage() {
  const [slug, setSlug] = useState('');
  const [reason, setReason] = useState('tracking_without_consent');
  const [details, setDetails] = useState('');
  const [contact, setContact] = useState('');
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.post('/public/abuse-report', { slug, reason, details: details || undefined, contact: contact || undefined });
      setDone(true);
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  if (done) {
    return (
      <Card title="Denúncia enviada">
        <p className="mb-3 text-sm">Obrigado. O administrador vai analisar o link e poderá desativá-lo e suspender a conta responsável.</p>
        <Link to="/">Voltar</Link>
      </Card>
    );
  }

  return (
    <>
      <PageHeader title="Denunciar abuso" subtitle="Recebeu um link encurtado desta plataforma e acredita que foi usado de forma indevida? Informe abaixo. Não registramos o seu IP nesta denúncia." />
      <Card>
        <form onSubmit={submit} className="flex max-w-lg flex-col gap-4">
          <Field label="Link denunciado (endereço completo ou só o código final)">
            <input required value={slug} onChange={(e) => setSlug(e.target.value)} placeholder="https://…/abc123 ou abc123" className="w-full" maxLength={300} />
          </Field>
          <Field label="Motivo">
            <select value={reason} onChange={(e) => setReason(e.target.value)} className="w-full">
              {Object.entries(REASONS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
            </select>
          </Field>
          <Field label="Detalhes (opcional)">
            <textarea value={details} onChange={(e) => setDetails(e.target.value)} rows={4} maxLength={2000} className="w-full" />
          </Field>
          <Field label="Contato para retorno (opcional)">
            <input value={contact} onChange={(e) => setContact(e.target.value)} maxLength={200} className="w-full" placeholder="e-mail, se quiser ser contatado(a)" />
          </Field>
          {error ? <ErrorBox error={error} /> : null}
          <Button type="submit" disabled={busy}>{busy ? 'Enviando…' : 'Enviar denúncia'}</Button>
        </form>
      </Card>
    </>
  );
}
