import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { classifyClient, isPublicIp, normalizeIp, parseIp, sanitizeText } from '@ipl/shared';
import { reverseDnsLookup } from '../tools/rdns.ts';
import { lookupMac } from '../tools/oui.ts';
import { SafeHttpError } from '../tools/safe-http.ts';
import { checkUrl } from '../tools/url-check.ts';
import { normalizeDomain } from '../rdap.ts';
import type { Ctx } from '../context.ts';
import { HttpError, iso } from '../util.ts';

const MAX_ACTIVE_NOTES = 50;
const MAX_CIPHERTEXT = 40_000;

const noteBody = z.object({
  ciphertext: z.string().min(16).max(MAX_CIPHERTEXT).regex(/^[A-Za-z0-9_\-+/=]+$/, 'formato inválido'),
  iv: z.string().min(8).max(64).regex(/^[A-Za-z0-9_\-+/=]+$/, 'formato inválido'),
  ttlHours: z.number().int().min(1).max(168).default(24),
});
const idParam = z.object({ id: z.string().uuid() });

/** Cache simples em memória para consultas RDAP (reduz chamadas ao serviço externo). */
class TtlCache<T> {
  private readonly m = new Map<string, { v: T; exp: number }>();
  private readonly ttl: number;
  private readonly max: number;

  constructor(ttlMs: number, max = 500) {
    this.ttl = ttlMs;
    this.max = max;
  }

  get(k: string): T | undefined {
    const e = this.m.get(k);
    if (!e) return undefined;
    if (e.exp < Date.now()) {
      this.m.delete(k);
      return undefined;
    }
    return e.v;
  }

  set(k: string, v: T): void {
    if (this.m.size >= this.max) this.m.delete(this.m.keys().next().value as string);
    this.m.set(k, { v, exp: Date.now() + this.ttl });
  }
}

function describeRange(ip: string): { range: string; label: string } {
  const r = parseIp(ip)?.range() ?? 'invalid';
  const labels: Record<string, string> = {
    unicast: 'Público (roteável na Internet)', private: 'Privado (rede local)', loopback: 'Loopback (a própria máquina)',
    linkLocal: 'Link-local', carrierGradeNat: 'CGNAT (compartilhado pela operadora)', multicast: 'Multicast', reserved: 'Reservado / documentação',
    uniqueLocal: 'Privado (ULA IPv6)', unspecified: 'Não especificado', broadcast: 'Broadcast',
  };
  return { range: r, label: labels[r] ?? 'Não público' };
}

export function registerTools(app: FastifyInstance, ctx: Ctx): void {
  const { pool, config, geo, rdap } = ctx;
  const rdapCache = new TtlCache<unknown>(3600_000);
  const limit = (max: number) => ({ config: { rateLimit: { max, timeWindow: '1 minute' } } });

  const upstream = (err: unknown): never => {
    if (err instanceof SafeHttpError) throw new HttpError(502, 'upstream_error', `Consulta externa falhou: ${err.message}`);
    throw new HttpError(502, 'upstream_error', 'Consulta externa falhou');
  };

  const torStatus = async (ip: string): Promise<boolean | 'unknown'> => {
    const s = await pool.query<{ ok: boolean }>(`SELECT (value->>'state' = 'ready') AS ok FROM job_state WHERE key = 'tor_list'`);
    if (!s.rows[0]?.ok) return 'unknown';
    return (await pool.query('SELECT 1 FROM tor_exit_nodes WHERE ip_address = $1::inet', [ip])).rowCount === 1;
  };

  // ---- Meu IP e meu User-Agent (o que a plataforma enxerga da sua conexão)
  app.get('/tools/whoami', limit(60), async (req) => {
    const ip = req.clientIp;
    const ua = sanitizeText(req.headers['user-agent'], 512);
    const client = classifyClient('GET', ua);
    return {
      ip,
      version: ip ? (ip.includes(':') ? 'IPv6' : 'IPv4') : null,
      ...(ip ? describeRange(ip) : { range: 'unknown', label: 'Desconhecido' }),
      tor: ip && isPublicIp(ip) ? await torStatus(ip) : 'unknown',
      userAgent: ua,
      browser: client.browser,
      os: client.os,
      deviceClass: client.deviceClass,
      acceptLanguage: sanitizeText(req.headers['accept-language'], 100),
      note: 'Este é o endereço que o servidor enxerga. Atrás de VPN, proxy ou rede compartilhada, ele pode não ser o do seu dispositivo.',
    };
  });

  // ---- Consulta de IP
  app.get('/tools/ip/:ip', limit(30), async (req) => {
    const { ip: raw } = z.object({ ip: z.string().max(45) }).parse(req.params);
    const { rdap: wantRdap } = z.object({ rdap: z.enum(['true', 'false']).default('false') }).parse(req.query);
    const ip = normalizeIp(raw);
    if (!ip) throw new HttpError(400, 'invalid_ip', 'IP inválido');
    const where = describeRange(ip);
    if (!isPublicIp(ip)) {
      return { ip, version: ip.includes(':') ? 'IPv6' : 'IPv4', ...where, public: false, notice: 'IP não público: não há geolocalização, reputação ou registro RDAP para consultar.' };
    }
    const [g, rdns, tor] = await Promise.all([geo.lookup(ip), reverseDnsOrNull(ip), torStatus(ip)]);
    let rd: unknown = null;
    if (wantRdap === 'true') {
      if (!config.RDAP_ENABLED) throw new HttpError(503, 'rdap_disabled', 'RDAP desabilitado neste servidor');
      rd = rdapCache.get(`ip:${ip}`) ?? null;
      if (!rd) {
        try {
          rd = await rdap.lookup(ip);
        } catch (err) {
          upstream(err);
        }
        if (rd) rdapCache.set(`ip:${ip}`, rd);
      }
    }
    return {
      ip, version: ip.includes(':') ? 'IPv6' : 'IPv4', ...where, public: true,
      geo: g, rdns, tor, rdap: rd,
      notice: 'Geolocalização e demais dados referem-se ao endereço de rede (NAT/VPN/CGNAT) e não identificam uma pessoa.',
    };
  });

  // ---- WHOIS/RDAP de domínio ou IP
  app.get('/tools/whois', limit(20), async (req) => {
    const { q } = z.object({ q: z.string().min(3).max(300) }).parse(req.query);
    if (!config.RDAP_ENABLED) throw new HttpError(503, 'rdap_disabled', 'RDAP desabilitado neste servidor');
    const ip = normalizeIp(q.trim());
    if (ip) {
      if (!isPublicIp(ip)) throw new HttpError(400, 'non_public_ip', 'Apenas IPs públicos têm registro RDAP');
      let r = rdapCache.get(`ip:${ip}`);
      if (!r) {
        try {
          r = await rdap.lookup(ip);
        } catch (err) {
          upstream(err);
        }
        if (r) rdapCache.set(`ip:${ip}`, r);
      }
      return { kind: 'ip', query: ip, result: r ?? null };
    }
    const domain = normalizeDomain(q);
    if (!domain) throw new HttpError(400, 'invalid_query', 'Informe um domínio (ex.: exemplo.com.br) ou um IP público');
    let r = rdapCache.get(`d:${domain}`);
    if (!r) {
      try {
        r = await rdap.lookupDomain(domain);
      } catch (err) {
        upstream(err);
      }
      if (r) rdapCache.set(`d:${domain}`, r);
    }
    return { kind: 'domain', query: domain, result: r ?? null, notice: r ? undefined : 'Sem registro RDAP para este domínio (o TLD pode não oferecer RDAP).' };
  });

  // ---- Fabricante pelo MAC (OUI)
  app.get('/tools/mac', limit(60), async (req) => {
    const { q } = z.object({ q: z.string().min(6).max(40) }).parse(req.query);
    const info = lookupMac(q);
    if (!info.valid) throw new HttpError(400, 'invalid_mac', 'MAC inválido. Use 6 a 12 dígitos hexadecimais (ex.: 00:1A:2B ou 00:1A:2B:3C:4D:5E).');
    return {
      ...info,
      notice: info.locallyAdministered
        ? 'Este endereço é administrado localmente (comum em MAC aleatório de privacidade de celulares/PCs): o fabricante não pode ser determinado.'
        : info.vendor ? 'Fabricante conforme o registro público OUI do IEEE.' : 'Prefixo não encontrado no registro OUI.',
    };
  });

  // ---- Verificador de URL (cadeia de redirecionamentos, sem baixar conteúdo)
  app.post('/tools/url-check', limit(15), async (req) => {
    const { url } = z.object({ url: z.string().min(3).max(2048) }).parse(req.body);
    ctx.telemetry.increment('tool_url_check');
    return checkUrl(url, { hop: ctx.hop, ownHosts: [config.shortHost.split(':')[0]!, config.dashboardHost.split(':')[0]!] });
  });

  // ---- Notas privadas autodestrutivas (cifradas no navegador; gerenciamento por conta)
  app.post('/tools/notes', limit(20), async (req, reply) => {
    const session = req.session!;
    const body = noteBody.parse(req.body);
    const active = await pool.query<{ n: number }>('SELECT count(*)::int AS n FROM private_notes WHERE account_id = $1 AND expires_at > now()', [session.accountId]);
    if ((active.rows[0]?.n ?? 0) >= MAX_ACTIVE_NOTES) throw new HttpError(403, 'quota_exceeded', `Limite de ${MAX_ACTIVE_NOTES} notas ativas atingido`);
    const { rows } = await pool.query<{ id: string; expires_at: Date }>(
      `INSERT INTO private_notes (account_id, ciphertext, iv, expires_at) VALUES ($1, $2, $3, now() + ($4 || ' hours')::interval) RETURNING id, expires_at`,
      [session.accountId, body.ciphertext, body.iv, String(body.ttlHours)],
    );
    return reply.code(201).send({ id: rows[0]!.id, expiresAt: iso(rows[0]!.expires_at) });
  });

  app.get('/tools/notes', async (req) => {
    const { rows } = await pool.query<{ id: string; created_at: Date; expires_at: Date }>(
      'SELECT id, created_at, expires_at FROM private_notes WHERE account_id = $1 AND expires_at > now() ORDER BY created_at DESC LIMIT 100',
      [req.session!.accountId],
    );
    return { items: rows.map((r) => ({ id: r.id, createdAt: iso(r.created_at), expiresAt: iso(r.expires_at) })) };
  });

  app.delete('/tools/notes/:id', async (req) => {
    const { id } = idParam.parse(req.params);
    const { rowCount } = await pool.query('DELETE FROM private_notes WHERE id = $1 AND account_id = $2', [id, req.session!.accountId]);
    if (!rowCount) throw new HttpError(404, 'not_found', 'Nota não encontrada');
    return { ok: true };
  });

}

async function reverseDnsOrNull(ip: string): Promise<string | null> {
  return reverseDnsLookup(ip);
}
