import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { audit } from '../audit.ts';
import type { Ctx } from '../context.ts';
import { HttpError, decodeCursor, encodeCursor, iso, ownerScope } from '../util.ts';

const listQuery = z.object({
  status: z.enum(['open', 'investigating', 'resolved']).optional(),
  severity: z.enum(['info', 'low', 'medium', 'high', 'critical']).optional(),
  type: z.string().max(80).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
  cursor: z.string().max(300).optional(),
});
const patchBody = z.object({ status: z.enum(['open', 'investigating', 'resolved']) });

interface AlertRow {
  id: string; type: string; severity: string; status: string; ip: string | null; short_link_id: string | null; slug: string | null;
  title: string; evidence: unknown; dedupe_key: string; occurrences: number; rule_version: string;
  created_raw: string; updated_at: Date;
}

export function registerAlerts(app: FastifyInstance, ctx: Ctx): void {
  const { pool } = ctx;

  app.get('/alerts', async (req) => {
    const q = listQuery.parse(req.query);
    const params: unknown[] = [];
    const where: string[] = [];
    const owner = ownerScope(req);
    if (owner) {
      params.push(owner);
      where.push(`a.short_link_id IN (SELECT id FROM short_links WHERE owner_id = $${params.length})`);
    }
    if (q.status) { params.push(q.status); where.push(`a.status = $${params.length}`); }
    if (q.severity) { params.push(q.severity); where.push(`a.severity = $${params.length}`); }
    if (q.type) { params.push(q.type); where.push(`a.type = $${params.length}`); }
    const cur = decodeCursor(q.cursor);
    if (cur) {
      params.push(cur.t, cur.id);
      where.push(`(a.created_at, a.id) < ($${params.length - 1}::timestamptz, $${params.length}::uuid)`);
    }
    params.push(q.limit + 1);
    const { rows } = await pool.query<AlertRow>(
      `SELECT a.id, a.type, a.severity, a.status, host(a.ip_address) AS ip, a.short_link_id, l.slug, a.title, a.evidence, a.dedupe_key,
              a.occurrences, a.rule_version, to_char(a.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS created_raw, a.updated_at
       FROM alerts a LEFT JOIN short_links l ON l.id = a.short_link_id
       ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
       ORDER BY a.created_at DESC, a.id DESC LIMIT $${params.length}`,
      params,
    );
    const page = rows.slice(0, q.limit);
    const last = page[page.length - 1];
    return {
      items: page.map((r) => ({
        id: r.id, type: r.type, severity: r.severity, status: r.status, ipAddress: r.ip, shortLinkId: r.short_link_id, slug: r.slug,
        title: r.title, evidence: r.evidence, occurrences: r.occurrences, ruleVersion: r.rule_version, createdAt: r.created_raw, updatedAt: iso(r.updated_at),
      })),
      nextCursor: rows.length > q.limit && last ? encodeCursor({ t: last.created_raw, id: last.id }) : null,
    };
  });

  app.patch('/alerts/:id', async (req) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const { status } = patchBody.parse(req.body);
    const { rows } = await pool.query<{ id: string; status: string }>(
      `UPDATE alerts SET status = $2, updated_at = now() WHERE id = $1
       AND ($3::uuid IS NULL OR short_link_id IN (SELECT id FROM short_links WHERE owner_id = $3)) RETURNING id, status`, [id, status, ownerScope(req)],
    );
    if (!rows[0]) throw new HttpError(404, 'not_found', 'Alerta não encontrado');
    await audit(pool, { accountId: req.session!.accountId, action: 'alert.status', resource: `alert:${id}`, result: 'success', metadata: { status } });
    return rows[0];
  });
}
