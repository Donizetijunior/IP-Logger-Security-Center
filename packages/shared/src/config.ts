import { readFileSync } from 'node:fs';
import { z } from 'zod';

/** Lê VAR ou VAR_FILE (Docker secrets em /run/secrets). */
export function readEnvSecret(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const file = env[`${name}_FILE`];
  if (file) {
    try {
      return readFileSync(file, 'utf8').trim();
    } catch (err) {
      throw new Error(`Não foi possível ler ${name}_FILE (${file}): ${(err as Error).message}`);
    }
  }
  const v = env[name];
  return v === undefined || v === '' ? undefined : v;
}

const bool = z
  .union([z.boolean(), z.string()])
  .transform((v) => (typeof v === 'boolean' ? v : ['1', 'true', 'yes', 'on'].includes(v.toLowerCase())));

const int = (def: number) => z.coerce.number().int().default(def);

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PUBLIC_SHORT_BASE_URL: z.string().url().default('http://localhost:3000'),
  PUBLIC_DASHBOARD_URL: z.string().url().default('http://localhost:3000'),
  DATABASE_URL: z.string().min(1),
  REDIS_URL: z.string().min(1).default('redis://localhost:6379'),
  SESSION_SECRET: z.string().min(32, 'SESSION_SECRET precisa ter ao menos 32 caracteres'),
  TOTP_ENCRYPTION_KEY: z.string().min(32, 'TOTP_ENCRYPTION_KEY precisa de 32 bytes (64 hex ou base64)'),
  ABUSEIPDB_ENABLED: bool.default(false),
  ABUSEIPDB_API_KEY: z.string().optional(),
  ABUSEIPDB_DAILY_QUOTA: int(1000),
  GREYNOISE_ENABLED: bool.default(false),
  GREYNOISE_API_KEY: z.string().optional(),
  GREYNOISE_DAILY_QUOTA: int(50),
  GEOLITE2_ENABLED: bool.default(false),
  GEOIP_DIR: z.string().default('/geoip'),
  TOR_EXIT_LIST_ENABLED: bool.default(true),
  TOR_EXIT_LIST_URL: z.string().url().default('https://check.torproject.org/exit-addresses'),
  RDAP_ENABLED: bool.default(true),
  ANALYTICS_RETENTION_DAYS: int(30),
  TRUSTED_PROXY_CIDRS: z.string().default(''),
  EXPORT_TTL_MINUTES: int(30),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  ALLOWED_TARGET_DOMAINS: z.string().default(''),
  API_PORT: int(3000),
  /** Janela de gravação do evento no caminho do redirect (ms). Excedido => fail-open. */
  REDIRECT_DB_TIMEOUT_MS: int(400),
  /** Limite de requisições por IP/min na rota de redirect. Alto o bastante para NAT/CGNAT; protege só contra abuso extremo. */
  REDIRECT_RATE_LIMIT_PER_MIN: int(1200),
  LINK_CACHE_TTL_MS: int(30_000),
  LINK_CACHE_STALE_MS: int(3_600_000),
  RATE_ANOMALY_THRESHOLD: int(60),
  RATE_ANOMALY_WINDOW_MIN: int(10),
  MULTI_LINK_THRESHOLD: int(5),
  MULTI_LINK_WINDOW_MIN: int(15),
  SPIKE_MULTIPLIER: int(5),
  PROVIDER_CACHE_TTL_HOURS: int(24),
  PROVIDER_NEGATIVE_TTL_HOURS: int(6),
  AUDIT_RETENTION_DAYS: int(365),
  LEGAL_REVIEW_ACKNOWLEDGED: bool.default(false),
  COOKIE_SECURE: bool.optional(),
  /** open = cadastro livre; approval = exige aprovação do admin; closed = sem cadastro público. */
  SIGNUP_MODE: z.enum(['open', 'approval', 'closed']).default('approval'),
  DEFAULT_LINK_QUOTA: int(25),
  SIGNUP_RATE_PER_HOUR: int(5),
  OPEN_SOURCE_URL: z.string().default('https://github.com/Donizetijunior/IP-Logger-Security-Center'),
  PRIVACY_CONTROLLER_NAME: z.string().default('A DEFINIR PELO CONTROLADOR'),
  PRIVACY_CONTACT_EMAIL: z.string().default('A DEFINIR'),
});

export type AppConfig = z.infer<typeof schema> & {
  shortHost: string;
  dashboardHost: string;
  allowedDomains: string[];
  cookieSecure: boolean;
};

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const merged: Record<string, unknown> = { ...env };
  for (const k of ['DATABASE_URL', 'SESSION_SECRET', 'TOTP_ENCRYPTION_KEY', 'ABUSEIPDB_API_KEY', 'GREYNOISE_API_KEY']) {
    const v = readEnvSecret(env, k);
    if (v !== undefined) merged[k] = v;
  }
  // Variáveis definidas como vazias (ex.: COOKIE_SECURE= no Compose) equivalem a não definidas
  for (const k of Object.keys(merged)) if (merged[k] === '') delete merged[k];
  const parsed = schema.safeParse(merged);
  if (!parsed.success) {
    const msg = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new Error(`Configuração inválida: ${msg}`);
  }
  const c = parsed.data;
  if (c.NODE_ENV === 'production') {
    if (/CHANGE_ME/i.test(c.SESSION_SECRET) || /CHANGE_ME/i.test(c.TOTP_ENCRYPTION_KEY) || /CHANGE_ME/i.test(c.DATABASE_URL)) {
      throw new Error('Segredos com valor de exemplo (CHANGE_ME) não são aceitos em produção');
    }
    if (c.ANALYTICS_RETENTION_DAYS < 1) throw new Error('ANALYTICS_RETENTION_DAYS inválido');
    if (!c.LEGAL_REVIEW_ACKNOWLEDGED) {
      throw new Error(
        'Go-live bloqueado: registre a decisão jurídica sobre guarda de registros de acesso (Lei 12.965/2014, art. 15) e defina LEGAL_REVIEW_ACKNOWLEDGED=true',
      );
    }
  }
  return {
    ...c,
    shortHost: new URL(c.PUBLIC_SHORT_BASE_URL).host.toLowerCase(),
    dashboardHost: new URL(c.PUBLIC_DASHBOARD_URL).host.toLowerCase(),
    allowedDomains: c.ALLOWED_TARGET_DOMAINS.split(',').map((s) => s.trim()).filter(Boolean),
    cookieSecure: c.COOKIE_SECURE ?? c.NODE_ENV === 'production',
  };
}

/** Converte TOTP_ENCRYPTION_KEY (hex 64 ou base64 de 32 bytes) em Buffer de 32 bytes. */
export function parseEncryptionKey(raw: string): Buffer {
  if (/^[0-9a-fA-F]{64}$/.test(raw)) return Buffer.from(raw, 'hex');
  const b = Buffer.from(raw, 'base64');
  if (b.length === 32) return b;
  throw new Error('TOTP_ENCRYPTION_KEY deve ter 32 bytes (64 caracteres hex ou base64)');
}
