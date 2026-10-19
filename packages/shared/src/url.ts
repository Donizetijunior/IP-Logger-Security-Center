import { parseIp } from './ip.ts';

export interface TargetUrlResult {
  ok: boolean;
  url?: string;
  reason?: string;
}

/**
 * Valida destino de redirecionamento apenas por parsing (nunca busca o destino: sem SSRF).
 * Aceita http/https, rejeita credenciais embutidas, hosts numéricos privados/loopback e localhost.
 * allowedDomains (opcional): se não vazio, o host deve ser igual ou subdomínio de um domínio da lista.
 */
export function validateTargetUrl(input: string, allowedDomains: string[] = []): TargetUrlResult {
  if (typeof input !== 'string' || input.length === 0 || input.length > 2048) {
    return { ok: false, reason: 'URL vazia ou longa demais' };
  }
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f\s]/.test(input)) return { ok: false, reason: 'URL contém caracteres inválidos' };
  let u: URL;
  try {
    u = new URL(input);
  } catch {
    return { ok: false, reason: 'URL inválida' };
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return { ok: false, reason: 'Esquema não permitido' };
  if (u.username || u.password) return { ok: false, reason: 'Credenciais na URL não são permitidas' };
  const host = u.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (!host) return { ok: false, reason: 'Host ausente' };
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal')) {
    return { ok: false, reason: 'Host local não permitido' };
  }
  // WHATWG URL já normaliza decimal/octal/hex para IPv4 pontuado; o que sobra é IP ou domínio.
  const ip = parseIp(host);
  if (ip && ip.range() !== 'unicast') return { ok: false, reason: 'IP privado/reservado não permitido' };
  if (allowedDomains.length > 0) {
    const ok = allowedDomains.some((d) => {
      const dd = d.toLowerCase().trim();
      return host === dd || host.endsWith(`.${dd}`);
    });
    if (!ok) return { ok: false, reason: 'Domínio fora da lista permitida' };
  }
  return { ok: true, url: u.toString() };
}
