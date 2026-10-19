import { SafeHttpError, safeHop, type Hop } from './safe-http.ts';

export interface UrlHopInfo {
  url: string;
  status: number | null;
  location: string | null;
  ms: number | null;
  tls: boolean;
  server: string | null;
  contentType: string | null;
  error?: { code: string; message: string };
}

export interface UrlCheckResult {
  startUrl: string;
  hops: UrlHopInfo[];
  finalUrl: string | null;
  finalStatus: number | null;
  redirects: number;
  warnings: string[];
  error?: { code: string; message: string };
}

export function normalizeInputUrl(input: string): string {
  const t = input.trim();
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(t) ? t : `https://${t}`;
}

/**
 * Verificador de URL: segue a cadeia de redirecionamentos SEM baixar conteúdo, validando cada salto
 * (esquema http/https, portas 80/443, DNS que só resolve para IPs públicos). Não executa JavaScript.
 */
export async function checkUrl(
  input: string,
  opts: { hop?: Hop; maxHops?: number; ownHosts?: string[] } = {},
): Promise<UrlCheckResult> {
  const hop = opts.hop ?? safeHop;
  const maxHops = opts.maxHops ?? 8;
  const start = normalizeInputUrl(input);
  const result: UrlCheckResult = { startUrl: start, hops: [], finalUrl: null, finalStatus: null, redirects: 0, warnings: [] };
  const seen = new Set<string>();
  let current = start;
  let exhausted = true;

  for (let i = 0; i < maxHops; i++) {
    if (seen.has(current)) {
      result.error = { code: 'redirect_loop', message: 'Laço de redirecionamento detectado' };
      exhausted = false;
      break;
    }
    seen.add(current);
    const info: UrlHopInfo = { url: current, status: null, location: null, ms: null, tls: false, server: null, contentType: null };
    result.hops.push(info);
    try {
      let r = await hop(current, { method: 'HEAD', timeoutMs: 5000 });
      // Alguns servidores não aceitam HEAD: repete com GET (apenas cabeçalhos)
      if ([400, 403, 405, 501].includes(r.status)) r = await hop(current, { method: 'GET', timeoutMs: 5000 });
      info.status = r.status;
      info.ms = r.ms;
      info.tls = r.tls;
      info.server = r.headers.server ?? null;
      info.contentType = r.headers['content-type'] ?? null;
      info.location = r.headers.location ?? null;
      result.finalUrl = current;
      result.finalStatus = r.status;
      if (r.status >= 300 && r.status < 400 && r.headers.location) {
        const next = new URL(r.headers.location, current).toString();
        if (current.startsWith('https://') && next.startsWith('http://')) result.warnings.push(`Rebaixamento de HTTPS para HTTP no salto ${i + 1}`);
        result.redirects += 1;
        current = next;
        continue;
      }
      exhausted = false;
      break;
    } catch (err) {
      const e = err instanceof SafeHttpError ? err : new SafeHttpError('network_error', 'Falha de rede');
      info.error = { code: e.code, message: e.message };
      result.error = { code: e.code, message: e.message };
      exhausted = false;
      break;
    }
  }
  if (exhausted && !result.error) result.error = { code: 'too_many_redirects', message: `Mais de ${maxHops} redirecionamentos` };

  const hosts = result.hops.map((h) => {
    try {
      return new URL(h.url).hostname;
    } catch {
      return '';
    }
  });
  const distinct = [...new Set(hosts.filter(Boolean))];
  if (distinct.length > 1) result.warnings.push(`A cadeia passa por ${distinct.length} domínios: ${distinct.join(' → ')}`);
  if (result.redirects >= 4) result.warnings.push(`Cadeia longa (${result.redirects} redirecionamentos)`);
  if (opts.ownHosts && hosts.some((h) => opts.ownHosts!.includes(h))) result.warnings.push('Inclui um link encurtado desta plataforma (os acessos a ele são registrados)');
  if (result.finalStatus !== null && result.finalStatus >= 400) result.warnings.push(`O destino final respondeu HTTP ${result.finalStatus}`);
  return result;
}
