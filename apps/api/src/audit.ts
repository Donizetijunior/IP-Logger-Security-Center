import type { Pool } from '@ipl/database';

const SENSITIVE_KEYS = /pass|secret|token|cookie|key|authorization|code/i;

/** Remove valores sensíveis e limita o tamanho dos metadados de auditoria. */
export function redactMetadata(meta: Record<string, unknown> = {}): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(meta)) {
    if (SENSITIVE_KEYS.test(k)) {
      out[k] = '[redigido]';
    } else if (typeof v === 'string') {
      out[k] = v.length > 300 ? `${v.slice(0, 300)}…` : v;
    } else if (v !== null && typeof v === 'object') {
      out[k] = JSON.parse(JSON.stringify(v, (kk, vv) => (SENSITIVE_KEYS.test(kk) ? '[redigido]' : vv)));
    } else {
      out[k] = v;
    }
  }
  return out;
}

export async function audit(
  pool: Pool,
  entry: { adminId?: string | null; action: string; resource?: string | null; result: 'success' | 'failure' | 'denied'; metadata?: Record<string, unknown> },
): Promise<void> {
  try {
    await pool.query(
      'INSERT INTO audit_events (admin_id, action, resource, result, metadata_redacted) VALUES ($1, $2, $3, $4, $5)',
      [entry.adminId ?? null, entry.action, entry.resource ?? null, entry.result, JSON.stringify(redactMetadata(entry.metadata))],
    );
  } catch {
    // auditoria nunca deve derrubar a requisição; a falha é visível nos logs operacionais
  }
}
