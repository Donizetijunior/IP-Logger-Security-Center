import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { audit } from '../audit.ts';
import type { Ctx } from '../context.ts';
import { HttpError, decodeCursor, encodeCursor, requireAdmin } from '../util.ts';

const listQuery = z.object({
  status: z.enum(['open', 'reviewing', 'link_disabled', 'dismissed']).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
  cursor: z.string().max(300).optional(),
});
const patchBody = z.object({
  status: z.enum(['open', 'reviewing', 'link_disabled', 'dismissed']),
  /** Suspende também a conta dona do link (e desativa todos os links dela). */
  suspendOwner: z.boolean().optional(),
});

interface ReportRow {
  id: string; slug: string; link_id: string | null; reason: string; details: string | null; contact: string | null; status: string;
  created_raw: string; target_url: string | null; owner_id: string | null; owner_email: string | null; owner_status: string | null;
}

/** Fila de denúncias de abuso (apenas administrador). */
export function registerReports(app: FastifyInstance, ctx: Ctx): void {
  const { pool, linkCache, auth } = ctx;

  app.get('/reports', async (req) => {
    requireAdmin(req);
    const q = listQuery.parse(req.query);
    const params: unknown[] = [];
    const where: string[] = [];
    if (q.status) { params.push(q.status); where.push(`r.status = $${params.length}`); }
    const cur = decodeCursor(q.cursor);
    if (cur) {
      params.push(cur.t, cur.id);
      where.push(`(r.created_at, r.id) < ($${params.length - 1}::timestamptz, $${params.length}::uuid)`);
    }
    params.push(q.limit + 1);
    const { rows } = await pool.query<ReportRow>(
      `SELECT r.id, r.slug, r.link_id, r.reason, r.details, r.contact, r.status,
              to_char(r.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS created_raw,
              l.target_url, a.id AS owner_id, a.email AS owner_email, a.status AS owner_status
       FROM abuse_reports r LEFT JOIN short_links l ON l.id = r.link_id LEFT JOIN accounts a ON a.id = l.owner_id
       ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
       ORDER BY r.created_at DESC, r.id DESC LIMIT $${params.length}`,
      params,
    );
    const page = rows.slice(0, q.limit);
    const last = page[page.length - 1];
    return {
      items: page.map((r) => ({
        id: r.id, slug: r.slug, linkId: r.link_id, reason: r.reason, details: r.details, contact: r.contact, status: r.status,
        createdAt: r.created_raw, targetUrl: r.target_url, owner: r.owner_id ? { id: r.owner_id, email: r.owner_email, status: r.owner_status } : null,
      })),
      nextCursor: rows.length > q.limit && last ? encodeCursor({ t: last.created_raw, id: last.id }) : null,
    };
  });

  app.patch('/reports/:id', async (req) => {
    requireAdmin(req);
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const body = patchBody.parse(req.body);
    const { rows } = await pool.query<{ link_id: string | null }>(
      `UPDATE abuse_reports SET status = $2, resolved_at = CASE WHEN $2 IN ('link_disabled', 'dismissed') THEN now() ELSE NULL END
       WHERE id = $1 RETURNING link_id`, [id, body.status],
    );
    if (!rows[0]) throw new HttpError(404, 'not_found', 'Denúncia não encontrada');
    const linkId = rows[0].link_id;
    if (body.status === 'link_disabled' && linkId) {
      const d = await pool.query<{ slug: string }>('UPDATE short_links SET is_active = false, moderation_disabled = true, updated_at = now() WHERE id = $1 RETURNING slug', [linkId]);
      for (const r of d.rows) linkCache.invalidate(r.slug);
    }
    if (body.suspendOwner && linkId) {
      const o = await pool.query<{ id: string }>(
        `UPDATE accounts SET status = 'suspended' WHERE role = 'user' AND id = (SELECT owner_id FROM short_links WHERE id = $1) RETURNING id`, [linkId],
      );
      for (const u of o.rows) {
        await auth.revokeAllSessions(u.id);
        const s = await pool.query<{ slug: string }>('UPDATE short_links SET is_active = false, moderation_disabled = true, updated_at = now() WHERE owner_id = $1 AND is_active RETURNING slug', [u.id]);
        for (const r of s.rows) linkCache.invalidate(r.slug);
        await pool.query("UPDATE custom_domains SET status = 'disabled' WHERE owner_id = $1 AND status <> 'disabled'", [u.id]);
      }
      await ctx.domains.refresh();
    }
    await audit(pool, { accountId: req.session!.accountId, action: 'report.update', resource: `report:${id}`, result: 'success', metadata: body });
    return { ok: true };
  });
}
