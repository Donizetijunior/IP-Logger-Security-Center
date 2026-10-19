import type { Pool } from '@ipl/database';

export interface LinkRecord {
  id: string;
  slug: string;
  target_url: string;
  is_active: boolean;
  expires_at: Date | null;
  deleted_at: Date | null;
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

/**
 * Cache em memória dos links resolvidos. Mantém cópia "stale" por até staleMs para que o redirect
 * continue funcionando se o PostgreSQL ficar indisponível (política fail-open documentada).
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

  async get(slug: string): Promise<LinkLookup> {
    const hit = this.entries.get(slug);
    const t = this.now();
    if (hit) {
      const ttl = hit.link ? this.ttlMs : LinkCache.NEGATIVE_TTL_MS;
      if (t - hit.fetchedAt < ttl) return { link: hit.link, degraded: false };
    }
    try {
      const { rows } = await this.pool.query<LinkRecord>(
        'SELECT id, slug, target_url, is_active, expires_at, deleted_at FROM short_links WHERE slug = $1',
        [slug],
      );
      const link = rows[0] ?? null;
      this.entries.set(slug, { link, fetchedAt: t });
      this.evictIfLarge();
      return { link, degraded: false };
    } catch (err) {
      if (hit && hit.link && t - hit.fetchedAt < this.staleMs) return { link: hit.link, degraded: true };
      throw err;
    }
  }

  invalidate(slug: string): void {
    this.entries.delete(slug);
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
