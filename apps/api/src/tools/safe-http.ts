import dns from 'node:dns';
import http from 'node:http';
import https from 'node:https';
import { isPublicIp, validateTargetUrl } from '@ipl/shared';

export class SafeHttpError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

export interface HopResult {
  status: number;
  headers: Record<string, string>;
  body: Buffer | null;
  ms: number;
  tls: boolean;
}

export interface HopOptions {
  method?: 'HEAD' | 'GET';
  timeoutMs?: number;
  /** 0 = não lê o corpo (apenas cabeçalhos). */
  maxBodyBytes?: number;
  accept?: string;
  /** Portas permitidas (padrão 80 e 443): impede usar o servidor como varredor de portas. */
  allowedPorts?: number[];
}

export type Hop = (url: string, opts?: HopOptions) => Promise<HopResult>;

/**
 * DNS "com trava": resolve e só entrega à conexão endereços PÚBLICOS. Como a verificação acontece no
 * momento da conexão (e não antes), não há janela para DNS rebinding. Se QUALQUER resposta for
 * privada/reservada, o destino inteiro é recusado.
 */
export function guardedLookup(
  hostname: string,
  options: dns.LookupOptions,
  callback: (err: NodeJS.ErrnoException | null, address?: string | dns.LookupAddress[], family?: number) => void,
): void {
  dns.lookup(hostname, { all: true, verbatim: true }, (err, addrs) => {
    if (err) return callback(err);
    if (addrs.length === 0 || addrs.some((a) => !isPublicIp(a.address))) {
      const e: NodeJS.ErrnoException = new Error('Endereço de destino não permitido');
      e.code = 'EBLOCKED';
      return callback(e);
    }
    if (options.all) return callback(null, addrs);
    return callback(null, addrs[0]!.address, addrs[0]!.family);
  });
}

/** Uma única requisição (sem seguir redirecionamentos) com todas as proteções anti-SSRF. */
export function safeHop(rawUrl: string, opts: HopOptions = {}): Promise<HopResult> {
  const check = validateTargetUrl(rawUrl);
  if (!check.ok || !check.url) return Promise.reject(new SafeHttpError('blocked_url', check.reason ?? 'URL não permitida'));
  const url = new URL(check.url);
  const port = url.port ? Number(url.port) : url.protocol === 'https:' ? 443 : 80;
  if (!(opts.allowedPorts ?? [80, 443]).includes(port)) {
    return Promise.reject(new SafeHttpError('blocked_port', `Porta ${port} não permitida (use 80 ou 443)`));
  }
  const lib = url.protocol === 'https:' ? https : http;
  const started = performance.now();
  const timeoutMs = opts.timeoutMs ?? 5000;
  const cap = opts.maxBodyBytes ?? 0;

  return new Promise<HopResult>((resolve, reject) => {
    const req = lib.request(
      url,
      {
        method: opts.method ?? 'HEAD',
        lookup: guardedLookup as never,
        timeout: timeoutMs,
        maxHeaderSize: 16 * 1024,
        headers: {
          'user-agent': 'iplogger-url-check/1.0 (+verificação de segurança)',
          accept: opts.accept ?? '*/*',
          'accept-encoding': 'identity',
        },
      },
      (res) => {
        const headers: Record<string, string> = {};
        for (const [k, v] of Object.entries(res.headers)) if (typeof v === 'string') headers[k] = v.slice(0, 512);
        const finish = (body: Buffer | null) => resolve({ status: res.statusCode ?? 0, headers, body, ms: Math.round(performance.now() - started), tls: url.protocol === 'https:' });
        if (cap === 0) {
          res.destroy();
          finish(null);
          return;
        }
        const chunks: Buffer[] = [];
        let size = 0;
        res.on('data', (c: Buffer) => {
          size += c.length;
          if (size > cap) {
            res.destroy();
            reject(new SafeHttpError('too_large', 'Resposta grande demais'));
            return;
          }
          chunks.push(c);
        });
        res.on('end', () => finish(Buffer.concat(chunks)));
        res.on('error', () => undefined);
      },
    );
    req.on('timeout', () => req.destroy(new SafeHttpError('timeout', 'Tempo esgotado')));
    req.on('error', (err: NodeJS.ErrnoException | SafeHttpError) => {
      if (err instanceof SafeHttpError) return reject(err);
      if (err.code === 'EBLOCKED') return reject(new SafeHttpError('blocked_address', 'O endereço de destino resolve para uma rede privada ou reservada'));
      if (err.code === 'ENOTFOUND' || err.code === 'EAI_AGAIN') return reject(new SafeHttpError('dns_error', 'Domínio não encontrado'));
      if (err.code === 'ECONNREFUSED' || err.code === 'ECONNRESET' || err.code === 'EHOSTUNREACH') return reject(new SafeHttpError('connect_error', 'Não foi possível conectar'));
      if (/certificate|SSL|TLS|self.signed|ERR_TLS/i.test(`${err.code} ${err.message}`)) return reject(new SafeHttpError('tls_error', 'Falha na validação do certificado TLS'));
      return reject(new SafeHttpError('network_error', 'Falha de rede'));
    });
    req.end();
  });
}

/** Segue redirecionamentos validando CADA salto (HTTPS obrigatório em RDAP, por exemplo). */
export async function safeFetchJson(
  rawUrl: string,
  opts: { hop?: Hop; maxRedirects?: number; httpsOnly?: boolean } = {},
): Promise<unknown | null> {
  const hop = opts.hop ?? safeHop;
  let current = rawUrl;
  for (let i = 0; i <= (opts.maxRedirects ?? 3); i++) {
    if (opts.httpsOnly !== false && !current.startsWith('https://')) throw new SafeHttpError('blocked_url', 'Somente HTTPS');
    const r = await hop(current, { method: 'GET', maxBodyBytes: 256 * 1024, accept: 'application/rdap+json, application/json', timeoutMs: 6000 });
    if (r.status >= 300 && r.status < 400 && r.headers.location) {
      current = new URL(r.headers.location, current).toString();
      continue;
    }
    if (r.status !== 200 || !r.body) return null;
    try {
      return JSON.parse(r.body.toString('utf8'));
    } catch {
      return null;
    }
  }
  throw new SafeHttpError('too_many_redirects', 'Redirecionamentos demais');
}
