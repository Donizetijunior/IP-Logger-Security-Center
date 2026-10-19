import { isPublicIp } from '@ipl/shared';

export interface RdapSummary {
  handle: string | null;
  name: string | null;
  country: string | null;
  startAddress: string | null;
  endAddress: string | null;
  type: string | null;
  fetchedFrom: string;
}

export interface RdapClient {
  lookup(ip: string): Promise<RdapSummary | null>;
}

/**
 * RDAP sob demanda. Anti-SSRF: o host é fixo (bootstrap público) e só IPs globalmente roteáveis
 * (já validados) entram no caminho da URL; redirecionamentos não são seguidos.
 */
export class HttpRdapClient implements RdapClient {
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(baseUrl = 'https://rdap.org/ip/', fetchImpl: typeof fetch = fetch, timeoutMs = 4000) {
    this.baseUrl = baseUrl;
    this.fetchImpl = fetchImpl;
    this.timeoutMs = timeoutMs;
  }

  async lookup(ip: string): Promise<RdapSummary | null> {
    if (!isPublicIp(ip)) return null;
    const url = `${this.baseUrl}${encodeURIComponent(ip)}`;
    const res = await this.fetchImpl(url, {
      redirect: 'manual',
      signal: AbortSignal.timeout(this.timeoutMs),
      headers: { accept: 'application/rdap+json, application/json' },
    });
    if (!res.ok) return null;
    const body = (await res.json()) as Record<string, unknown>;
    const str = (v: unknown) => (typeof v === 'string' ? v.slice(0, 200) : null);
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
}

export class DisabledRdapClient implements RdapClient {
  async lookup(): Promise<null> {
    return null;
  }
}
