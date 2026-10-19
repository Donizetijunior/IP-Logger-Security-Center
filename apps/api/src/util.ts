export interface Cursor {
  t: string;
  id: string;
}

export function encodeCursor(c: Cursor): string {
  return Buffer.from(JSON.stringify(c)).toString('base64url');
}

export function decodeCursor(raw: string | undefined): Cursor | null {
  if (!raw) return null;
  try {
    const c = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')) as Cursor;
    if (typeof c.t !== 'string' || typeof c.id !== 'string') return null;
    if (Number.isNaN(Date.parse(c.t)) || !/^[0-9a-f-]{36}$/i.test(c.id)) return null;
    return c;
  } catch {
    return null;
  }
}

export class HttpError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

/** Timestamp ISO em microssegundos não sobrevive a Date; usa o texto cru retornado pelo banco. */
export function iso(d: Date | string | null | undefined): string | null {
  if (!d) return null;
  return d instanceof Date ? d.toISOString() : new Date(d).toISOString();
}

import type { FastifyRequest } from 'fastify';

/** null = administrador (vê tudo); caso contrário o id do dono cujos dados podem ser vistos. */
export function ownerScope(req: FastifyRequest): string | null {
  const s = req.session;
  if (!s) throw new HttpError(401, 'unauthenticated', 'Autenticação necessária');
  return s.role === 'admin' ? null : s.accountId;
}

export function requireAdmin(req: FastifyRequest): void {
  if (req.session?.role !== 'admin') throw new HttpError(403, 'forbidden', 'Acesso restrito ao administrador');
}
