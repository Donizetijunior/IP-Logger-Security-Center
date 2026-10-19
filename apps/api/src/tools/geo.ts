import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { open, type AsnResponse, type CityResponse, type Reader } from 'maxmind';
import { sanitizeText } from '@ipl/shared';

export interface GeoInfo {
  available: boolean;
  country: string | null;
  region: string | null;
  city: string | null;
  asn: number | null;
  asnOrg: string | null;
}

const CITY_FILES = ['GeoLite2-City.mmdb', 'dbip-city-lite.mmdb'];
const ASN_FILES = ['GeoLite2-ASN.mmdb', 'dbip-asn-lite.mmdb'];

function firstExisting(dir: string, names: string[]): string | null {
  for (const n of names) {
    const p = join(dir, n);
    if (existsSync(p)) return p;
  }
  return null;
}

/** Consulta às bases locais (GeoLite2 ou DB-IP Lite), somente leitura. Sem bases ⇒ available=false. */
export class GeoLookup {
  private city: Reader<CityResponse> | null = null;
  private asn: Reader<AsnResponse> | null = null;
  private loaded = false;
  private readonly dir: string;
  private readonly enabled: boolean;

  constructor(dir: string, enabled: boolean) {
    this.dir = dir;
    this.enabled = enabled;
  }

  private async init(): Promise<void> {
    if (this.loaded) return;
    this.loaded = true;
    if (!this.enabled) return;
    try {
      const c = firstExisting(this.dir, CITY_FILES);
      const a = firstExisting(this.dir, ASN_FILES);
      if (c) this.city = await open<CityResponse>(c);
      if (a) this.asn = await open<AsnResponse>(a);
    } catch {
      // bases ilegíveis: segue sem geolocalização
    }
  }

  async lookup(ip: string): Promise<GeoInfo> {
    await this.init();
    const out: GeoInfo = { available: !!(this.city || this.asn), country: null, region: null, city: null, asn: null, asnOrg: null };
    try {
      const c = this.city?.get(ip);
      if (c) {
        out.country = c.country?.iso_code ?? null;
        out.region = sanitizeText(c.subdivisions?.[0]?.names?.en ?? null, 100);
        out.city = sanitizeText(c.city?.names?.en ?? null, 100);
      }
      const a = this.asn?.get(ip);
      if (a) {
        out.asn = a.autonomous_system_number ?? null;
        out.asnOrg = sanitizeText(a.autonomous_system_organization ?? null, 200);
      }
    } catch {
      // IP fora da base
    }
    return out;
  }
}
