import { createPool } from '@ipl/database';
import { loadConfig, parseEncryptionKey } from '@ipl/shared';
import { AuthService } from './auth.ts';
import type { Ctx } from './context.ts';
import { LinkCache } from './link-cache.ts';
import { DisabledRdapClient, HttpRdapClient } from './rdap.ts';
import { Telemetry } from './telemetry.ts';
import { GeoLookup } from './tools/geo.ts';
import { safeHop, type Hop } from './tools/safe-http.ts';

export function createContext(env: NodeJS.ProcessEnv = process.env, overrides: Partial<Pick<Ctx, 'rdap'>> & { hop?: Hop } = {}): Ctx {
  const config = loadConfig(env);
  const encKey = parseEncryptionKey(config.TOTP_ENCRYPTION_KEY);
  const pool = createPool(config.DATABASE_URL, { max: 15 });
  return {
    config,
    pool,
    encKey,
    telemetry: new Telemetry(),
    linkCache: new LinkCache(pool, config.LINK_CACHE_TTL_MS, config.LINK_CACHE_STALE_MS),
    auth: new AuthService(pool, encKey),
    rdap: overrides.rdap ?? (config.RDAP_ENABLED ? new HttpRdapClient() : new DisabledRdapClient()),
    geo: new GeoLookup(config.GEOIP_DIR, config.GEOLITE2_ENABLED),
    hop: overrides.hop ?? safeHop,
  };
}
