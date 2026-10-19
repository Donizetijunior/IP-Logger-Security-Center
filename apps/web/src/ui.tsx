import { useEffect, useState, type ButtonHTMLAttributes, type ReactNode } from 'react';
import type { RiskLevel } from './types';

export const RISK_LABEL: Record<RiskLevel, string> = { low: 'Baixo', medium: 'Médio', high: 'Alto', not_evaluated: 'Não avaliado' };
const RISK_STYLE: Record<RiskLevel, string> = {
  low: 'var(--ok-bg)|var(--ok-fg)',
  medium: 'var(--warn-bg)|var(--warn-fg)',
  high: 'var(--bad-bg)|var(--bad-fg)',
  not_evaluated: 'var(--neutral-bg)|var(--neutral-fg)',
};

function tone(style: string): { background: string; color: string } {
  const [background = '', color = ''] = style.split('|');
  return { background, color };
}

export function Badge({ children, kind = 'neutral', title }: { children: ReactNode; kind?: 'ok' | 'warn' | 'bad' | 'neutral' | 'info'; title?: string }) {
  const map = { ok: 'var(--ok-bg)|var(--ok-fg)', warn: 'var(--warn-bg)|var(--warn-fg)', bad: 'var(--bad-bg)|var(--bad-fg)', neutral: 'var(--neutral-bg)|var(--neutral-fg)', info: 'var(--info-bg)|var(--info-fg)' };
  return (
    <span title={title} style={tone(map[kind])} className="inline-block whitespace-nowrap rounded-full px-2.5 py-0.5 text-xs font-semibold">
      {children}
    </span>
  );
}

export function RiskBadge({ level, score }: { level: RiskLevel; score?: number | null }) {
  return (
    <span style={tone(RISK_STYLE[level])} className="inline-block whitespace-nowrap rounded-full px-2.5 py-0.5 text-xs font-semibold" title="Risco do endereço de rede, não de uma pessoa">
      {RISK_LABEL[level]}
      {score !== null && score !== undefined ? ` · ${score}` : ''}
    </span>
  );
}

export function severityKind(s: string): 'bad' | 'warn' | 'info' | 'neutral' {
  if (s === 'critical' || s === 'high') return 'bad';
  if (s === 'medium') return 'warn';
  if (s === 'low') return 'info';
  return 'neutral';
}
export const SEVERITY_LABEL: Record<string, string> = { critical: 'Crítico', high: 'Alto', medium: 'Médio', low: 'Baixo', info: 'Info' };
export const STATUS_LABEL: Record<string, string> = { open: 'Aberto', investigating: 'Em investigação', resolved: 'Resolvido' };

export function Card({ title, children, actions, className = '' }: { title?: ReactNode; children: ReactNode; actions?: ReactNode; className?: string }) {
  return (
    <section className={`rounded-xl border p-4 ${className}`} style={{ background: 'var(--surface)', borderColor: 'var(--border)' }}>
      {(title || actions) && (
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
          {title && <h2 className="text-base font-semibold">{title}</h2>}
          {actions}
        </div>
      )}
      {children}
    </section>
  );
}

export function Button({ variant = 'primary', className = '', ...rest }: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: 'primary' | 'secondary' | 'danger' }) {
  const styles = {
    primary: { background: 'var(--accent)', color: 'var(--accent-contrast)', border: '1px solid var(--accent)' },
    secondary: { background: 'var(--surface)', color: 'var(--text)', border: '1px solid var(--border)' },
    danger: { background: 'var(--bad-bg)', color: 'var(--bad-fg)', border: '1px solid var(--bad-fg)' },
  } as const;
  return <button {...rest} style={styles[variant]} className={`cursor-pointer rounded-lg px-3 py-1.5 text-sm font-medium disabled:cursor-not-allowed disabled:opacity-50 ${className}`} />;
}

export function Spinner({ label = 'Carregando…' }: { label?: string }) {
  return (
    <div role="status" className="py-8 text-center" style={{ color: 'var(--muted)' }}>
      {label}
    </div>
  );
}

export function ErrorBox({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
  const msg = error instanceof Error ? error.message : 'Erro inesperado';
  return (
    <div role="alert" className="rounded-lg p-3 text-sm" style={{ background: 'var(--bad-bg)', color: 'var(--bad-fg)' }}>
      {msg} {onRetry && <button className="ml-2 underline" onClick={onRetry}>Tentar novamente</button>}
    </div>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return (
    <div className="py-10 text-center" style={{ color: 'var(--muted)' }}>
      {children}
    </div>
  );
}

export function PageHeader({ title, subtitle, actions }: { title: string; subtitle?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="mb-5 flex flex-wrap items-end justify-between gap-3">
      <div>
        <h1 className="text-2xl font-semibold">{title}</h1>
        {subtitle && <p className="mt-1 text-sm" style={{ color: 'var(--muted)' }}>{subtitle}</p>}
      </div>
      {actions}
    </div>
  );
}

export function Field({ label, children, className = '' }: { label: string; children: ReactNode; className?: string }) {
  return (
    <div className={className}>
      <label>{label}</label>
      {children}
    </div>
  );
}

export function Time({ iso }: { iso: string | null | undefined }) {
  if (!iso) return <span style={{ color: 'var(--muted)' }}>—</span>;
  const d = new Date(iso);
  const local = d.toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'medium' });
  const utc = d.toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'medium', timeZone: 'UTC' });
  return (
    <time dateTime={iso} title={`UTC: ${utc}`}>
      {local}
    </time>
  );
}

export function useAsync<T>(fn: () => Promise<T>, deps: unknown[]) {
  const [state, setState] = useState<{ data?: T; error?: unknown; loading: boolean }>({ loading: true });
  const [tick, setTick] = useState(0);
  useEffect(() => {
    let cancelled = false;
    setState((s) => ({ ...s, loading: true, error: undefined }));
    fn()
      .then((data) => !cancelled && setState({ data, loading: false }))
      .catch((error) => !cancelled && setState({ error, loading: false }));
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, tick]);
  return { ...state, reload: () => setTick((t) => t + 1) };
}

export const CLIENT_LABEL: Record<string, string> = {
  human_probable: 'Provável usuário',
  bot: 'Robô/ferramenta',
  preview: 'Prévia de link',
  head_probe: 'Sondagem HEAD',
  unknown: 'Desconhecido',
};

export const ENRICHMENT_LABEL: Record<string, string> = {
  pending: 'Pendente',
  done: 'Concluído',
  partial: 'Parcial',
  failed: 'Falhou',
  skipped: 'Ignorado (IP não público)',
};

export const INTEL_STATUS_LABEL: Record<string, string> = {
  ok: 'Com resultado',
  no_data: 'Sem resultado',
  unavailable: 'Indisponível',
  rate_limited: 'Cota atingida',
  not_queried: 'Não consultado',
  disabled: 'Desabilitado',
};

export function intelKind(status: string): 'ok' | 'warn' | 'bad' | 'neutral' {
  if (status === 'ok') return 'ok';
  if (status === 'no_data') return 'neutral';
  if (status === 'rate_limited') return 'warn';
  if (status === 'unavailable') return 'bad';
  return 'neutral';
}
