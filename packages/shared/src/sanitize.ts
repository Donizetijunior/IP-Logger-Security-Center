const CONTROL_CHARS = new RegExp('[\u0000-\u001f\u007f-\u009f]+', 'g');

/** Remove caracteres de controle (inclui CR/LF), colapsa espaços e trunca. Evita log injection. */
export function sanitizeText(value: unknown, maxLen: number): string | null {
  if (typeof value !== 'string') return null;
  const cleaned = value.replace(CONTROL_CHARS, ' ').replace(/\s+/g, ' ').trim();
  if (!cleaned) return null;
  return cleaned.length > maxLen ? cleaned.slice(0, maxLen) : cleaned;
}

/** Guarda apenas origem (esquema+host+porta) do Referer; nunca path, query ou fragmento. */
export function sanitizeReferer(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > 2048) return null;
  try {
    const u = new URL(value);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    return sanitizeText(u.origin, 255);
  } catch {
    return null;
  }
}

export function sanitizeAcceptLanguage(value: unknown): string | null {
  return sanitizeText(value, 100);
}

export function sanitizeUserAgent(value: unknown): string | null {
  return sanitizeText(value, 512);
}

/** Máscara de IP para exportações: IPv4 /24, IPv6 /48. */
export function maskIp(ip: string): string {
  if (ip.includes(':')) {
    const parts = ip.split(':').slice(0, 3);
    return `${parts.join(':')}::/48`;
  }
  const o = ip.split('.');
  return `${o[0]}.${o[1]}.${o[2]}.0/24`;
}
