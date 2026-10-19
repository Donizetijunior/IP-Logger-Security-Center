/**
 * E2E contra o stack Docker Compose em execução (Caddy -> API/Web -> Postgres/Redis/Worker).
 * Executa somente com: E2E_TOTP_SECRET=<segredo do admin de teste> E2E_PASSWORD=<senha> npx vitest run tests/e2e
 * Opcionais: E2E_PORT (padrão 18088), E2E_EMAIL (padrão admin@example.org).
 * Os cenários de indisponibilidade param e iniciam contêineres do projeto "iplogger".
 */
import { execFileSync } from 'node:child_process';
import http from 'node:http';
import { authenticator } from 'otplib';
import { describe, expect, it } from 'vitest';

const SECRET = process.env.E2E_TOTP_SECRET;
const PASSWORD = process.env.E2E_PASSWORD ?? '';
const EMAIL = process.env.E2E_EMAIL ?? 'admin@example.org';
const PORT = Number(process.env.E2E_PORT ?? 18088);
const ROOT = new URL('../../', import.meta.url);

interface Res {
  status: number;
  headers: http.IncomingHttpHeaders;
  text: string;
  json<T = any>(): T;
}

function req(site: 'links' | 'painel', method: string, path: string, opts: { headers?: Record<string, string>; body?: unknown } = {}): Promise<Res> {
  return new Promise((resolve, reject) => {
    const payload = opts.body === undefined ? undefined : JSON.stringify(opts.body);
    const r = http.request(
      {
        host: '127.0.0.1', port: PORT, method, path,
        headers: { host: `${site}.localhost:${PORT}`, ...(payload ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) } : {}), ...opts.headers },
        timeout: 15000,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          resolve({ status: res.statusCode ?? 0, headers: res.headers, text, json: () => JSON.parse(text) });
        });
      },
    );
    r.on('timeout', () => r.destroy(new Error('timeout')));
    r.on('error', reject);
    if (payload) r.write(payload);
    r.end();
  });
}

const compose = (...args: string[]) => execFileSync('docker', ['compose', ...args], { cwd: ROOT, stdio: 'pipe' }).toString();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function until<T>(fn: () => Promise<T | null | false>, timeoutMs = 60_000, everyMs = 1000): Promise<T> {
  const end = Date.now() + timeoutMs;
  let last: unknown;
  while (Date.now() < end) {
    try {
      const v = await fn();
      if (v) return v;
    } catch (e) {
      last = e;
    }
    await sleep(everyMs);
  }
  throw new Error(`timeout aguardando condição${last ? `: ${String(last)}` : ''}`);
}

describe.skipIf(!SECRET)('stack Docker Compose (E2E)', () => {
  let cookie = '';
  let csrf = '';
  const auth = (extra: Record<string, string> = {}) => ({ cookie, 'x-csrf-token': csrf, ...extra });
  const slug = `e2e-${Date.now().toString(36)}`;

  it('aviso de privacidade público responde no domínio de links', async () => {
    const r = await req('links', 'GET', '/privacy');
    expect(r.status).toBe(200);
    expect(r.text).toContain('Aviso de Privacidade');
  });

  it('cabeçalhos de segurança no painel e superfícies internas ocultas', async () => {
    const r = await req('painel', 'GET', '/');
    expect(r.status).toBe(200);
    expect(r.headers['content-security-policy']).toContain("default-src 'self'");
    expect(r.headers['x-content-type-options']).toBe('nosniff');
    expect(r.headers.server).toBeUndefined();
    for (const p of ['/metrics', '/readyz', '/healthz']) {
      expect((await req('links', 'GET', p)).status).toBe(404);
      expect((await req('painel', 'GET', p)).status).toBe(404);
    }
    expect((await req('links', 'GET', '/api/v1/links')).status).toBe(404);
    expect((await req('painel', 'GET', '/api/v1/links')).status).toBe(401);
  });

  it('login com senha + TOTP cria sessão', async () => {
    const r1 = await req('painel', 'POST', '/api/v1/auth/login', { body: { email: EMAIL, password: PASSWORD } });
    expect(r1.status).toBe(200);
    const code = authenticator.generate(SECRET!);
    const r2 = await req('painel', 'POST', '/api/v1/auth/totp/verify', { body: { challenge: r1.json().challenge, code } });
    expect(r2.status).toBe(200);
    const sc = (r2.headers['set-cookie'] ?? [])[0] ?? '';
    expect(sc).toMatch(/HttpOnly/i);
    expect(sc).toMatch(/SameSite=Strict/i);
    cookie = sc.split(';')[0]!;
    csrf = r2.json().csrfToken;
    expect((await req('painel', 'GET', '/api/v1/auth/me', { headers: auth() })).status).toBe(200);
  });

  it('CA-01/02: cria link e redireciona com 302 e no-store', async () => {
    const c = await req('painel', 'POST', '/api/v1/links', { headers: auth(), body: { slug, targetUrl: 'https://example.org/e2e', label: 'E2E' } });
    expect(c.status).toBe(201);
    const r = await req('links', 'GET', `/${slug}`, { headers: { 'user-agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36' } });
    expect(r.status).toBe(302);
    expect(r.headers.location).toBe('https://example.org/e2e');
    expect(r.headers['cache-control']).toBe('no-store');
  });

  it('CA-06: X-Forwarded-For forjado pelo visitante não altera o IP registrado (cadeia real Caddy -> API)', async () => {
    await req('links', 'GET', `/${slug}`, { headers: { 'x-forwarded-for': '6.6.6.6', 'user-agent': 'e2e-spoof' } });
    const ev = await until(async () => {
      const r = await req('painel', 'GET', '/api/v1/events?limit=10', { headers: auth() });
      return r.json().items.find((e: any) => e.userAgent === 'e2e-spoof') ?? null;
    }, 20_000);
    expect(ev.ipAddress).not.toBe('6.6.6.6');
    expect(ev.ipAddress).toMatch(/^[0-9a-f.:]+$/);
  });

  it('CA-03/07: worker enriquece o evento de forma assíncrona; IP privado é ignorado em provedores externos', async () => {
    const ev = await until(async () => {
      const r = await req('painel', 'GET', '/api/v1/events?limit=10', { headers: auth() });
      const e = r.json().items.find((x: any) => x.userAgent === 'e2e-spoof');
      return e && e.enrichmentStatus !== 'pending' ? e : null;
    }, 45_000);
    expect(['skipped', 'done']).toContain(ev.enrichmentStatus);
    expect(ev.risk.level).toBe('not_evaluated');
  });

  it('dashboard e integrações refletem o estado real', async () => {
    const s = (await req('painel', 'GET', '/api/v1/dashboard/summary?period=24h', { headers: auth() })).json();
    expect(s.requestsTotal).toBeGreaterThanOrEqual(2);
    const i = (await req('painel', 'GET', '/api/v1/integrations/status', { headers: auth() })).json();
    const ab = i.providers.find((p: any) => p.source === 'abuseipdb');
    expect(ab.state).toBe('disabled');
    await until(async () => {
      const x = (await req('painel', 'GET', '/api/v1/integrations/status', { headers: auth() })).json();
      return x.jobs.workerHeartbeatAt ? x : null;
    }, 30_000);
  });

  it('CA-04: com o Redis offline o evento fica na outbox e é processado quando o Redis volta', async () => {
    compose('stop', 'redis');
    try {
      const r = await req('links', 'GET', `/${slug}`, { headers: { 'user-agent': 'e2e-redis-down' } });
      expect(r.status).toBe(302);
      await sleep(2500);
      const ev = (await req('painel', 'GET', '/api/v1/events?limit=10', { headers: auth() })).json().items.find((e: any) => e.userAgent === 'e2e-redis-down');
      expect(ev).toBeTruthy();
      expect(ev.enrichmentStatus).toBe('pending');
    } finally {
      compose('start', 'redis');
    }
    const ev = await until(async () => {
      const x = (await req('painel', 'GET', '/api/v1/events?limit=10', { headers: auth() })).json().items.find((e: any) => e.userAgent === 'e2e-redis-down');
      return x && x.enrichmentStatus !== 'pending' ? x : null;
    }, 90_000, 2000);
    expect(['skipped', 'done']).toContain(ev.enrichmentStatus);
  }, 240_000);

  it('CA-19: reinício dos contêineres preserva dados e sessão; fila/outbox retomam', async () => {
    compose('restart', 'api', 'worker');
    await until(async () => (await req('painel', 'GET', '/api/v1/auth/me', { headers: auth() })).status === 200, 60_000, 2000);
    expect((await req('links', 'GET', `/${slug}`)).status).toBe(302);
    const evs = (await req('painel', 'GET', '/api/v1/events?limit=50', { headers: auth() })).json().items;
    expect(evs.length).toBeGreaterThanOrEqual(3);
  });

  it('CA-05: com o PostgreSQL offline o redirect segue (fail-open) e a perda é contabilizada e visível', async () => {
    // aquece o cache e garante TTL expirado (30 s) para forçar o uso da cópia "stale"
    expect((await req('links', 'GET', `/${slug}`)).status).toBe(302);
    await sleep(31_000);
    compose('stop', 'postgres');
    try {
      const r = await req('links', 'GET', `/${slug}`, { headers: { 'user-agent': 'e2e-db-down' } });
      expect(r.status).toBe(302);
      expect(r.headers.location).toBe('https://example.org/e2e');
      const unknown = await req('links', 'GET', '/nunca-visto-e2e');
      expect(unknown.status).toBe(503);
    } finally {
      compose('start', 'postgres');
    }
    await until(async () => (await req('painel', 'GET', '/api/v1/dashboard/summary', { headers: auth() })).status === 200, 90_000, 2000);
    const s = await until(async () => {
      const x = (await req('painel', 'GET', '/api/v1/dashboard/summary?period=24h', { headers: auth() })).json();
      return x.captureFailures >= 1 ? x : null;
    }, 60_000, 2000);
    expect(s.captureFailures).toBeGreaterThanOrEqual(1);
  }, 240_000);

  it('CA-17: exportação exige reautenticação, é gerada pelo worker, mascara o IP e fica auditada', async () => {
    const denied = await req('painel', 'POST', '/api/v1/exports', { headers: auth(), body: { format: 'csv' } });
    expect(denied.status).toBe(403);
    expect((await req('painel', 'POST', '/api/v1/auth/reauth', { headers: auth(), body: { password: PASSWORD } })).status).toBe(200);
    const created = await req('painel', 'POST', '/api/v1/exports', { headers: auth(), body: { format: 'csv', filters: { method: 'GET' } } });
    expect(created.status).toBe(202);
    const id = created.json().id;
    await until(async () => (await req('painel', 'GET', `/api/v1/exports/${id}`, { headers: auth() })).json().status === 'ready', 30_000, 1000);
    const dl = await req('painel', 'GET', `/api/v1/exports/${id}/download`, { headers: auth() });
    expect(dl.status).toBe(200);
    expect(dl.headers['content-type']).toContain('text/csv');
    expect(dl.text.split('\r\n')[0]).toContain('occurred_at');
    expect(dl.text).toMatch(/\d+\.\d+\.\d+\.0\/24/);
    const audit = (await req('painel', 'GET', '/api/v1/audit?action=export.create', { headers: auth() })).json().items;
    expect(audit.map((a: any) => a.result)).toEqual(expect.arrayContaining(['success', 'denied']));
  });

  it('CA-13: logout revoga a sessão', async () => {
    expect((await req('painel', 'POST', '/api/v1/auth/logout', { headers: auth() })).status).toBe(200);
    expect((await req('painel', 'GET', '/api/v1/auth/me', { headers: auth() })).status).toBe(401);
  });
});
