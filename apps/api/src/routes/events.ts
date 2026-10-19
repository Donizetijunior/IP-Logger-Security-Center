import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { buildEventWhere, eventFilterSchema, normalizeIp } from '@ipl/shared';
import type { Ctx } from '../context.ts';
import { HttpError, decodeCursor, encodeCursor, iso, ownerScope } from '../util.ts';

const listQuery = eventFilterSchema.extend({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  cursor: z.string().max(300).optional(),
});

interface EventRow {
  id: string; short_link_id: string | null; slug: string; ip_address: string; occurred_raw: string; method: string; http_status: number;
  user_agent: string | null; accept_language: string | null; referer_origin: string | null; client_class: string; device_class: string | null;
  browser: string | null; os: string | null; country: string | null; region: string | null; city: string | null; asn: number | null;
  asn_org: string | null; rdns: string | null; tor_exit: string; enrichment_status: string; enriched_at: Date | null;
  risk_score: number | null; risk_level: string;
}

const EVENT_COLS = `e.id, e.short_link_id, e.slug, host(e.ip_address) AS ip_address,
  to_char(e.occurred_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS occurred_raw,
  e.method, e.http_status, e.user_agent, e.accept_language, e.referer_origin, e.client_class, e.device_class, e.browser, e.os,
  e.country, e.region, e.city, e.asn, e.asn_org, e.rdns, e.tor_exit, e.enrichment_status, e.enriched_at, e.risk_score, e.risk_level`;

export function eventDto(r: EventRow) {
  return {
    id: r.id,
    shortLinkId: r.short_link_id,
    slug: r.slug,
    occurredAt: r.occurred_raw,
    ipAddress: r.ip_address,
    method: r.method,
    httpStatus: r.http_status,
    userAgent: r.user_agent,
    acceptLanguage: r.accept_language,
    refererOrigin: r.referer_origin,
    clientClass: r.client_class,
    device: { class: r.device_class, browser: r.browser, os: r.os },
    geo: { country: r.country, region: r.region, city: r.city, asn: r.asn, asnOrg: r.asn_org },
    rdns: r.rdns,
    torExit: r.tor_exit,
    enrichmentStatus: r.enrichment_status,
    enrichedAt: iso(r.enriched_at),
    risk: { score: r.risk_score, level: r.risk_level },
  };
}

export function registerEvents(app: FastifyInstance, ctx: Ctx): void {
  const { pool } = ctx;

  app.get('/events', async (req) => {
    const q = listQuery.parse(req.query);
    const { limit, cursor, ...filters } = q;
    const { clauses, params } = buildEventWhere(filters, 0, ownerScope(req));
    const cur = decodeCursor(cursor);
    if (cur) {
      params.push(cur.t, cur.id);
      clauses.push(`(e.occurred_at, e.id) < ($${params.length - 1}::timestamptz, $${params.length}::uuid)`);
    }
    params.push(limit + 1);
    const { rows } = await pool.query<EventRow>(
      `SELECT ${EVENT_COLS} FROM access_events e
       ${clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''}
       ORDER BY e.occurred_at DESC, e.id DESC LIMIT $${params.length}`,
      params,
    );
    const page = rows.slice(0, limit);
    const last = page[page.length - 1];
    return {
      items: page.map(eventDto),
      nextCursor: rows.length > limit && last ? encodeCursor({ t: last.occurred_raw, id: last.id }) : null,
    };
  });

  app.get('/events/:id', async (req) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const { rows } = await pool.query<EventRow & { link_label: string | null; target_url: string | null }>(
      `SELECT ${EVENT_COLS}, l.label AS link_label, l.target_url
       FROM access_events e LEFT JOIN short_links l ON l.id = e.short_link_id
       WHERE e.id = $1 AND ($2::uuid IS NULL OR l.owner_id = $2)`,
      [id, ownerScope(req)],
    );
    const ev = rows[0];
    if (!ev) throw new HttpError(404, 'not_found', 'Evento não encontrado');
    const assess = await pool.query<{ score: number | null; level: string; evidence: unknown; engine_version: string; assessed_at: Date }>(
      'SELECT score, level, evidence, engine_version, assessed_at FROM risk_assessments WHERE access_event_id = $1 ORDER BY assessed_at DESC LIMIT 1',
      [id],
    );
    const intel = await pool.query<{ source: string; status: string; checked_at: Date; expires_at: Date; data_redacted: unknown; error_code: string | null }>(
      'SELECT source, status, checked_at, expires_at, data_redacted, error_code FROM ip_intelligence WHERE ip_address = $1::inet ORDER BY source',
      [ev.ip_address],
    );
    const a = assess.rows[0];
    return {
      ...eventDto(ev),
      link: { label: ev.link_label, targetUrl: ev.target_url },
      assessment: a ? { score: a.score, level: a.level, evidence: a.evidence, engineVersion: a.engine_version, assessedAt: iso(a.assessed_at) } : null,
      intelligence: intel.rows.map((i) => ({
        source: i.source, status: i.status, checkedAt: iso(i.checked_at), expiresAt: iso(i.expires_at), data: i.data_redacted, errorCode: i.error_code,
      })),
      notice: 'Estimativas referem-se ao endereço de rede e não identificam uma pessoa.',
    };
  });

  app.get('/ips/:ip', async (req) => {
    const params = z.object({ ip: z.string().max(45) }).parse(req.params);
    const query = z.object({ rdap: z.enum(['true', 'false']).default('false') }).parse(req.query);
    const ip = normalizeIp(params.ip);
    if (!ip) throw new HttpError(400, 'invalid_ip', 'IP inválido');
    const owner = ownerScope(req);
    const inScope = 'e.short_link_id IN (SELECT id FROM short_links WHERE owner_id = $2)';

    const [timeline, links, intel, totals] = await Promise.all([
      pool.query<EventRow>(
        `SELECT ${EVENT_COLS} FROM access_events e WHERE e.ip_address = $1::inet AND ($2::uuid IS NULL OR ${inScope}) ORDER BY e.occurred_at DESC, e.id DESC LIMIT 200`, [ip, owner],
      ),
      pool.query<{ id: string; slug: string; label: string | null; hits: number; last_at: Date }>(
        `SELECT l.id, l.slug, l.label, count(*)::int AS hits, max(e.occurred_at) AS last_at
         FROM access_events e JOIN short_links l ON l.id = e.short_link_id
         WHERE e.ip_address = $1::inet AND ($2::uuid IS NULL OR l.owner_id = $2) GROUP BY l.id, l.slug, l.label ORDER BY hits DESC LIMIT 50`, [ip, owner],
      ),
      pool.query<{ source: string; status: string; checked_at: Date; expires_at: Date; data_redacted: unknown; error_code: string | null }>(
        'SELECT source, status, checked_at, expires_at, data_redacted, error_code FROM ip_intelligence WHERE ip_address = $1::inet ORDER BY source', [ip],
      ),
      pool.query<{ total: number; first_at: Date | null; last_at: Date | null; max_score: number | null }>(
        `SELECT count(*)::int AS total, min(occurred_at) AS first_at, max(occurred_at) AS last_at, max(risk_score) AS max_score
         FROM access_events e WHERE e.ip_address = $1::inet AND ($2::uuid IS NULL OR ${inScope})`, [ip, owner],
      ),
    ]);

    // Usuários comuns só podem investigar IPs que acessaram os próprios links
    if (owner && totals.rows[0]!.total === 0) throw new HttpError(404, 'not_found', 'Nenhum acesso deste IP aos seus links');

    let rdap: unknown = intel.rows.find((i) => i.source === 'rdap')?.data_redacted ?? null;
    if (query.rdap === 'true' && config_rdap(ctx)) {
      try {
        const fresh = await ctx.rdap.lookup(ip);
        if (fresh) {
          rdap = fresh;
          await pool.query(
            `INSERT INTO ip_intelligence (ip_address, source, status, data_redacted, expires_at)
             VALUES ($1::inet, 'rdap', 'ok', $2, now() + interval '24 hours')
             ON CONFLICT (ip_address, source) DO UPDATE SET checked_at = now(), expires_at = EXCLUDED.expires_at, status = 'ok', data_redacted = EXCLUDED.data_redacted, error_code = NULL`,
            [ip, JSON.stringify(fresh)],
          );
        }
      } catch {
        rdap = rdap ?? null;
      }
    }

    const t = totals.rows[0]!;
    const latest = timeline.rows[0];
    return {
      ip,
      summary: {
        totalEvents: t.total,
        firstSeenAt: iso(t.first_at),
        lastSeenAt: iso(t.last_at),
        maxRiskScore: t.max_score,
        latestRiskLevel: latest?.risk_level ?? 'not_evaluated',
        geo: latest ? { country: latest.country, region: latest.region, city: latest.city, asn: latest.asn, asnOrg: latest.asn_org } : null,
        rdns: latest?.rdns ?? null,
        torExit: latest?.tor_exit ?? 'unknown',
      },
      links: links.rows.map((l) => ({ id: l.id, slug: l.slug, label: l.label, hits: l.hits, lastAt: iso(l.last_at) })),
      intelligence: intel.rows.filter((i) => i.source !== 'rdap').map((i) => ({
        source: i.source, status: i.status, checkedAt: iso(i.checked_at), expiresAt: iso(i.expires_at), data: i.data_redacted, errorCode: i.error_code,
      })),
      rdap,
      timeline: timeline.rows.map(eventDto),
      notice:
        'Geolocalização, reputação e demais dados referem-se ao endereço de rede (que pode ser compartilhado por NAT/VPN) e não permitem identificar uma pessoa.',
    };
  });
}

function config_rdap(ctx: Ctx): boolean {
  return ctx.config.RDAP_ENABLED;
}
