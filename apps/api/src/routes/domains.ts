import { randomBytes } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { validateTargetUrl } from '@ipl/shared';
import { audit } from '../audit.ts';
import type { Ctx } from '../context.ts';
import { TXT_PREFIX, TXT_VALUE_PREFIX, challengeFor, stripPort, type DomainStatus } from '../domains.ts';
import { normalizeDomain } from '../rdap.ts';
import { SafeHttpError } from '../tools/safe-http.ts';
import { HttpError, iso, requireAdmin } from '../util.ts';

const idParam = z.object({ id: z.string().uuid() });
const createBody = z.object({
  hostname: z.string().min(3).max(300),
  rootRedirectUrl: z.string().max(2048).nullish(),
});
const patchBody = z.object({
  status: z.enum(['active', 'disabled']).optional(),
  rootRedirectUrl: z.string().max(2048).nullable().optional(),
});

interface DomainRow {
  id: string; owner_id: string; owner_email?: string; owner_role?: string; hostname: string; verification_token: string; status: DomainStatus;
  verified_at: Date | null; approved_at: Date | null; root_redirect_url: string | null; routing_ok: boolean | null;
  last_check_at: Date | null; last_check_error: string | null; created_at: Date; links?: number;
}

export function registerDomains(app: FastifyInstance, ctx: Ctx): void {
  const { pool, config, domains, linkCache } = ctx;
  const scheme = new URL(config.PUBLIC_SHORT_BASE_URL).protocol.replace(':', '');
  const platformHosts = [config.shortHost, config.dashboardHost].map(stripPort);

  const dto = (r: DomainRow, showOwner: boolean) => ({
    id: r.id,
    hostname: r.hostname,
    status: r.status,
    owner: showOwner ? { id: r.owner_id, email: r.owner_email ?? null } : undefined,
    verifiedAt: iso(r.verified_at),
    approvedAt: iso(r.approved_at),
    rootRedirectUrl: r.root_redirect_url,
    routingOk: r.routing_ok,
    lastCheckAt: iso(r.last_check_at),
    lastCheckError: r.last_check_error,
    createdAt: iso(r.created_at),
    links: r.links ?? 0,
    // Instruções (o token é público por desenho: fica em um TXT no DNS)
    dns: { txtName: `${TXT_PREFIX}.${r.hostname}`, txtValue: `${TXT_VALUE_PREFIX}${r.verification_token}` },
    routing: { serviceUrl: config.TUNNEL_SERVICE_URL, hostname: r.hostname },
  });

  const loadOwned = async (req: { session: { role: string; accountId: string } | null }, id: string): Promise<DomainRow> => {
    const { rows } = await pool.query<DomainRow>(
      `SELECT d.*, a.email AS owner_email, a.role AS owner_role,
              (SELECT count(*)::int FROM short_links l WHERE l.domain_id = d.id AND l.deleted_at IS NULL) AS links
       FROM custom_domains d JOIN accounts a ON a.id = d.owner_id WHERE d.id = $1`, [id],
    );
    const d = rows[0];
    if (!d || (req.session!.role !== 'admin' && d.owner_id !== req.session!.accountId)) throw new HttpError(404, 'not_found', 'Domínio não encontrado');
    return d;
  };

  const refresh = async (domainId?: string) => {
    await domains.refresh();
    if (domainId) linkCache.invalidateDomain(domainId);
  };

  app.get('/domains', async (req) => {
    const s = req.session!;
    const admin = s.role === 'admin';
    const { rows } = await pool.query<DomainRow>(
      `SELECT d.*, a.email AS owner_email,
              (SELECT count(*)::int FROM short_links l WHERE l.domain_id = d.id AND l.deleted_at IS NULL) AS links
       FROM custom_domains d JOIN accounts a ON a.id = d.owner_id
       WHERE ($1::boolean OR d.owner_id = $2) ORDER BY d.created_at DESC LIMIT 200`,
      [admin, s.accountId],
    );
    const used = rows.filter((r) => r.owner_id === s.accountId).length;
    return {
      items: rows.map((r) => dto(r, admin)),
      policy: {
        mode: config.CUSTOM_DOMAINS_MODE,
        canCreate: admin || config.CUSTOM_DOMAINS_MODE !== 'admin',
        max: admin ? null : config.CUSTOM_DOMAINS_MAX_PER_USER,
        used,
      },
    };
  });

  app.post('/domains', { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } }, async (req, reply) => {
    const s = req.session!;
    const admin = s.role === 'admin';
    if (!admin && config.CUSTOM_DOMAINS_MODE === 'admin') {
      throw new HttpError(403, 'domains_admin_only', 'O cadastro de domínios personalizados está restrito ao administrador deste serviço.');
    }
    const body = createBody.parse(req.body);
    const hostname = normalizeDomain(body.hostname);
    if (!hostname) throw new HttpError(400, 'invalid_hostname', 'Informe um domínio válido, como go.exemplo.com.br (sem curinga, IP ou endereço interno).');
    if (platformHosts.includes(hostname)) throw new HttpError(400, 'reserved_hostname', 'Este endereço pertence à própria plataforma.');
    if (!admin && platformHosts.some((p) => hostname.endsWith(`.${p}`))) {
      throw new HttpError(400, 'reserved_hostname', 'Subdomínios da plataforma só podem ser cadastrados pelo administrador.');
    }
    let rootRedirect: string | null = null;
    if (body.rootRedirectUrl) {
      const t = validateTargetUrl(body.rootRedirectUrl, config.allowedDomains);
      if (!t.ok) throw new HttpError(400, 'invalid_target', `Redirecionamento da raiz inválido: ${t.reason}`);
      rootRedirect = t.url!;
    }
    if (!admin) {
      const { rows } = await pool.query<{ n: number }>('SELECT count(*)::int AS n FROM custom_domains WHERE owner_id = $1', [s.accountId]);
      if ((rows[0]?.n ?? 0) >= config.CUSTOM_DOMAINS_MAX_PER_USER) {
        throw new HttpError(403, 'quota_exceeded', `Limite de ${config.CUSTOM_DOMAINS_MAX_PER_USER} domínios atingido.`);
      }
    }
    try {
      const { rows } = await pool.query<DomainRow>(
        `INSERT INTO custom_domains (owner_id, hostname, verification_token, root_redirect_url) VALUES ($1, $2, $3, $4) RETURNING *`,
        [s.accountId, hostname, randomBytes(18).toString('base64url'), rootRedirect],
      );
      await audit(pool, { accountId: s.accountId, action: 'domain.create', resource: `domain:${rows[0]!.id}`, result: 'success', metadata: { hostname } });
      await refresh();
      return reply.code(201).send(dto(rows[0]!, false));
    } catch (err) {
      if ((err as { code?: string }).code === '23505') throw new HttpError(409, 'hostname_taken', 'Este domínio já está cadastrado.');
      throw err;
    }
  });

  /** Verifica a propriedade (TXT no DNS) e a chegada do tráfego (checagem de roteamento). */
  app.post('/domains/:id/verify', { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } }, async (req) => {
    const { id } = idParam.parse(req.params);
    let d = await loadOwned(req, id);
    if (d.status === 'disabled') throw new HttpError(409, 'domain_disabled', 'Domínio desativado pelo administrador.');

    let message: string | null = null;
    if (!d.verified_at) {
      let records: string[][] = [];
      try {
        records = await ctx.resolveTxt(`${TXT_PREFIX}.${d.hostname}`);
      } catch (err) {
        const code = (err as { code?: string }).code;
        if (code && !['ENOTFOUND', 'ENODATA', 'ESERVFAIL', 'ETIMEOUT', 'ECONNREFUSED'].includes(code)) throw err;
      }
      const expected = `${TXT_VALUE_PREFIX}${d.verification_token}`;
      const found = records.some((chunks) => chunks.join('').trim() === expected);
      if (!found) {
        message = `Registro TXT não encontrado em ${TXT_PREFIX}.${d.hostname}. A propagação do DNS pode levar alguns minutos.`;
        await pool.query('UPDATE custom_domains SET last_check_at = now(), last_check_error = $2 WHERE id = $1', [id, message]);
        await audit(pool, { accountId: req.session!.accountId, action: 'domain.verify', resource: `domain:${id}`, result: 'failure', metadata: { step: 'txt' } });
      } else {
        const auto = d.owner_role === 'admin' || config.CUSTOM_DOMAINS_MODE === 'open';
        await pool.query(
          `UPDATE custom_domains SET verified_at = now(), status = $2, approved_at = CASE WHEN $2 = 'active' THEN now() ELSE NULL END, last_check_error = NULL
           WHERE id = $1`,
          [id, auto ? 'active' : 'pending_approval'],
        );
        await audit(pool, { accountId: req.session!.accountId, action: 'domain.verify', resource: `domain:${id}`, result: 'success', metadata: { step: 'txt', status: auto ? 'active' : 'pending_approval' } });
        await refresh(id);
      }
    }

    // Checagem de roteamento (somente depois de verificado): o domínio precisa chegar a esta instalação
    const fresh = await loadOwned(req, id);
    if (fresh.verified_at) {
      let routingOk = false;
      let err: string | null = null;
      try {
        const r = await ctx.hop(`${scheme}://${d.hostname}/.well-known/iplogger-check`, { method: 'GET', maxBodyBytes: 2048, timeoutMs: 6000 });
        const body = r.body ? (JSON.parse(r.body.toString('utf8')) as { challenge?: string }) : {};
        routingOk = r.status === 200 && body.challenge === challengeFor(fresh.verification_token);
        if (!routingOk) err = `O domínio respondeu HTTP ${r.status}, mas não chegou a esta instalação. Confira a rota do túnel (${config.TUNNEL_SERVICE_URL}).`;
      } catch (e) {
        err = e instanceof SafeHttpError ? `Não foi possível acessar https://${d.hostname}: ${e.message}` : 'Resposta inesperada ao checar o roteamento.';
      }
      await pool.query('UPDATE custom_domains SET routing_ok = $2, last_check_at = now(), last_check_error = $3 WHERE id = $1', [id, routingOk, err]);
    }
    d = await loadOwned(req, id);
    return { verified: !!d.verified_at, message, domain: dto(d, req.session!.role === 'admin') };
  });

  app.patch('/domains/:id', async (req) => {
    const { id } = idParam.parse(req.params);
    const body = patchBody.parse(req.body);
    const d = await loadOwned(req, id);
    const sets: string[] = [];
    const params: unknown[] = [id];
    if (body.status !== undefined) {
      requireAdmin(req);
      if (body.status === 'active' && !d.verified_at) throw new HttpError(409, 'not_verified', 'O domínio ainda não teve a propriedade verificada (TXT).');
      params.push(body.status);
      sets.push(`status = $${params.length}`);
      sets.push(body.status === 'active' ? 'approved_at = now()' : 'approved_at = approved_at');
    }
    if (body.rootRedirectUrl !== undefined) {
      let url: string | null = null;
      if (body.rootRedirectUrl) {
        const t = validateTargetUrl(body.rootRedirectUrl, config.allowedDomains);
        if (!t.ok) throw new HttpError(400, 'invalid_target', `Redirecionamento da raiz inválido: ${t.reason}`);
        url = t.url!;
      }
      params.push(url);
      sets.push(`root_redirect_url = $${params.length}`);
    }
    if (sets.length === 0) throw new HttpError(400, 'empty_patch', 'Nada para alterar');
    await pool.query(`UPDATE custom_domains SET ${sets.join(', ')} WHERE id = $1`, params);
    await audit(pool, { accountId: req.session!.accountId, action: 'domain.update', resource: `domain:${id}`, result: 'success', metadata: body });
    await refresh(id);
    return dto(await loadOwned(req, id), req.session!.role === 'admin');
  });

  app.delete('/domains/:id', async (req) => {
    const { id } = idParam.parse(req.params);
    const d = await loadOwned(req, id);
    if ((d.links ?? 0) > 0) {
      throw new HttpError(409, 'domain_in_use', `Este domínio ainda tem ${d.links} link(s) ativo(s). Remova-os antes de excluir o domínio.`);
    }
    // Links já removidos (soft delete) deixam de ser necessários: apaga com os respectivos eventos
    await pool.query('DELETE FROM access_events WHERE short_link_id IN (SELECT id FROM short_links WHERE domain_id = $1)', [id]);
    await pool.query('DELETE FROM alerts WHERE short_link_id IN (SELECT id FROM short_links WHERE domain_id = $1)', [id]);
    await pool.query('DELETE FROM short_links WHERE domain_id = $1', [id]);
    await pool.query('DELETE FROM custom_domains WHERE id = $1', [id]);
    await audit(pool, { accountId: req.session!.accountId, action: 'domain.delete', resource: `domain:${id}`, result: 'success', metadata: { hostname: d.hostname } });
    await refresh(id);
    return { ok: true };
  });
}
