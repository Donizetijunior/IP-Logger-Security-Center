import { isPublicIp, parseIp } from '@ipl/shared';
import { safeFetchJson, type Hop } from './tools/safe-http.ts';

export interface RdapSummary {
  handle: string | null;
  name: string | null;
  country: string | null;
  startAddress: string | null;
  endAddress: string | null;
  type: string | null;
  fetchedFrom: string;
}

export interface DomainSummary {
  domain: string;
  status: string[];
  registrar: string | null;
  nameservers: string[];
  registeredAt: string | null;
  expiresAt: string | null;
  changedAt: string | null;
  fetchedFrom: string;
}

export interface RdapClient {
  lookup(ip: string): Promise<RdapSummary | null>;
  lookupDomain(domain: string): Promise<DomainSummary | null>;
}

const DOMAIN_RE = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9-]{2,63}$/;

/** Normaliza e valida um nome de domínio (sem IP, sem esquema, sem TLDs internos). */
export function normalizeDomain(input: string): string | null {
  let d = input.trim().toLowerCase().replace(/^https?:\/\//, '').split(/[/?#:]/)[0] ?? '';
  d = d.replace(/\.$/, '');
  if (!DOMAIN_RE.test(d) || parseIp(d)) return null;
  if (/\.(local|localhost|internal|lan|home|corp|test|invalid|example)$/.test(d)) return null;
  return d;
}

const str = (v: unknown, max = 200) => (typeof v === 'string' ? v.slice(0, max) : null);

/**
 * RDAP sob demanda via bootstrap público. Anti-SSRF: host inicial fixo, IP público validado/domínio
 * validado por expressão, HTTPS obrigatório e CADA redirecionamento (o rdap.org redireciona ao
 * servidor autoritativo) passa pelo cliente seguro (DNS com trava, portas 80/443, sem IP privado).
 */
export class HttpRdapClient implements RdapClient {
  private readonly baseUrl: string;
  private readonly hop: Hop | undefined;

  constructor(baseUrl = 'https://rdap.org/', hop?: Hop) {
    this.baseUrl = baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`;
    this.hop = hop;
  }

  async lookup(ip: string): Promise<RdapSummary | null> {
    if (!isPublicIp(ip)) return null;
    const url = `${this.baseUrl}ip/${encodeURIComponent(ip)}`;
    const body = (await safeFetchJson(url, { hop: this.hop })) as Record<string, unknown> | null;
    if (!body) return null;
    return {
      handle: str(body.handle),
      name: str(body.name),
      country: str(body.country),
      startAddress: str(body.startAddress),
      endAddress: str(body.endAddress),
      type: str(body.type),
      fetchedFrom: new URL(url).host,
    };
  }

  async lookupDomain(domain: string): Promise<DomainSummary | null> {
    const d = normalizeDomain(domain);
    if (!d) return null;
    const url = `${this.baseUrl}domain/${encodeURIComponent(d)}`;
    const body = (await safeFetchJson(url, { hop: this.hop })) as Record<string, unknown> | null;
    if (!body) return null;

    const events = Array.isArray(body.events) ? (body.events as Array<Record<string, unknown>>) : [];
    const ev = (action: string) => str(events.find((e) => e.eventAction === action)?.eventDate, 40);
    const nameservers = (Array.isArray(body.nameservers) ? (body.nameservers as Array<Record<string, unknown>>) : [])
      .map((n) => str(n.ldhName, 253))
      .filter((n): n is string => !!n)
      .slice(0, 10);
    // Apenas o NOME do registrador (nunca contatos/vCards de pessoas)
    let registrar: string | null = null;
    for (const ent of Array.isArray(body.entities) ? (body.entities as Array<Record<string, unknown>>) : []) {
      if (Array.isArray(ent.roles) && ent.roles.includes('registrar')) {
        const vcard = (ent.vcardArray as unknown[] | undefined)?.[1];
        const fn = Array.isArray(vcard) ? (vcard as unknown[][]).find((p) => p[0] === 'fn') : undefined;
        registrar = str(fn?.[3]) ?? str(ent.handle);
        break;
      }
    }
    return {
      domain: str(body.ldhName, 253) ?? d,
      status: (Array.isArray(body.status) ? body.status : []).map((s) => str(s, 60)).filter((s): s is string => !!s).slice(0, 10),
      registrar,
      nameservers,
      registeredAt: ev('registration'),
      expiresAt: ev('expiration'),
      changedAt: ev('last changed'),
      fetchedFrom: new URL(url).host,
    };
  }
}

export class DisabledRdapClient implements RdapClient {
  async lookup(): Promise<null> {
    return null;
  }

  async lookupDomain(): Promise<null> {
    return null;
  }
}
