import type { Pool } from '@ipl/database';
import type { AppConfig } from '@ipl/shared';
import type { AuthService, SessionInfo } from './auth.ts';
import type { LinkCache } from './link-cache.ts';
import type { Telemetry } from './telemetry.ts';
import type { RdapClient } from './rdap.ts';

export interface Ctx {
  config: AppConfig;
  pool: Pool;
  telemetry: Telemetry;
  linkCache: LinkCache;
  auth: AuthService;
  rdap: RdapClient;
  encKey: Buffer;
}

declare module 'fastify' {
  interface FastifyRequest {
    clientIp: string | null;
    session: SessionInfo | null;
  }
}
