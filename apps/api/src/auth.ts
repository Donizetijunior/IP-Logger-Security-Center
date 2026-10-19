import { hash, verify } from '@node-rs/argon2';
import { authenticator } from 'otplib';
import type { Pool } from '@ipl/database';
import {
  decryptSecret, encryptSecret, generateRecoveryCode, hashRecoveryCode, randomToken, safeEqual, sha256Hex,
} from './crypto.ts';

authenticator.options = { window: 1, step: 30, digits: 6 };

export const SESSION_TTL_MS = 8 * 3600_000;
export const SESSION_IDLE_MS = 2 * 3600_000;
export const CHALLENGE_TTL_MS = 5 * 60_000;
export const REAUTH_TTL_MS = 5 * 60_000;
const MAX_FAILED_LOGINS = 5;
const LOCK_MS = 15 * 60_000;
const MAX_CHALLENGE_ATTEMPTS = 5;

const ARGON_OPTS = { memoryCost: 19456, timeCost: 2, parallelism: 1 } as const;

// Hash fictício para equalizar o tempo quando o e-mail não existe
let dummyHash: Promise<string> | null = null;
function getDummyHash(): Promise<string> {
  dummyHash ??= hash('senha-fantasma-para-tempo-constante', ARGON_OPTS);
  return dummyHash;
}

export function hashPassword(password: string): Promise<string> {
  return hash(password, ARGON_OPTS);
}

export function validatePasswordStrength(password: string): string | null {
  if (password.length < 12) return 'A senha precisa ter ao menos 12 caracteres';
  if (password.length > 256) return 'Senha longa demais';
  const classes = [/[a-z]/, /[A-Z]/, /[0-9]/, /[^A-Za-z0-9]/].filter((r) => r.test(password)).length;
  if (classes < 3) return 'Use ao menos 3 entre: minúsculas, maiúsculas, números e símbolos';
  return null;
}

export interface AdminRow {
  id: string;
  email: string;
  password_hash: string;
  totp_secret_encrypted: string;
  totp_confirmed_at: Date | null;
  failed_logins: number;
  locked_until: Date | null;
  last_totp_step: number | null;
}

export type LoginResult =
  | { ok: true; challenge: string; mfaSetupPending: boolean }
  | { ok: false; reason: 'invalid_credentials' | 'locked' };

export class AuthService {
  private readonly pool: Pool;
  private readonly encKey: Buffer;

  constructor(pool: Pool, encKey: Buffer) {
    this.pool = pool;
    this.encKey = encKey;
  }

  async startLogin(email: string, password: string): Promise<LoginResult> {
    const { rows } = await this.pool.query<AdminRow>(
      'SELECT * FROM admins WHERE lower(email) = lower($1) AND is_active', [email],
    );
    const admin = rows[0];
    if (!admin) {
      await verify(await getDummyHash(), password).catch(() => false);
      return { ok: false, reason: 'invalid_credentials' };
    }
    if (admin.locked_until && admin.locked_until.getTime() > Date.now()) {
      return { ok: false, reason: 'locked' };
    }
    const good = await verify(admin.password_hash, password).catch(() => false);
    if (!good) {
      await this.registerFailure(admin.id);
      return { ok: false, reason: 'invalid_credentials' };
    }
    const token = randomToken();
    await this.pool.query(
      `INSERT INTO login_challenges (admin_id, token_hash, expires_at) VALUES ($1, $2, now() + ($3 || ' milliseconds')::interval)`,
      [admin.id, sha256Hex(token), String(CHALLENGE_TTL_MS)],
    );
    return { ok: true, challenge: token, mfaSetupPending: admin.totp_confirmed_at === null };
  }

  private async registerFailure(adminId: string): Promise<void> {
    await this.pool.query(
      `UPDATE admins SET
         locked_until = CASE WHEN failed_logins + 1 >= $2 THEN now() + ($3 || ' milliseconds')::interval ELSE locked_until END,
         failed_logins = CASE WHEN failed_logins + 1 >= $2 THEN 0 ELSE failed_logins + 1 END
       WHERE id = $1`,
      [adminId, MAX_FAILED_LOGINS, String(LOCK_MS)],
    );
  }

  /** Valida TOTP (ou código de recuperação) do desafio e cria a sessão. */
  async completeLogin(
    challengeToken: string, code: string,
  ): Promise<{ ok: true; sessionToken: string; csrfToken: string; adminId: string; email: string; usedRecovery: boolean } | { ok: false }> {
    const tokenHash = sha256Hex(challengeToken);
    const { rows } = await this.pool.query<{ id: string; admin_id: string; attempts: number }>(
      'SELECT id, admin_id, attempts FROM login_challenges WHERE token_hash = $1 AND expires_at > now()', [tokenHash],
    );
    const ch = rows[0];
    if (!ch) return { ok: false };
    if (ch.attempts >= MAX_CHALLENGE_ATTEMPTS) {
      await this.pool.query('DELETE FROM login_challenges WHERE id = $1', [ch.id]);
      return { ok: false };
    }
    await this.pool.query('UPDATE login_challenges SET attempts = attempts + 1 WHERE id = $1', [ch.id]);

    const { rows: ar } = await this.pool.query<AdminRow>('SELECT * FROM admins WHERE id = $1 AND is_active', [ch.admin_id]);
    const admin = ar[0];
    if (!admin) return { ok: false };

    let usedRecovery = false;
    const cleaned = code.trim();
    if (/^\d{6}$/.test(cleaned)) {
      if (!(await this.checkTotp(admin, cleaned))) return { ok: false };
    } else {
      const { rowCount } = await this.pool.query(
        'UPDATE admin_recovery_codes SET used_at = now() WHERE admin_id = $1 AND code_hash = $2 AND used_at IS NULL',
        [admin.id, hashRecoveryCode(cleaned)],
      );
      if (!rowCount) return { ok: false };
      usedRecovery = true;
    }

    await this.pool.query('DELETE FROM login_challenges WHERE admin_id = $1', [admin.id]);
    await this.pool.query(
      'UPDATE admins SET failed_logins = 0, locked_until = NULL, totp_confirmed_at = COALESCE(totp_confirmed_at, now()) WHERE id = $1',
      [admin.id],
    );
    const sessionToken = randomToken();
    const csrfToken = randomToken(24);
    await this.pool.query(
      `INSERT INTO admin_sessions (admin_id, token_hash, csrf_token, expires_at)
       VALUES ($1, $2, $3, now() + ($4 || ' milliseconds')::interval)`,
      [admin.id, sha256Hex(sessionToken), csrfToken, String(SESSION_TTL_MS)],
    );
    return { ok: true, sessionToken, csrfToken, adminId: admin.id, email: admin.email, usedRecovery };
  }

  /** TOTP com proteção contra replay (cada janela de 30 s só vale uma vez). */
  private async checkTotp(admin: AdminRow, code: string): Promise<boolean> {
    const secret = decryptSecret(admin.totp_secret_encrypted, this.encKey);
    const delta = authenticator.checkDelta(code, secret);
    if (delta === null) return false;
    const step = Math.floor(Date.now() / 30_000) + delta;
    const { rowCount } = await this.pool.query(
      'UPDATE admins SET last_totp_step = $2 WHERE id = $1 AND (last_totp_step IS NULL OR last_totp_step < $2)',
      [admin.id, step],
    );
    return rowCount === 1;
  }

  async findSession(sessionToken: string): Promise<SessionInfo | null> {
    const { rows } = await this.pool.query<{
      id: string; admin_id: string; email: string; csrf_token: string; reauth_at: Date | null; last_seen_at: Date;
    }>(
      `SELECT s.id, s.admin_id, a.email, s.csrf_token, s.reauth_at, s.last_seen_at
       FROM admin_sessions s JOIN admins a ON a.id = s.admin_id
       WHERE s.token_hash = $1 AND s.revoked_at IS NULL AND s.expires_at > now() AND a.is_active`,
      [sha256Hex(sessionToken)],
    );
    const r = rows[0];
    if (!r) return null;
    if (Date.now() - r.last_seen_at.getTime() > SESSION_IDLE_MS) {
      await this.revokeSession(r.id);
      return null;
    }
    if (Date.now() - r.last_seen_at.getTime() > 60_000) {
      await this.pool.query('UPDATE admin_sessions SET last_seen_at = now() WHERE id = $1', [r.id]);
    }
    return { id: r.id, adminId: r.admin_id, email: r.email, csrfToken: r.csrf_token, reauthAt: r.reauth_at };
  }

  async revokeSession(id: string): Promise<void> {
    await this.pool.query('UPDATE admin_sessions SET revoked_at = now() WHERE id = $1 AND revoked_at IS NULL', [id]);
  }

  async reauthenticate(session: SessionInfo, password: string): Promise<boolean> {
    const { rows } = await this.pool.query<{ password_hash: string }>('SELECT password_hash FROM admins WHERE id = $1', [session.adminId]);
    const ok = rows[0] ? await verify(rows[0].password_hash, password).catch(() => false) : false;
    if (ok) await this.pool.query('UPDATE admin_sessions SET reauth_at = now() WHERE id = $1', [session.id]);
    else await this.registerFailure(session.adminId);
    return ok;
  }

  static isRecentlyReauthenticated(session: SessionInfo): boolean {
    return !!session.reauthAt && Date.now() - session.reauthAt.getTime() < REAUTH_TTL_MS;
  }

  static csrfValid(session: SessionInfo, header: string | undefined): boolean {
    return !!header && safeEqual(header, session.csrfToken);
  }
}

export interface SessionInfo {
  id: string;
  adminId: string;
  email: string;
  csrfToken: string;
  reauthAt: Date | null;
}

export interface BootstrapResult {
  adminId: string;
  otpauthUri: string;
  totpSecret: string;
  recoveryCodes: string[];
}

/** Cria a única conta administrativa. Falha se já existir uma ativa. */
export async function bootstrapAdmin(pool: Pool, encKey: Buffer, email: string, password: string): Promise<BootstrapResult> {
  const weak = validatePasswordStrength(password);
  if (weak) throw new Error(weak);
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error('E-mail inválido');
  const { rows: existing } = await pool.query('SELECT 1 FROM admins WHERE is_active');
  if (existing.length > 0) throw new Error('Já existe um administrador ativo; o cadastro público/múltiplo não é permitido');

  const secret = authenticator.generateSecret(20);
  const passwordHash = await hashPassword(password);
  const { rows } = await pool.query<{ id: string }>(
    'INSERT INTO admins (email, password_hash, totp_secret_encrypted) VALUES ($1, $2, $3) RETURNING id',
    [email, passwordHash, encryptSecret(secret, encKey)],
  );
  const adminId = rows[0]!.id;
  const codes = Array.from({ length: 10 }, () => generateRecoveryCode());
  for (const c of codes) {
    await pool.query('INSERT INTO admin_recovery_codes (admin_id, code_hash) VALUES ($1, $2)', [adminId, hashRecoveryCode(c)]);
  }
  return {
    adminId,
    totpSecret: secret,
    otpauthUri: authenticator.keyuri(email, 'IP Logger Security Center', secret),
    recoveryCodes: codes,
  };
}
