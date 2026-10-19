import type { Pool } from '@ipl/database';
import type { ProviderObservation, ProviderStatus } from '@ipl/shared';
import type { ProviderResult, ReputationProvider } from './providers.ts';

interface CircuitState {
  failures: number;
  openUntil: number;
}

export interface IntelOptions {
  cacheTtlHours: number;
  negativeTtlHours: number;
  /** Janela do circuito aberto após falhas repetidas. */
  circuitOpenMs?: number;
  circuitThreshold?: number;
  now?: () => number;
}

/**
 * Consulta provedores com: cache compartilhado por IP (Postgres), cache negativo, quota diária,
 * respeito a Retry-After/429 (estado rate_limited sem laço de requisições), deduplicação de
 * consultas em andamento e circuit breaker para falhas repetidas.
 */
export class IntelService {
  private readonly pool: Pool;
  private readonly opts: IntelOptions;
  private readonly circuits = new Map<string, CircuitState>();
  private readonly inflight = new Map<string, Promise<ProviderObservation>>();

  constructor(pool: Pool, opts: IntelOptions) {
    this.pool = pool;
    this.opts = opts;
  }

  private now(): number {
    return (this.opts.now ?? Date.now)();
  }

  async lookup(provider: ReputationProvider, ip: string): Promise<ProviderObservation> {
    const key = `${provider.source}|${ip}`;
    const existing = this.inflight.get(key);
    if (existing) return existing;
    const p = this.doLookup(provider, ip).finally(() => this.inflight.delete(key));
    this.inflight.set(key, p);
    return p;
  }

  private async doLookup(provider: ReputationProvider, ip: string): Promise<ProviderObservation> {
    if (!provider.enabled) return { source: provider.source, status: 'disabled', checkedAt: null };
    if (!provider.supports(ip)) return { source: provider.source, status: 'not_queried', checkedAt: null };

    const cached = await this.readCache(provider.source, ip);
    if (cached) return cached;

    const circuit = this.circuits.get(provider.source);
    if (circuit && circuit.openUntil > this.now()) {
      return { source: provider.source, status: 'unavailable', checkedAt: null, data: { reason: 'circuit_open' } };
    }

    if (!(await this.consumeQuota(provider.source, provider.dailyQuota))) {
      // Quota esgotada: registra estado e evita novas tentativas até a renovação (ou 1 h)
      await this.writeCache(provider.source, ip, { status: 'rate_limited', data: null, errorCode: 'daily_quota_exhausted' }, 1);
      return { source: provider.source, status: 'rate_limited', checkedAt: new Date(this.now()).toISOString() };
    }

    const result = await provider.query(ip);
    await this.afterQuery(provider, ip, result);
    return {
      source: provider.source,
      status: result.status,
      checkedAt: new Date(this.now()).toISOString(),
      data: result.data,
    };
  }

  private async afterQuery(provider: ReputationProvider, ip: string, result: ProviderResult): Promise<void> {
    const c = this.circuits.get(provider.source) ?? { failures: 0, openUntil: 0 };
    let ttlHours = this.opts.cacheTtlHours;
    if (result.status === 'ok' || result.status === 'no_data') {
      c.failures = 0;
    } else if (result.status === 'rate_limited') {
      const wait = Math.max(result.retryAfterSec ?? 900, 60);
      c.openUntil = this.now() + wait * 1000;
      ttlHours = Math.max(wait / 3600, 0.02);
    } else if (result.status === 'unavailable') {
      c.failures += 1;
      ttlHours = 5 / 60; // cache negativo curto: 5 min
      if (c.failures >= (this.opts.circuitThreshold ?? 5)) {
        c.openUntil = this.now() + (this.opts.circuitOpenMs ?? 5 * 60_000);
        c.failures = 0;
      }
    } else if (result.status === 'not_queried' || result.status === 'disabled') {
      ttlHours = this.opts.cacheTtlHours;
    }
    if (result.status === 'no_data') ttlHours = this.opts.negativeTtlHours;
    this.circuits.set(provider.source, c);
    await this.writeCache(provider.source, ip, result, ttlHours);
    await this.pool.query(
      `INSERT INTO job_state (key, value, updated_at) VALUES ($1, $2, now())
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
      [`provider:${provider.source}`, JSON.stringify({ state: c.openUntil > this.now() ? 'open' : 'closed', openUntil: c.openUntil > this.now() ? new Date(c.openUntil).toISOString() : null, lastStatus: result.status, lastError: result.errorCode })],
    );
  }

  private async readCache(source: string, ip: string): Promise<ProviderObservation | null> {
    const { rows } = await this.pool.query<{ status: ProviderStatus; data_redacted: Record<string, unknown> | null; checked_at: Date }>(
      'SELECT status, data_redacted, checked_at FROM ip_intelligence WHERE ip_address = $1::inet AND source = $2 AND expires_at > now()',
      [ip, source],
    );
    const r = rows[0];
    if (!r) return null;
    return { source, status: r.status, checkedAt: r.checked_at.toISOString(), data: r.data_redacted };
  }

  private async writeCache(source: string, ip: string, result: Pick<ProviderResult, 'status' | 'data' | 'errorCode'>, ttlHours: number): Promise<void> {
    await this.pool.query(
      `INSERT INTO ip_intelligence (ip_address, source, status, data_redacted, error_code, checked_at, expires_at)
       VALUES ($1::inet, $2, $3, $4, $5, now(), now() + ($6 || ' seconds')::interval)
       ON CONFLICT (ip_address, source) DO UPDATE
         SET status = EXCLUDED.status, data_redacted = EXCLUDED.data_redacted, error_code = EXCLUDED.error_code,
             checked_at = now(), expires_at = EXCLUDED.expires_at`,
      [ip, source, result.status, result.data ? JSON.stringify(result.data) : null, result.errorCode, String(Math.round(ttlHours * 3600))],
    );
  }

  /** Incrementa o uso diário (UTC) apenas se ainda houver quota. */
  private async consumeQuota(source: string, dailyQuota: number): Promise<boolean> {
    const { rowCount } = await this.pool.query(
      `INSERT INTO provider_quota (source, window_start, used) VALUES ($1, (now() AT TIME ZONE 'UTC')::date, 1)
       ON CONFLICT (source, window_start) DO UPDATE SET used = provider_quota.used + 1
       WHERE provider_quota.used < $2`,
      [source, dailyQuota],
    );
    return rowCount === 1;
  }
}
