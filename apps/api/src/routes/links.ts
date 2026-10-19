import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { generateSlug, isValidSlug, validateTargetUrl } from '@ipl/shared';
import { audit } from '../audit.ts';
import type { Ctx } from '../context.ts';
import { HttpError, decodeCursor, encodeCursor, iso } from '../util.ts';

const createBody = z.object({
  slug: z.string().max(64).optional(),
  label: z.string().max(200).nullish(),
  targetUrl: z.string().max(2048),
  expiresAt: z.string().datetime().nullish(),
});
const patchBody = z.object({
  label: z.string().max(200).nullable().optional(),
  targetUrl: z.string().max(2048).optional(),
  expiresAt: z.string().datetime().nullable().optional(),
  isActive: z.boolean().optional(),
});
const idParam = z.object({ id: z.string().uuid() });
const listQuery = z.object({
  q: z.string().max(100).optional(),
  active: z.enum(['true', 'false']).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
  cursor: z.string().max(300).optional(),
});

interface LinkRow {
  id: string; slug: string; target_url: string; label: string | null; is_active: boolean;
  expires_at: Date | null; created_at: Date; updated_at: Date; deleted_at: Date | null;
  total?: number; uniques?: number; last_access?: Date | null;
}

export function registerLinks(app: FastifyInstance, ctx: Ctx): void {
  const { pool, config, linkCache } = ctx;

  const toDto = (r: LinkRow) => ({
    id: r.id,
    slug: r.slug,
    publicUrl: `${config.PUBLIC_SHORT_BASE_URL.replace(/\/$/, '')}/${r.slug}`,
    targetUrl: r.target_url,
    label: r.label,
    isActive: r.is_active,
    expiresAt: iso(r.expires_at),
    createdAt: iso(r.created_at),
    updatedAt: iso(r.updated_at),
    status: r.deleted_at ? 'deleted' : !r.is_active ? 'inactive' : r.expires_at && r.expires_at.getTime() <= Date.now() ? 'expired' : 'active',
    metrics: r.total === undefined ? undefined : { requests: r.total, uniqueIps: r.uniques ?? 0, lastAccessAt: iso(r.last_access) },
  });

  app.post('/links', async (req, reply) => {
    const body = createBody.parse(req.body);
    const target = validateTargetUrl(body.targetUrl, config.allowedDomains);
    if (!target.ok) throw new HttpError(400, 'invalid_target', target.reason ?? 'Destino inválido');
    let slug = body.slug;
    if (slug !== undefined && !isValidSlug(slug)) {
      throw new HttpError(400, 'invalid_slug', 'Slug inválido ou reservado (3–64 caracteres: letras, números, - e _)');
    }
    if (body.expiresAt && Date.parse(body.expiresAt) <= Date.now()) {
      throw new HttpError(400, 'invalid_expiry', 'A validade deve estar no futuro');
    }
    for (let attempt = 0; attempt < 5; attempt++) {
      const candidate = slug ?? generateSlug(8);
      if (!isValidSlug(candidate)) continue;
      try {
        const { rows } = await pool.query<LinkRow>(
          `INSERT INTO short_links (slug, target_url, label, expires_at) VALUES ($1, $2, $3, $4) RETURNING *`,
          [candidate, target.url, body.label ?? null, body.expiresAt ?? null],
        );
        const row = rows[0]!;
        linkCache.invalidate(row.slug);
        await audit(pool, { adminId: req.session!.adminId, action: 'link.create', resource: `link:${row.id}`, result: 'success', metadata: { slug: row.slug } });
        return reply.code(201).send(toDto(row));
      } catch (err) {
        if ((err as { code?: string }).code === '23505') {
          if (slug !== undefined) throw new HttpError(409, 'slug_taken', 'Este slug já está em uso');
          slug = undefined;
          continue;
        }
        throw err;
      }
    }
    throw new HttpError(500, 'slug_generation_failed', 'Não foi possível gerar um slug único');
  });

  app.get('/links', async (req) => {
    const q = listQuery.parse(req.query);
    const params: unknown[] = [];
    const where: string[] = ['l.deleted_at IS NULL'];
    if (q.q) {
      params.push(`%${q.q.replace(/[%_\\]/g, '\\$&')}%`);
      where.push(`(l.slug ILIKE $${params.length} OR l.label ILIKE $${params.length} OR l.target_url ILIKE $${params.length})`);
    }
    if (q.active) where.push(q.active === 'true' ? `l.is_active AND (l.expires_at IS NULL OR l.expires_at > now())` : `(NOT l.is_active OR l.expires_at <= now())`);
    const cur = decodeCursor(q.cursor);
    if (cur) {
      params.push(cur.t, cur.id);
      where.push(`(l.created_at, l.id) < ($${params.length - 1}::timestamptz, $${params.length}::uuid)`);
    }
    params.push(q.limit + 1);
    const { rows } = await pool.query<LinkRow & { created_raw: string }>(
      `SELECT l.*, to_char(l.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS created_raw,
         COALESCE(s.total, 0)::int AS total, COALESCE(s.uniques, 0)::int AS uniques, s.last_access
       FROM short_links l
       LEFT JOIN LATERAL (
         SELECT count(*) AS total, count(DISTINCT ip_address) AS uniques, max(occurred_at) AS last_access
         FROM access_events e WHERE e.short_link_id = l.id
       ) s ON true
       WHERE ${where.join(' AND ')}
       ORDER BY l.created_at DESC, l.id DESC
       LIMIT $${params.length}`,
      params,
    );
    const page = rows.slice(0, q.limit);
    const last = page[page.length - 1];
    return {
      items: page.map(toDto),
      nextCursor: rows.length > q.limit && last ? encodeCursor({ t: last.created_raw, id: last.id }) : null,
    };
  });

  app.get('/links/:id', async (req) => {
    const { id } = idParam.parse(req.params);
    const { rows } = await pool.query<LinkRow>(
      `SELECT l.*, COALESCE(s.total, 0)::int AS total, COALESCE(s.uniques, 0)::int AS uniques, s.last_access
       FROM short_links l
       LEFT JOIN LATERAL (SELECT count(*) AS total, count(DISTINCT ip_address) AS uniques, max(occurred_at) AS last_access
                          FROM access_events e WHERE e.short_link_id = l.id) s ON true
       WHERE l.id = $1 AND l.deleted_at IS NULL`,
      [id],
    );
    if (!rows[0]) throw new HttpError(404, 'not_found', 'Link não encontrado');
    return toDto(rows[0]);
  });

  app.patch('/links/:id', async (req) => {
    const { id } = idParam.parse(req.params);
    const body = patchBody.parse(req.body);
    const sets: string[] = [];
    const params: unknown[] = [id];
    const add = (col: string, val: unknown) => {
      params.push(val);
      sets.push(`${col} = $${params.length}`);
    };
    if (body.label !== undefined) add('label', body.label);
    if (body.isActive !== undefined) add('is_active', body.isActive);
    if (body.expiresAt !== undefined) add('expires_at', body.expiresAt);
    if (body.targetUrl !== undefined) {
      const target = validateTargetUrl(body.targetUrl, config.allowedDomains);
      if (!target.ok) throw new HttpError(400, 'invalid_target', target.reason ?? 'Destino inválido');
      add('target_url', target.url);
    }
    if (sets.length === 0) throw new HttpError(400, 'empty_patch', 'Nada para alterar');
    const { rows } = await pool.query<LinkRow>(
      `UPDATE short_links SET ${sets.join(', ')}, updated_at = now() WHERE id = $1 AND deleted_at IS NULL RETURNING *`,
      params,
    );
    const row = rows[0];
    if (!row) throw new HttpError(404, 'not_found', 'Link não encontrado');
    linkCache.invalidate(row.slug);
    await audit(pool, { adminId: req.session!.adminId, action: 'link.update', resource: `link:${id}`, result: 'success', metadata: { fields: Object.keys(body) } });
    return toDto(row);
  });

  app.delete('/links/:id', async (req) => {
    const { id } = idParam.parse(req.params);
    const { rows } = await pool.query<LinkRow>(
      `UPDATE short_links SET deleted_at = now(), is_active = false, updated_at = now() WHERE id = $1 AND deleted_at IS NULL RETURNING *`,
      [id],
    );
    if (!rows[0]) throw new HttpError(404, 'not_found', 'Link não encontrado');
    linkCache.invalidate(rows[0].slug);
    await audit(pool, { adminId: req.session!.adminId, action: 'link.delete', resource: `link:${id}`, result: 'success' });
    return { ok: true };
  });
}
