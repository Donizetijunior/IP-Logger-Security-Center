import { z } from 'zod';
import { normalizeIp } from './ip.ts';

export class FilterError extends Error {
  readonly code = 'invalid_filter';
}

export const eventFilterSchema = z.object({
  ip: z.string().max(45).optional(),
  linkId: z.string().uuid().optional(),
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
  country: z.string().length(2).optional(),
  minScore: z.coerce.number().int().min(0).max(100).optional(),
  riskLevel: z.enum(['low', 'medium', 'high', 'not_evaluated']).optional(),
  method: z.enum(['GET', 'HEAD']).optional(),
  clientClass: z.enum(['human_probable', 'bot', 'preview', 'head_probe', 'unknown']).optional(),
  enrichmentStatus: z.enum(['pending', 'done', 'partial', 'failed', 'skipped']).optional(),
});
export type EventFilters = z.infer<typeof eventFilterSchema>;

/** Monta cláusulas WHERE parametrizadas (alias "e" = access_events). Compartilhado entre API e exportação. */
export function buildEventWhere(f: EventFilters, startIndex = 0, ownerId?: string | null): { clauses: string[]; params: unknown[] } {
  const clauses: string[] = [];
  const params: unknown[] = [];
  const p = (v: unknown) => {
    params.push(v);
    return `$${startIndex + params.length}`;
  };
  // Escopo multiusuário: usuários comuns só enxergam eventos dos próprios links
  if (ownerId) clauses.push(`e.short_link_id IN (SELECT id FROM short_links WHERE owner_id = ${p(ownerId)}::uuid)`);
  if (f.ip) {
    const ip = normalizeIp(f.ip);
    if (!ip) throw new FilterError('IP inválido');
    clauses.push(`e.ip_address = ${p(ip)}::inet`);
  }
  if (f.linkId) clauses.push(`e.short_link_id = ${p(f.linkId)}::uuid`);
  if (f.from) clauses.push(`e.occurred_at >= ${p(f.from)}::timestamptz`);
  if (f.to) clauses.push(`e.occurred_at <= ${p(f.to)}::timestamptz`);
  if (f.country) clauses.push(`e.country = ${p(f.country.toUpperCase())}`);
  if (f.minScore !== undefined) clauses.push(`e.risk_score >= ${p(f.minScore)}`);
  if (f.riskLevel) clauses.push(`e.risk_level = ${p(f.riskLevel)}`);
  if (f.method) clauses.push(`e.method = ${p(f.method)}`);
  if (f.clientClass) clauses.push(`e.client_class = ${p(f.clientClass)}`);
  if (f.enrichmentStatus) clauses.push(`e.enrichment_status = ${p(f.enrichmentStatus)}`);
  return { clauses, params };
}
