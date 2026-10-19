import type { Pool } from '@ipl/database';
import { buildEventWhere, eventFilterSchema, maskIp } from '@ipl/shared';

const MAX_ROWS = 50_000;

/** Neutraliza injeção de fórmulas (CSV injection) e escapa aspas/quebras. */
export function csvCell(value: unknown): string {
  if (value === null || value === undefined) return '';
  let s = value instanceof Date ? value.toISOString() : String(value);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  if (/[",\r\n]/.test(s)) s = `"${s.replace(/"/g, '""')}"`;
  return s;
}

const COLUMNS = [
  'id', 'occurred_at', 'slug', 'ip', 'method', 'http_status', 'client_class', 'browser', 'os', 'country', 'region', 'city', 'asn', 'asn_org',
  'tor_exit', 'risk_score', 'risk_level', 'enrichment_status', 'referer_origin', 'user_agent',
] as const;

interface Row {
  id: string; occurred_at: Date; slug: string; ip: string; method: string; http_status: number; client_class: string; browser: string | null;
  os: string | null; country: string | null; region: string | null; city: string | null; asn: number | null; asn_org: string | null;
  tor_exit: string; risk_score: number | null; risk_level: string; enrichment_status: string; referer_origin: string | null; user_agent: string | null;
}

export async function generateExport(pool: Pool, exportId: string): Promise<void> {
  const { rows } = await pool.query<{ format: 'csv' | 'json'; filters: unknown; mask_ip: boolean }>(
    `UPDATE exports SET status = 'processing' WHERE id = $1 AND status = 'pending' AND expires_at > now() RETURNING format, filters, mask_ip`, [exportId],
  );
  const job = rows[0];
  if (!job) return;
  try {
    const filters = eventFilterSchema.parse(job.filters);
    const { clauses, params } = buildEventWhere(filters);
    params.push(MAX_ROWS);
    const data = await pool.query<Row>(
      `SELECT e.id, e.occurred_at, e.slug, host(e.ip_address) AS ip, e.method, e.http_status, e.client_class, e.browser, e.os,
              e.country, e.region, e.city, e.asn, e.asn_org, e.tor_exit, e.risk_score, e.risk_level, e.enrichment_status,
              e.referer_origin, e.user_agent
       FROM access_events e ${clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''}
       ORDER BY e.occurred_at DESC, e.id DESC LIMIT $${params.length}`,
      params,
    );
    const mapped = data.rows.map((r) => ({ ...r, ip: job.mask_ip ? maskIp(r.ip) : r.ip }));
    let content: string;
    if (job.format === 'csv') {
      const lines = [COLUMNS.join(',')];
      for (const r of mapped) lines.push(COLUMNS.map((c) => csvCell(r[c])).join(','));
      content = `${lines.join('\r\n')}\r\n`;
    } else {
      content = JSON.stringify({ generatedAt: new Date().toISOString(), ipMasked: job.mask_ip, count: mapped.length, items: mapped }, null, 2);
    }
    await pool.query(`UPDATE exports SET status = 'ready', content = $2, row_count = $3 WHERE id = $1`, [exportId, content, mapped.length]);
  } catch {
    await pool.query(`UPDATE exports SET status = 'failed' WHERE id = $1`, [exportId]);
  }
}

export async function processPendingExports(pool: Pool): Promise<number> {
  const { rows } = await pool.query<{ id: string }>(`SELECT id FROM exports WHERE status = 'pending' AND expires_at > now() ORDER BY created_at LIMIT 5`);
  for (const r of rows) await generateExport(pool, r.id);
  return rows.length;
}
