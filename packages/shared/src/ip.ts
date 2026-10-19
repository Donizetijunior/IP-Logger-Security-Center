import ipaddr from 'ipaddr.js';

export type ParsedIp = ipaddr.IPv4 | ipaddr.IPv6;

/** Parseia IPv4/IPv6 (sem colchetes, sem porta). Retorna null se inválido. */
export function parseIp(value: string | undefined | null): ParsedIp | null {
  if (!value) return null;
  const v = value.trim();
  if (v.length === 0 || v.length > 45) return null;
  if (!ipaddr.isValid(v)) return null;
  try {
    const parsed = ipaddr.parse(v);
    if (parsed.kind() === 'ipv6' && (parsed as ipaddr.IPv6).isIPv4MappedAddress()) {
      return (parsed as ipaddr.IPv6).toIPv4Address();
    }
    return parsed;
  } catch {
    return null;
  }
}

/** Forma canônica (IPv4-mapped vira IPv4). Null se inválido. */
export function normalizeIp(value: string | undefined | null): string | null {
  const p = parseIp(value);
  return p ? p.toString() : null;
}

/**
 * Apenas endereços globalmente roteáveis (unicast) podem ser enviados a provedores públicos.
 * Loopback, RFC1918, CGNAT, link-local, multicast, documentação (192.0.2/24, 198.51.100/24,
 * 203.0.113/24, 2001:db8::/32) e demais reservados retornam false.
 */
export function isPublicIp(value: string | undefined | null): boolean {
  const p = parseIp(value);
  if (!p) return false;
  return p.range() === 'unicast';
}

export function isIpv4(value: string): boolean {
  return parseIp(value)?.kind() === 'ipv4';
}

export function parseCidrs(list: string | string[] | undefined): Array<[ParsedIp, number]> {
  const items = Array.isArray(list) ? list : (list ?? '').split(',');
  const out: Array<[ParsedIp, number]> = [];
  for (const raw of items) {
    const s = raw.trim();
    if (!s) continue;
    try {
      if (s.includes('/')) {
        const [addr, bits] = ipaddr.parseCIDR(s);
        out.push([addr, bits]);
      } else {
        const a = parseIp(s);
        if (!a) throw new Error('invalid');
        out.push([a, a.kind() === 'ipv4' ? 32 : 128]);
      }
    } catch {
      throw new Error(`CIDR/IP inválido em TRUSTED_PROXY_CIDRS: ${s}`);
    }
  }
  return out;
}

export function ipInCidrs(ip: ParsedIp, cidrs: Array<[ParsedIp, number]>): boolean {
  for (const [net, bits] of cidrs) {
    if (net.kind() !== ip.kind()) continue;
    if ((ip as ipaddr.IPv4).match(net as ipaddr.IPv4, bits)) return true;
  }
  return false;
}

/**
 * Resolve o IP real do cliente. X-Forwarded-For só é considerado quando a conexão TCP vem de um
 * proxy explicitamente confiável. A cadeia é percorrida da direita para a esquerda ignorando
 * saltos confiáveis; o primeiro salto não confiável é o cliente. Valores forjados à esquerda
 * (enviados pelo visitante) nunca são usados.
 */
export function resolveClientIp(params: {
  socketIp: string | undefined;
  forwardedFor: string | string[] | undefined;
  trusted: Array<[ParsedIp, number]>;
}): string | null {
  const socket = parseIp(params.socketIp);
  if (!socket) return null;
  if (!ipInCidrs(socket, params.trusted)) return socket.toString();

  const header = Array.isArray(params.forwardedFor) ? params.forwardedFor.join(',') : params.forwardedFor;
  if (!header) return socket.toString();
  const hops = header.split(',').map((h) => h.trim()).filter(Boolean);
  for (let i = hops.length - 1; i >= 0; i--) {
    const hop = parseIp(hops[i]);
    if (!hop) return socket.toString(); // cadeia malformada: não confiar
    if (!ipInCidrs(hop, params.trusted)) return hop.toString();
  }
  return socket.toString();
}
