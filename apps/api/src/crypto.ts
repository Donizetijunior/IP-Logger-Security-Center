import { createCipheriv, createDecipheriv, createHash, randomBytes, timingSafeEqual } from 'node:crypto';

export function sha256Hex(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

/** AES-256-GCM. Formato: base64(iv[12] | tag[16] | ciphertext). */
export function encryptSecret(plain: string, key: Buffer): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), ct]).toString('base64');
}

export function decryptSecret(payload: string, key: Buffer): string {
  const raw = Buffer.from(payload, 'base64');
  const iv = raw.subarray(0, 12);
  const tag = raw.subarray(12, 28);
  const ct = raw.subarray(28);
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
}

const RECOVERY_ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789';

/** Código de recuperação de uso único, ex.: "k3m9x-q7w2p". */
export function generateRecoveryCode(): string {
  const bytes = randomBytes(10);
  let out = '';
  for (let i = 0; i < 10; i++) {
    out += RECOVERY_ALPHABET[(bytes[i] ?? 0) % RECOVERY_ALPHABET.length];
    if (i === 4) out += '-';
  }
  return out;
}

export function normalizeRecoveryCode(input: string): string {
  return input.trim().toLowerCase().replace(/[^a-z0-9]/g, '');
}

export function hashRecoveryCode(code: string): string {
  return sha256Hex(`recovery:${normalizeRecoveryCode(code)}`);
}
