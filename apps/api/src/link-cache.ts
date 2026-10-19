import type { Pool } from '@ipl/database';

export interface LinkRecord {
  id: string;
  slug: string;
  target_url: string;
  is_active: boolean;
  expires_at: Date | null;
  deleted_at: Date | null;
  domain_id: string | null;
}

interface Entry {
  link: LinkRecord | null;
  fetchedAt: number;
}

export interface LinkLookup {
  link: LinkRecord | null;
  /** true quando o banco falhou e foi usada cópia em cache (fail-open). */
  degraded: boolean;
}

const MAIN = '-';
const keyOf = (slug: string, domainId: string | null) => `${domainId ?? MAIN}|${slug}`;

/**
 * Cache em memória dos links resolvidos, por (domínio, slug). Mantém cópia "stale" por até staleMs para
 * que o redirect continue funcionando se o PostgreSQL ficar indisponível (política fail-open documentada).
 * Alterações administrativas invalidam a entrada imediatamente (instância única de API).
 */
export class LinkCache {
  private readonly entries = new Map<string, Entry>();
  private static readonly NEGATIVE_TTL_MS = 5_000;

  private readonly pool: Pool;
  private readonly ttlMs: number;
  private readonly staleMs: number;
  private readonly now: () => number;

  constructor(pool: Pool, ttlMs: number, staleMs: number, now: () => number = Date.now) {
    this.pool = pool;
    this.ttlMs = ttlMs;
    this.staleMs = staleMs;
    this.now = now;
  }

  /** domainId = null resolve no domínio principal. Um link nunca responde fora do domínio a que pertence. */
  async get(slug: string, domainId: string | null = null): Promise<LinkLookup> {
    const key = keyOf(slug, domainId);
    const hit = this.entries.get(key);
    const t = this.now();
    if (hit) {
      const ttl = hit.link ? this.ttlMs : LinkCache.NEGATIVE_TTL_MS;
      if (t - hit.fetchedAt < ttl) return { link: hit.link, degraded: false };
    }
    try {
      const { rows } = await this.pool.query<LinkRecord>(
        `SELECT id, slug, target_url, is_active, expires_at, deleted_at, domain_id FROM short_links
         WHERE slug = $1 AND domain_id IS NOT DISTINCT FROM $2::uuid`,
        [slug, domainId],
      );
      const link = rows[0] ?? null;
      this.entries.set(key, { link, fetchedAt: t });
      this.evictIfLarge();
      return { link, degraded: false };
    } catch (err) {
      if (hit && hit.link && t - hit.fetchedAt < this.staleMs) return { link: hit.link, degraded: true };
      throw err;
    }
  }

  /** Invalida o slug em TODOS os domínios (ou só em um, se informado). */
  invalidate(slug: string, domainId?: string | null): void {
    if (domainId !== undefined) {
      this.entries.delete(keyOf(slug, domainId));
      return;
    }
    for (const k of this.entries.keys()) if (k.endsWith(`|${slug}`)) this.entries.delete(k);
  }

  /** Invalida todos os links de um domínio (ex.: domínio desativado). */
  invalidateDomain(domainId: string): void {
    for (const k of this.entries.keys()) if (k.startsWith(`${domainId}|`)) this.entries.delete(k);
  }

  clear(): void {
    this.entries.clear();
  }

  private evictIfLarge(): void {
    if (this.entries.size <= 10_000) return;
    const oldest = this.entries.keys().next().value;
    if (oldest !== undefined) this.entries.delete(oldest);
  }
}
