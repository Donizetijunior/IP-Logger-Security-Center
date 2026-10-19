import { randomBytes } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import QRCode from 'qrcode';
import { z } from 'zod';
import { AuthService, EMAIL_REGEX, createAdminAccount, hashPassword, validatePasswordStrength } from '../auth.ts';
import { audit } from '../audit.ts';
import type { Ctx } from '../context.ts';
import { HttpError, decodeCursor, encodeCursor, requireAdmin } from '../util.ts';

const idParam = z.object({ id: z.string().uuid() });
const createBody = z.object({
  email: z.string().max(254).regex(EMAIL_REGEX, 'E-mail inválido'),
  password: z.string().max(256).optional(),
  linkQuota: z.number().int().min(0).max(100000).optional(),
});
const patchBody = z.object({
  status: z.enum(['active', 'pending', 'suspended']).optional(),
  linkQuota: z.number().int().min(0).max(100000).optional(),
});
const listQuery = z.object({
  q: z.string().max(100).optional(),
  status: z.enum(['active', 'pending', 'suspended']).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  cursor: z.string().max(300).optional(),
});

/** Senha temporária forte, exibida uma única vez ao administrador. */
export function generateTempPassword(): string {
  return `Tmp-${randomBytes(9).toString('base64url')}-${randomBytes(2).toString('hex')}#`;
}

interface UserRow {
  id: string; email: string; role: string; status: string; link_quota: number; signup_source: string;
  must_change_password: boolean; created_raw: string; links: number; events: number;
}


/** Apaga a conta e tudo o que depende dela (links, eventos, alertas, sessões, exportações), sem deixar eventos órfãos. */
export async function eraseAccount(ctx: Ctx, accountId: string): Promise<number> {
  const { pool, linkCache } = ctx;
  const client = await pool.connect();
  let slugs: string[] = [];
  try {
    await client.query('BEGIN');
    const s = await client.query<{ slug: string }>('SELECT slug FROM short_links WHERE owner_id = $1', [accountId]);
    slugs = s.rows.map((r) => r.slug);
    await client.query('DELETE FROM alerts WHERE short_link_id IN (SELECT id FROM short_links WHERE owner_id = $1)', [accountId]);
    await client.query('DELETE FROM access_events WHERE short_link_id IN (SELECT id FROM short_links WHERE owner_id = $1)', [accountId]);
    await client.query('DELETE FROM accounts WHERE id = $1', [accountId]); // cascade: links, sessões, exportações
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
  for (const sl of slugs) linkCache.invalidate(sl);
  return slugs.length;
}

export function registerUsers(app: FastifyInstance, ctx: Ctx): void {
  const { pool, auth, linkCache } = ctx;

  const dto = (r: UserRow) => ({
    id: r.id, email: r.email, role: r.role, status: r.status, linkQuota: r.link_quota, signupSource: r.signup_source,
    mustChangePassword: r.must_change_password, createdAt: r.created_raw, links: r.links, events: r.events,
  });

  app.get('/users', async (req) => {
    requireAdmin(req);
    const q = listQuery.parse(req.query);
    const params: unknown[] = [];
    const where: string[] = [];
    if (q.q) {
      params.push(`%${q.q.replace(/[%_\\]/g, '\\$&')}%`);
      where.push(`a.email ILIKE $${params.length}`);
    }
    if (q.status) {
      params.push(q.status);
      where.push(`a.status = $${params.length}`);
    }
    const cur = decodeCursor(q.cursor);
    if (cur) {
      params.push(cur.t, cur.id);
      where.push(`(a.created_at, a.id) < ($${params.length - 1}::timestamptz, $${params.length}::uuid)`);
    }
    params.push(q.limit + 1);
    const { rows } = await pool.query<UserRow>(
      `SELECT a.id, a.email, a.role, a.status, a.link_quota, a.signup_source, a.must_change_password,
              to_char(a.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS created_raw,
              (SELECT count(*)::int FROM short_links l WHERE l.owner_id = a.id AND l.deleted_at IS NULL) AS links,
              (SELECT count(*)::int FROM access_events e JOIN short_links l ON l.id = e.short_link_id WHERE l.owner_id = a.id) AS events
       FROM accounts a ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
       ORDER BY a.created_at DESC, a.id DESC LIMIT $${params.length}`,
      params,
    );
    const page = rows.slice(0, q.limit);
    const last = page[page.length - 1];
    return { items: page.map(dto), nextCursor: rows.length > q.limit && last ? encodeCursor({ t: last.created_raw, id: last.id }) : null };
  });

  app.post('/users', async (req, reply) => {
    requireAdmin(req);
    const body = createBody.parse(req.body);
    const temp = body.password === undefined;
    const password = body.password ?? generateTempPassword();
    if (!temp) {
      const weak = validatePasswordStrength(password);
      if (weak) throw new HttpError(400, 'weak_password', weak);
    }
    try {
      const { rows } = await pool.query<{ id: string }>(
        `INSERT INTO accounts (email, password_hash, role, status, terms_accepted_at, link_quota, must_change_password, created_by, signup_source)
         VALUES ($1, $2, 'user', 'active', NULL, $3, true, $4, 'admin') RETURNING id`,
        [body.email.trim(), await hashPassword(password), body.linkQuota ?? ctx.config.DEFAULT_LINK_QUOTA, req.session!.accountId],
      );
      await audit(pool, { accountId: req.session!.accountId, action: 'user.create', resource: `user:${rows[0]!.id}`, result: 'success' });
      // A senha só é devolvida quando gerada pelo sistema, e uma única vez
      return reply.code(201).send({ id: rows[0]!.id, email: body.email.trim(), temporaryPassword: temp ? password : undefined });
    } catch (err) {
      if ((err as { code?: string }).code === '23505') throw new HttpError(409, 'email_taken', 'Este e-mail já está cadastrado');
      throw err;
    }
  });

  /** Novo administrador (MFA obrigatório). Exige reautenticação recente; segredo e códigos são exibidos UMA vez. */
  app.post('/users/admins', { config: { rateLimit: { max: 5, timeWindow: '1 minute' } } }, async (req, reply) => {
    requireAdmin(req);
    const session = req.session!;
    if (!AuthService.isRecentlyReauthenticated(session)) {
      await audit(pool, { accountId: session.accountId, action: 'admin.create', result: 'denied', metadata: { reason: 'reauth_required' } });
      throw new HttpError(403, 'reauth_required', 'Confirme sua senha para criar um administrador');
    }
    const body = z.object({ email: z.string().max(254).regex(EMAIL_REGEX, 'E-mail inválido'), password: z.string().max(256).optional() }).parse(req.body);
    const temp = body.password === undefined;
    const password = body.password ?? generateTempPassword();
    if (!temp) {
      const weak = validatePasswordStrength(password);
      if (weak) throw new HttpError(400, 'weak_password', weak);
    }
    try {
      const r = await createAdminAccount(pool, ctx.encKey, { email: body.email, password, signupSource: 'admin', createdBy: session.accountId, mustChangePassword: true });
      const qrSvg = await QRCode.toString(r.otpauthUri, { type: 'svg', margin: 1, width: 240 });
      await audit(pool, { accountId: session.accountId, action: 'admin.create', resource: `user:${r.accountId}`, result: 'success' });
      return reply.code(201).send({
        id: r.accountId, email: body.email.trim(), temporaryPassword: temp ? password : undefined,
        totpSecret: r.totpSecret, otpauthUri: r.otpauthUri, qrSvg, recoveryCodes: r.recoveryCodes,
      });
    } catch (err) {
      if ((err as { code?: string }).code === '23505') throw new HttpError(409, 'email_taken', 'Este e-mail já está cadastrado');
      throw err;
    }
  });

  /**
   * Carrega a conta-alvo e aplica as proteções: ninguém altera a própria conta por aqui e nunca se
   * remove/suspende o ÚLTIMO administrador ativo (evita trancar o sistema).
   */
  const targetUser = async (id: string, actorId: string, removing = false) => {
    const { rows } = await pool.query<{ id: string; role: string; email: string }>('SELECT id, role, email FROM accounts WHERE id = $1', [id]);
    const u = rows[0];
    if (!u) throw new HttpError(404, 'not_found', 'Usuário não encontrado');
    if (u.id === actorId) throw new HttpError(400, 'self_protected', 'Você não pode alterar, suspender ou excluir a sua própria conta por aqui');
    if (u.role === 'admin' && removing) {
      const others = await pool.query("SELECT 1 FROM accounts WHERE role = 'admin' AND status = 'active' AND id <> $1", [id]);
      if (others.rowCount === 0) throw new HttpError(409, 'last_admin', 'Não é possível remover o último administrador ativo');
    }
    return u;
  };

  app.patch('/users/:id', async (req) => {
    requireAdmin(req);
    const { id } = idParam.parse(req.params);
    const body = patchBody.parse(req.body);
    const target = await targetUser(id, req.session!.accountId, !!body.status && body.status !== 'active');
    const sets: string[] = [];
    const params: unknown[] = [id];
    if (body.status) { params.push(body.status); sets.push(`status = $${params.length}`); }
    if (body.linkQuota !== undefined) { params.push(body.linkQuota); sets.push(`link_quota = $${params.length}`); }
    if (sets.length === 0) throw new HttpError(400, 'empty_patch', 'Nada para alterar');
    await pool.query(`UPDATE accounts SET ${sets.join(', ')} WHERE id = $1`, params);
    if (body.status && body.status !== 'active') {
      await auth.revokeAllSessions(id);
      // Suspender também desativa os redirecionamentos dos links do usuário
      if (body.status === 'suspended' && target.role === 'user') {
        const { rows } = await pool.query<{ slug: string }>(
          'UPDATE short_links SET is_active = false, moderation_disabled = true, updated_at = now() WHERE owner_id = $1 AND is_active RETURNING slug', [id],
        );
        for (const r of rows) linkCache.invalidate(r.slug);
        // Domínios personalizados da conta suspensa também deixam de responder (o admin reativa se for o caso)
        await pool.query("UPDATE custom_domains SET status = 'disabled' WHERE owner_id = $1 AND status <> 'disabled'", [id]);
        await ctx.domains.refresh();
      }
    }
    await audit(pool, { accountId: req.session!.accountId, action: 'user.update', resource: `user:${id}`, result: 'success', metadata: body });
    return { ok: true };
  });

  app.post('/users/:id/reset-password', async (req) => {
    requireAdmin(req);
    const { id } = idParam.parse(req.params);
    await targetUser(id, req.session!.accountId);
    const temp = generateTempPassword();
    await pool.query('UPDATE accounts SET password_hash = $2, must_change_password = true, failed_logins = 0, locked_until = NULL WHERE id = $1', [id, await hashPassword(temp)]);
    await auth.revokeAllSessions(id);
    await audit(pool, { accountId: req.session!.accountId, action: 'user.reset_password', resource: `user:${id}`, result: 'success' });
    return { temporaryPassword: temp };
  });

  app.delete('/users/:id', async (req) => {
    requireAdmin(req);
    const { id } = idParam.parse(req.params);
    await targetUser(id, req.session!.accountId, true);
    const links = await eraseAccount(ctx, id);
    await audit(pool, { accountId: req.session!.accountId, action: 'user.delete', resource: `user:${id}`, result: 'success', metadata: { links } });
    return { ok: true };
  });
}
