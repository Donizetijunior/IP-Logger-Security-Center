import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { eventFilterSchema } from '@ipl/shared';
import { AuthService } from '../auth.ts';
import { audit } from '../audit.ts';
import type { Ctx } from '../context.ts';
import { HttpError, iso } from '../util.ts';

const createBody = z.object({
  format: z.enum(['csv', 'json']),
  filters: eventFilterSchema.default({}),
  /** Padrão: IP mascarado (/24 IPv4, /48 IPv6). IP completo exige opt-in explícito e fica auditado. */
  fullIp: z.boolean().default(false),
});

export function registerExports(app: FastifyInstance, ctx: Ctx): void {
  const { pool, config } = ctx;

  app.post('/exports', async (req, reply) => {
    const session = req.session!;
    if (!AuthService.isRecentlyReauthenticated(session)) {
      await audit(pool, { adminId: session.adminId, action: 'export.create', result: 'denied', metadata: { reason: 'reauth_required' } });
      throw new HttpError(403, 'reauth_required', 'Confirme sua senha para exportar dados');
    }
    const body = createBody.parse(req.body);
    const { rows } = await pool.query<{ id: string; expires_at: Date }>(
      `INSERT INTO exports (admin_id, format, filters, mask_ip, expires_at)
       VALUES ($1, $2, $3, $4, now() + ($5 || ' minutes')::interval) RETURNING id, expires_at`,
      [session.adminId, body.format, JSON.stringify(body.filters), !body.fullIp, String(config.EXPORT_TTL_MINUTES)],
    );
    const row = rows[0]!;
    await audit(pool, {
      adminId: session.adminId, action: 'export.create', resource: `export:${row.id}`, result: 'success',
      // o IP filtrado é dado pessoal: a auditoria registra apenas que o filtro foi usado
      metadata: { format: body.format, filters: { ...body.filters, ip: body.filters.ip ? '[informado]' : undefined }, fullIp: body.fullIp },
    });
    return reply.code(202).send({ id: row.id, status: 'pending', expiresAt: iso(row.expires_at) });
  });

  app.get('/exports', async (req) => {
    const { rows } = await pool.query<{ id: string; format: string; status: string; row_count: number | null; created_at: Date; expires_at: Date; mask_ip: boolean }>(
      `SELECT id, format, status, row_count, created_at, expires_at, mask_ip FROM exports
       WHERE admin_id = $1 AND expires_at > now() ORDER BY created_at DESC LIMIT 20`, [req.session!.adminId],
    );
    return {
      items: rows.map((r) => ({
        id: r.id, format: r.format, status: r.status, rowCount: r.row_count, maskedIp: r.mask_ip, createdAt: iso(r.created_at), expiresAt: iso(r.expires_at),
      })),
    };
  });

  app.get('/exports/:id', async (req) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const { rows } = await pool.query<{ id: string; format: string; status: string; row_count: number | null; expires_at: Date }>(
      'SELECT id, format, status, row_count, expires_at FROM exports WHERE id = $1 AND admin_id = $2 AND expires_at > now()', [id, req.session!.adminId],
    );
    if (!rows[0]) throw new HttpError(404, 'not_found', 'Exportação não encontrada ou expirada');
    return { id: rows[0].id, format: rows[0].format, status: rows[0].status, rowCount: rows[0].row_count, expiresAt: iso(rows[0].expires_at) };
  });

  app.get('/exports/:id/download', async (req, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const { rows } = await pool.query<{ format: string; status: string; content: string | null }>(
      'SELECT format, status, content FROM exports WHERE id = $1 AND admin_id = $2 AND expires_at > now()', [id, req.session!.adminId],
    );
    const ex = rows[0];
    if (!ex) throw new HttpError(404, 'not_found', 'Exportação não encontrada ou expirada');
    if (ex.status !== 'ready' || ex.content === null) throw new HttpError(409, 'not_ready', 'Exportação ainda em processamento');
    await audit(pool, { adminId: req.session!.adminId, action: 'export.download', resource: `export:${id}`, result: 'success' });
    return reply
      .header('content-disposition', `attachment; filename="eventos-${id.slice(0, 8)}.${ex.format}"`)
      .type(ex.format === 'csv' ? 'text/csv; charset=utf-8' : 'application/json; charset=utf-8')
      .send(ex.content);
  });
}
