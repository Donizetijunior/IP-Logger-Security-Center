import { existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { promises as dns } from 'node:dns';
import { open, type Reader, type CityResponse, type AsnResponse } from 'maxmind';
import type { Pool } from '@ipl/database';
import { sanitizeText } from '@ipl/shared';

export interface GeoResult {
  country: string | null;
  region: string | null;
  city: string | null;
  asn: number | null;
  asnOrg: string | null;
}

export const EMPTY_GEO: GeoResult = { country: null, region: null, city: null, asn: null, asnOrg: null };

/** Nomes aceitos, em ordem de preferência. Ambos usam o formato MMDB e o mesmo esquema de campos. */
export const CITY_FILES = ['GeoLite2-City.mmdb', 'dbip-city-lite.mmdb'];
export const ASN_FILES = ['GeoLite2-ASN.mmdb', 'dbip-asn-lite.mmdb'];

export function firstExisting(dir: string, names: string[]): string | null {
  for (const n of names) {
    const p = join(dir, n);
    if (existsSync(p)) return p;
  }
  return null;
}

/** Fonte e atribuição exigidas pela licença de cada base. */
export function describeSource(path: string | null): { source: string; attribution: string } | null {
  if (!path) return null;
  if (/GeoLite2/i.test(path)) {
    return { source: 'GeoLite2', attribution: 'Este produto inclui dados GeoLite2 criados pela MaxMind, disponíveis em https://www.maxmind.com' };
  }
  return { source: 'DB-IP Lite', attribution: 'IP Geolocation by DB-IP (https://db-ip.com), licença CC BY 4.0' };
}

/** Bases de geolocalização locais (City + ASN). Nunca chama serviços externos por acesso. */
export class GeoService {
  private city: Reader<CityResponse> | null = null;
  private asn: Reader<AsnResponse> | null = null;
  private cityMtime = 0;
  private asnMtime = 0;
  private cityPath: string | null = null;
  private readonly dir: string;
  private readonly enabled: boolean;

  constructor(dir: string, enabled: boolean) {
    this.dir = dir;
    this.enabled = enabled;
  }

  /** (Re)carrega as bases se mudaram. Mantém a base anterior se a nova for inválida. */
  async reload(pool?: Pool): Promise<void> {
    if (!this.enabled) {
      await this.report(pool, { state: 'disabled' });
      return;
    }
    const cityPath = firstExisting(this.dir, CITY_FILES);
    const asnPath = firstExisting(this.dir, ASN_FILES);
    let error: string | null = null;
    try {
      if (cityPath) {
        const m = statSync(cityPath).mtimeMs;
        if (m !== this.cityMtime || cityPath !== this.cityPath) {
          this.city = await open<CityResponse>(cityPath);
          this.cityMtime = m;
          this.cityPath = cityPath;
        }
      }
      if (asnPath) {
        const m = statSync(asnPath).mtimeMs;
        if (m !== this.asnMtime) {
          this.asn = await open<AsnResponse>(asnPath);
          this.asnMtime = m;
        }
      }
    } catch (err) {
      error = (err as Error).message.slice(0, 200);
    }
    const src = describeSource(this.cityPath ?? asnPath);
    await this.report(pool, {
      state: error ? 'error' : this.city || this.asn ? 'ready' : 'missing_databases',
      city: !!this.city,
      asn: !!this.asn,
      cityUpdatedAt: this.cityMtime ? new Date(this.cityMtime).toISOString() : null,
      asnUpdatedAt: this.asnMtime ? new Date(this.asnMtime).toISOString() : null,
      error,
      source: src?.source ?? null,
      attribution: src?.attribution ?? null,
    });
  }

  private async report(pool: Pool | undefined, value: Record<string, unknown>): Promise<void> {
    if (!pool) return;
    await pool.query(
      `INSERT INTO job_state (key, value, updated_at) VALUES ('geoip', $1, now())
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
      [JSON.stringify(value)],
    );
  }

  lookup(ip: string): GeoResult {
    const out: GeoResult = { ...EMPTY_GEO };
    try {
      const c = this.city?.get(ip);
      if (c) {
        out.country = c.country?.iso_code ?? null;
        out.region = sanitizeText(c.subdivisions?.[0]?.names?.en ?? c.subdivisions?.[0]?.iso_code ?? null, 100);
        out.city = sanitizeText(c.city?.names?.en ?? null, 100);
      }
      const a = this.asn?.get(ip);
      if (a) {
        out.asn = a.autonomous_system_number ?? null;
        out.asnOrg = sanitizeText(a.autonomous_system_organization ?? null, 200);
      }
    } catch {
      // IP fora da base: segue sem geolocalização
    }
    return out;
  }
}

/** DNS reverso com timeout; resultado é apenas contexto, não prova propriedade. */
export async function reverseDns(ip: string, timeoutMs = 2000): Promise<string | null> {
  try {
    const names = await Promise.race([
      dns.reverse(ip),
      new Promise<string[]>((_, reject) => setTimeout(() => reject(new Error('timeout')), timeoutMs).unref()),
    ]);
    return sanitizeText(names[0] ?? null, 253);
  } catch {
    return null;
  }
}
