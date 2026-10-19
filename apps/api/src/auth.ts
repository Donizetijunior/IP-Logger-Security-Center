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

export const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export type Role = 'admin' | 'user';
export type AccountStatus = 'active' | 'pending' | 'suspended';

export interface AccountRow {
  id: string;
  email: string;
  password_hash: string;
  totp_secret_encrypted: string | null;
  totp_confirmed_at: Date | null;
  failed_logins: number;
  locked_until: Date | null;
  last_totp_step: number | null;
  role: Role;
  status: AccountStatus;
  link_quota: number;
  must_change_password: boolean;
}

export interface SessionInfo {
  id: string;
  accountId: string;
  email: string;
  role: Role;
  mustChangePassword: boolean;
  linkQuota: number;
  csrfToken: string;
  reauthAt: Date | null;
}

export interface CreatedSession {
  sessionToken: string;
  csrfToken: string;
  accountId: string;
  email: string;
  role: Role;
  mustChangePassword: boolean;
}

export type LoginResult =
  | { ok: true; mfaRequired: true; challenge: string; mfaSetupPending: boolean }
  | { ok: true; mfaRequired: false; session: CreatedSession }
  | { ok: false; reason: 'invalid_credentials' | 'locked' | 'pending' | 'suspended' };

export class AuthService {
  private readonly pool: Pool;
  private readonly encKey: Buffer;

  constructor(pool: Pool, encKey: Buffer) {
    this.pool = pool;
    this.encKey = encKey;
  }

  async startLogin(email: string, password: string): Promise<LoginResult> {
    const { rows } = await this.pool.query<AccountRow>('SELECT * FROM accounts WHERE lower(email) = lower($1)', [email]);
    const account = rows[0];
    if (!account) {
      await verify(await getDummyHash(), password).catch(() => false);
      return { ok: false, reason: 'invalid_credentials' };
    }
    if (account.locked_until && account.locked_until.getTime() > Date.now()) {
      return { ok: false, reason: 'locked' };
    }
    const good = await verify(account.password_hash, password).catch(() => false);
    if (!good) {
      await this.registerFailure(account.id);
      return { ok: false, reason: 'invalid_credentials' };
    }
    // Estado da conta só é revelado depois de a senha estar correta (sem enumeração de contas)
    if (account.status === 'pending') return { ok: false, reason: 'pending' };
    if (account.status === 'suspended') return { ok: false, reason: 'suspended' };

    if (!account.totp_secret_encrypted) {
      await this.pool.query('UPDATE accounts SET failed_logins = 0, locked_until = NULL WHERE id = $1', [account.id]);
      return { ok: true, mfaRequired: false, session: await this.createSession(account) };
    }
    const token = randomToken();
    await this.pool.query(
      `INSERT INTO login_challenges (account_id, token_hash, expires_at) VALUES ($1, $2, now() + ($3 || ' milliseconds')::interval)`,
      [account.id, sha256Hex(token), String(CHALLENGE_TTL_MS)],
    );
    return { ok: true, mfaRequired: true, challenge: token, mfaSetupPending: account.totp_confirmed_at === null };
  }

  private async registerFailure(accountId: string): Promise<void> {
    await this.pool.query(
      `UPDATE accounts SET
         locked_until = CASE WHEN failed_logins + 1 >= $2 THEN now() + ($3 || ' milliseconds')::interval ELSE locked_until END,
         failed_logins = CASE WHEN failed_logins + 1 >= $2 THEN 0 ELSE failed_logins + 1 END
       WHERE id = $1`,
      [accountId, MAX_FAILED_LOGINS, String(LOCK_MS)],
    );
  }

  async createSession(account: Pick<AccountRow, 'id' | 'email' | 'role' | 'must_change_password'>): Promise<CreatedSession> {
    const sessionToken = randomToken();
    const csrfToken = randomToken(24);
    await this.pool.query(
      `INSERT INTO admin_sessions (account_id, token_hash, csrf_token, expires_at)
       VALUES ($1, $2, $3, now() + ($4 || ' milliseconds')::interval)`,
      [account.id, sha256Hex(sessionToken), csrfToken, String(SESSION_TTL_MS)],
    );
    return {
      sessionToken, csrfToken, accountId: account.id, email: account.email, role: account.role, mustChangePassword: account.must_change_password,
    };
  }

  /** Valida TOTP (ou código de recuperação) do desafio e cria a sessão. */
  async completeLogin(
    challengeToken: string, code: string,
  ): Promise<{ ok: true; session: CreatedSession; usedRecovery: boolean } | { ok: false }> {
    const tokenHash = sha256Hex(challengeToken);
    const { rows } = await this.pool.query<{ id: string; account_id: string; attempts: number }>(
      'SELECT id, account_id, attempts FROM login_challenges WHERE token_hash = $1 AND expires_at > now()', [tokenHash],
    );
    const ch = rows[0];
    if (!ch) return { ok: false };
    if (ch.attempts >= MAX_CHALLENGE_ATTEMPTS) {
      await this.pool.query('DELETE FROM login_challenges WHERE id = $1', [ch.id]);
      return { ok: false };
    }
    await this.pool.query('UPDATE login_challenges SET attempts = attempts + 1 WHERE id = $1', [ch.id]);

    const { rows: ar } = await this.pool.query<AccountRow>("SELECT * FROM accounts WHERE id = $1 AND status = 'active'", [ch.account_id]);
    const account = ar[0];
    if (!account || !account.totp_secret_encrypted) return { ok: false };

    let usedRecovery = false;
    const cleaned = code.trim();
    if (/^\d{6}$/.test(cleaned)) {
      if (!(await this.checkTotp(account, cleaned))) return { ok: false };
    } else {
      const { rowCount } = await this.pool.query(
        'UPDATE admin_recovery_codes SET used_at = now() WHERE account_id = $1 AND code_hash = $2 AND used_at IS NULL',
        [account.id, hashRecoveryCode(cleaned)],
      );
      if (!rowCount) return { ok: false };
      usedRecovery = true;
    }

    await this.pool.query('DELETE FROM login_challenges WHERE account_id = $1', [account.id]);
    await this.pool.query(
      'UPDATE accounts SET failed_logins = 0, locked_until = NULL, totp_confirmed_at = COALESCE(totp_confirmed_at, now()) WHERE id = $1',
      [account.id],
    );
    return { ok: true, session: await this.createSession(account), usedRecovery };
  }

  /** TOTP com proteção contra replay (cada janela de 30 s só vale uma vez). */
  private async checkTotp(account: AccountRow, code: string): Promise<boolean> {
    const secret = decryptSecret(account.totp_secret_encrypted!, this.encKey);
    const delta = authenticator.checkDelta(code, secret);
    if (delta === null) return false;
    const step = Math.floor(Date.now() / 30_000) + delta;
    const { rowCount } = await this.pool.query(
      'UPDATE accounts SET last_totp_step = $2 WHERE id = $1 AND (last_totp_step IS NULL OR last_totp_step < $2)',
      [account.id, step],
    );
    return rowCount === 1;
  }

  async findSession(sessionToken: string): Promise<SessionInfo | null> {
    const { rows } = await this.pool.query<{
      id: string; account_id: string; email: string; role: Role; must_change_password: boolean; link_quota: number;
      csrf_token: string; reauth_at: Date | null; last_seen_at: Date;
    }>(
      `SELECT s.id, s.account_id, a.email, a.role, a.must_change_password, a.link_quota, s.csrf_token, s.reauth_at, s.last_seen_at
       FROM admin_sessions s JOIN accounts a ON a.id = s.account_id
       WHERE s.token_hash = $1 AND s.revoked_at IS NULL AND s.expires_at > now() AND a.status = 'active'`,
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
    return {
      id: r.id, accountId: r.account_id, email: r.email, role: r.role, mustChangePassword: r.must_change_password,
      linkQuota: r.link_quota, csrfToken: r.csrf_token, reauthAt: r.reauth_at,
    };
  }

  async revokeSession(id: string): Promise<void> {
    await this.pool.query('UPDATE admin_sessions SET revoked_at = now() WHERE id = $1 AND revoked_at IS NULL', [id]);
  }

  async revokeAllSessions(accountId: string, exceptSessionId?: string): Promise<void> {
    await this.pool.query(
      'UPDATE admin_sessions SET revoked_at = now() WHERE account_id = $1 AND revoked_at IS NULL AND ($2::uuid IS NULL OR id <> $2)',
      [accountId, exceptSessionId ?? null],
    );
  }

  async reauthenticate(session: SessionInfo, password: string): Promise<boolean> {
    const { rows } = await this.pool.query<{ password_hash: string }>('SELECT password_hash FROM accounts WHERE id = $1', [session.accountId]);
    const ok = rows[0] ? await verify(rows[0].password_hash, password).catch(() => false) : false;
    if (ok) await this.pool.query('UPDATE admin_sessions SET reauth_at = now() WHERE id = $1', [session.id]);
    else await this.registerFailure(session.accountId);
    return ok;
  }

  /** Troca de senha: confere a atual, aplica a política e encerra as demais sessões. */
  async changePassword(session: SessionInfo, current: string, next: string): Promise<'ok' | 'wrong_current' | { weak: string }> {
    const { rows } = await this.pool.query<{ password_hash: string }>('SELECT password_hash FROM accounts WHERE id = $1', [session.accountId]);
    const ok = rows[0] ? await verify(rows[0].password_hash, current).catch(() => false) : false;
    if (!ok) {
      await this.registerFailure(session.accountId);
      return 'wrong_current';
    }
    const weak = validatePasswordStrength(next);
    if (weak) return { weak };
    await this.pool.query('UPDATE accounts SET password_hash = $2, must_change_password = false WHERE id = $1', [session.accountId, await hashPassword(next)]);
    await this.revokeAllSessions(session.accountId, session.id);
    return 'ok';
  }

  static isRecentlyReauthenticated(session: SessionInfo): boolean {
    return !!session.reauthAt && Date.now() - session.reauthAt.getTime() < REAUTH_TTL_MS;
  }

  static csrfValid(session: SessionInfo, header: string | undefined): boolean {
    return !!header && safeEqual(header, session.csrfToken);
  }
}

export interface BootstrapResult {
  accountId: string;
  otpauthUri: string;
  totpSecret: string;
  recoveryCodes: string[];
}

/** Cria a única conta administradora (com MFA obrigatório). Falha se já existir. */
export async function bootstrapAdmin(pool: Pool, encKey: Buffer, email: string, password: string): Promise<BootstrapResult> {
  const weak = validatePasswordStrength(password);
  if (weak) throw new Error(weak);
  if (!EMAIL_REGEX.test(email)) throw new Error('E-mail inválido');
  const { rows: existing } = await pool.query("SELECT 1 FROM accounts WHERE role = 'admin'");
  if (existing.length > 0) throw new Error('Já existe um administrador; use o painel para criar usuários comuns');

  const secret = authenticator.generateSecret(20);
  const passwordHash = await hashPassword(password);
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO accounts (email, password_hash, totp_secret_encrypted, role, status, terms_accepted_at, link_quota, signup_source)
     VALUES ($1, $2, $3, 'admin', 'active', now(), 1000000, 'cli') RETURNING id`,
    [email, passwordHash, encryptSecret(secret, encKey)],
  );
  const accountId = rows[0]!.id;
  const codes = Array.from({ length: 10 }, () => generateRecoveryCode());
  for (const c of codes) {
    await pool.query('INSERT INTO admin_recovery_codes (account_id, code_hash) VALUES ($1, $2)', [accountId, hashRecoveryCode(c)]);
  }
  return {
    accountId,
    totpSecret: secret,
    otpauthUri: authenticator.keyuri(email, 'IP Logger Security Center', secret),
    recoveryCodes: codes,
  };
}
