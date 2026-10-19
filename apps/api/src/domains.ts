import { createHash } from 'node:crypto';
import { Resolver } from 'node:dns/promises';
import type { Pool } from '@ipl/database';

export type DomainStatus = 'pending_dns' | 'pending_approval' | 'active' | 'disabled';

export interface DomainInfo {
  id: string;
  hostname: string;
  ownerId: string;
  status: DomainStatus;
  rootRedirectUrl: string | null;
  /** SHA-256 do token de verificação: é o que o endpoint de checagem de roteamento devolve (o token nunca sai do servidor). */
  challenge: string;
}

export const TXT_PREFIX = '_iplogger-challenge';
export const TXT_VALUE_PREFIX = 'iplogger-verify=';

export function stripPort(host: string): string {
  return host.toLowerCase().replace(/:\d+$/, '');
}

export function challengeFor(token: string): string {
  return createHash('sha256').update(`iplogger-domain:${token}`).digest('hex');
}

/** Consulta TXT usando resolvedores públicos (evita cache negativo do resolvedor local do contêiner). */
export type ResolveTxt = (name: string) => Promise<string[][]>;

export function defaultResolveTxt(): ResolveTxt {
  const resolver = new Resolver({ timeout: 4000, tries: 2 });
  resolver.setServers(['1.1.1.1', '8.8.8.8']);
  return (name) => resolver.resolveTxt(name);
}

/**
 * Registro em memória dos domínios (hostname → estado), atualizado do banco a cada poucos segundos e
 * imediatamente após mudanças administrativas. Em falha do banco mantém a última lista conhecida
 * (mesma política fail-open do cache de links).
 */
export class DomainRegistry {
  private map = new Map<string, DomainInfo>();
  private timer: NodeJS.Timeout | null = null;
  private readonly pool: Pool;
  private readonly refreshMs: number;

  constructor(pool: Pool, refreshMs = 15_000) {
    this.pool = pool;
    this.refreshMs = refreshMs;
  }

  /** Aceita "host" ou "host:porta" (a porta só existe em ambientes de desenvolvimento). */
  byHost(host: string | undefined): DomainInfo | undefined {
    if (!host) return undefined;
    return this.map.get(stripPort(host));
  }

  get size(): number {
    return this.map.size;
  }

  async refresh(): Promise<void> {
    try {
      const { rows } = await this.pool.query<{ id: string; hostname: string; owner_id: string; status: DomainStatus; root_redirect_url: string | null; verification_token: string }>(
        'SELECT id, hostname, owner_id, status, root_redirect_url, verification_token FROM custom_domains',
      );
      const next = new Map<string, DomainInfo>();
      for (const r of rows) {
        next.set(r.hostname.toLowerCase(), {
          id: r.id, hostname: r.hostname.toLowerCase(), ownerId: r.owner_id, status: r.status,
          rootRedirectUrl: r.root_redirect_url, challenge: challengeFor(r.verification_token),
        });
      }
      this.map = next;
    } catch {
      // banco indisponível: mantém a lista anterior
    }
  }

  start(): void {
    void this.refresh();
    this.timer = setInterval(() => void this.refresh(), this.refreshMs);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }
}
