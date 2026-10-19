import type { Pool } from '@ipl/database';
import type { AppConfig } from '@ipl/shared';
import type { AuthService, SessionInfo } from './auth.ts';
import type { LinkCache } from './link-cache.ts';
import type { Telemetry } from './telemetry.ts';
import type { RdapClient } from './rdap.ts';
import type { GeoLookup } from './tools/geo.ts';
import type { Hop } from './tools/safe-http.ts';
import type { DomainRegistry, ResolveTxt } from './domains.ts';

export interface Ctx {
  config: AppConfig;
  pool: Pool;
  telemetry: Telemetry;
  linkCache: LinkCache;
  auth: AuthService;
  rdap: RdapClient;
  geo: GeoLookup;
  domains: DomainRegistry;
  /** Consulta de TXT para verificar a propriedade de domínios; substituível em testes. */
  resolveTxt: ResolveTxt;
  /** Transporte HTTP seguro (anti-SSRF) usado pelas ferramentas; substituível em testes. */
  hop: Hop;
  encKey: Buffer;
}

declare module 'fastify' {
  interface FastifyRequest {
    clientIp: string | null;
    session: SessionInfo | null;
  }
}
