import type { ProviderStatus } from '@ipl/shared';
import { isIpv4, isPublicIp } from '@ipl/shared';

export interface ProviderResult {
  status: ProviderStatus;
  data: Record<string, unknown> | null;
  errorCode: string | null;
  /** Em segundos: quando 429/Retry-After. */
  retryAfterSec?: number;
}

export interface ReputationProvider {
  readonly source: 'abuseipdb' | 'greynoise';
  readonly enabled: boolean;
  readonly dailyQuota: number;
  /** false => o provedor não atende este IP (ex.: IPv6 no GreyNoise Community); não consome quota. */
  supports(ip: string): boolean;
  query(ip: string): Promise<ProviderResult>;
}

type FetchLike = typeof fetch;

const TIMEOUT_MS = 5000;

function retryAfter(res: Response): number | undefined {
  const v = Number(res.headers.get('retry-after'));
  return Number.isFinite(v) && v > 0 ? v : undefined;
}

export class AbuseIpDbProvider implements ReputationProvider {
  readonly source = 'abuseipdb' as const;
  readonly enabled: boolean;
  readonly dailyQuota: number;
  private readonly apiKey: string | undefined;
  private readonly fetchImpl: FetchLike;
  private readonly baseUrl: string;

  constructor(opts: { enabled: boolean; apiKey?: string; dailyQuota: number; fetchImpl?: FetchLike; baseUrl?: string }) {
    this.enabled = opts.enabled;
    this.apiKey = opts.apiKey;
    this.dailyQuota = opts.dailyQuota;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.baseUrl = opts.baseUrl ?? 'https://api.abuseipdb.com/api/v2/check';
  }

  supports(ip: string): boolean {
    return isPublicIp(ip);
  }

  async query(ip: string): Promise<ProviderResult> {
    if (!this.enabled) return { status: 'disabled', data: null, errorCode: null };
    if (!this.apiKey) return { status: 'disabled', data: null, errorCode: 'missing_api_key' };
    if (!isPublicIp(ip)) return { status: 'not_queried', data: null, errorCode: 'non_public_ip' };
    const url = new URL(this.baseUrl);
    url.searchParams.set('ipAddress', ip);
    url.searchParams.set('maxAgeInDays', '30');
    let res: Response;
    try {
      res = await this.fetchImpl(url, {
        headers: { Key: this.apiKey, Accept: 'application/json' },
        signal: AbortSignal.timeout(TIMEOUT_MS),
        redirect: 'error',
      });
    } catch (err) {
      return { status: 'unavailable', data: null, errorCode: (err as Error).name === 'TimeoutError' ? 'timeout' : 'network_error' };
    }
    if (res.status === 429) return { status: 'rate_limited', data: null, errorCode: 'http_429', retryAfterSec: retryAfter(res) };
    if (res.status === 401 || res.status === 403) return { status: 'unavailable', data: null, errorCode: 'auth_error' };
    if (!res.ok) return { status: 'unavailable', data: null, errorCode: `http_${res.status}` };
    try {
      const body = (await res.json()) as { data?: Record<string, unknown> };
      const d = body.data;
      if (!d || typeof d.abuseConfidenceScore !== 'number') return { status: 'unavailable', data: null, errorCode: 'bad_payload' };
      return {
        status: 'ok',
        errorCode: null,
        data: {
          abuseConfidenceScore: d.abuseConfidenceScore,
          totalReports: d.totalReports ?? null,
          numDistinctUsers: d.numDistinctUsers ?? null,
          lastReportedAt: d.lastReportedAt ?? null,
          usageType: d.usageType ?? null,
          isp: d.isp ?? null,
          domain: d.domain ?? null,
          countryCode: d.countryCode ?? null,
          isWhitelisted: d.isWhitelisted ?? null,
          isTor: d.isTor ?? null,
        },
      };
    } catch {
      return { status: 'unavailable', data: null, errorCode: 'bad_payload' };
    }
  }
}

export class GreyNoiseCommunityProvider implements ReputationProvider {
  readonly source = 'greynoise' as const;
  readonly enabled: boolean;
  readonly dailyQuota: number;
  private readonly apiKey: string | undefined;
  private readonly fetchImpl: FetchLike;
  private readonly baseUrl: string;

  constructor(opts: { enabled: boolean; apiKey?: string; dailyQuota: number; fetchImpl?: FetchLike; baseUrl?: string }) {
    this.enabled = opts.enabled;
    this.apiKey = opts.apiKey;
    this.dailyQuota = opts.dailyQuota;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.baseUrl = opts.baseUrl ?? 'https://api.greynoise.io/v3/community/';
  }

  supports(ip: string): boolean {
    return isPublicIp(ip) && isIpv4(ip);
  }

  async query(ip: string): Promise<ProviderResult> {
    if (!this.enabled) return { status: 'disabled', data: null, errorCode: null };
    // O endpoint Community aceita somente IPv4 público roteável
    if (!isPublicIp(ip) || !isIpv4(ip)) return { status: 'not_queried', data: null, errorCode: isIpv4(ip) ? 'non_public_ip' : 'ipv6_unsupported' };
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.baseUrl}${encodeURIComponent(ip)}`, {
        headers: { Accept: 'application/json', ...(this.apiKey ? { key: this.apiKey } : {}) },
        signal: AbortSignal.timeout(TIMEOUT_MS),
        redirect: 'error',
      });
    } catch (err) {
      return { status: 'unavailable', data: null, errorCode: (err as Error).name === 'TimeoutError' ? 'timeout' : 'network_error' };
    }
    if (res.status === 404) {
      // 404 = IP não observado: ausência de contexto, NÃO prova de segurança
      return { status: 'no_data', data: { noise: false, riot: false }, errorCode: null };
    }
    if (res.status === 429) return { status: 'rate_limited', data: null, errorCode: 'http_429', retryAfterSec: retryAfter(res) };
    if (res.status === 401 || res.status === 403) return { status: 'unavailable', data: null, errorCode: 'auth_error' };
    if (!res.ok) return { status: 'unavailable', data: null, errorCode: `http_${res.status}` };
    try {
      const d = (await res.json()) as Record<string, unknown>;
      return {
        status: 'ok',
        errorCode: null,
        data: {
          noise: d.noise ?? false,
          riot: d.riot ?? false,
          classification: d.classification ?? null,
          name: d.name ?? null,
          lastSeen: d.last_seen ?? null,
        },
      };
    } catch {
      return { status: 'unavailable', data: null, errorCode: 'bad_payload' };
    }
  }
}
