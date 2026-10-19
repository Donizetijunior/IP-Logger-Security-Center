/**
 * Carga progressiva da rota de redirecionamento (10, 25 e 50 req/s) pela cadeia real Caddy -> API -> Postgres.
 * Mede latência do lado do cliente (inclui Caddy e loopback do Docker Desktop) e, ao final de cada
 * etapa, o p50/p95/p99 INTERNO da rota (métrica do handler) e uso de CPU/RAM dos contêineres.
 *
 * Uso:  E2E_TOTP_SECRET=... E2E_PASSWORD=... node tests/load/redirect-load.mjs
 * Opcionais: E2E_PORT (18088), E2E_EMAIL, LOAD_SECONDS (20), LOAD_RATES ("10,25,50")
 * Observação: resultados dependem da máquina; meça na VPS de referência antes de afirmar capacidade.
 */
import { execFileSync } from 'node:child_process';
import http from 'node:http';
import { authenticator } from 'otplib';

const PORT = Number(process.env.E2E_PORT ?? 18088);
const EMAIL = process.env.E2E_EMAIL ?? 'admin@example.org';
const SECRET = process.env.E2E_TOTP_SECRET;
const PASSWORD = process.env.E2E_PASSWORD;
const SECONDS = Number(process.env.LOAD_SECONDS ?? 20);
const RATES = (process.env.LOAD_RATES ?? '10,25,50').split(',').map(Number);
if (!SECRET || !PASSWORD) {
  console.error('Defina E2E_TOTP_SECRET e E2E_PASSWORD');
  process.exit(1);
}

const agent = new http.Agent({ keepAlive: true, maxSockets: 200 });
function req(site, method, path, { headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const r = http.request(
      { host: '127.0.0.1', port: PORT, method, path, agent, timeout: 10000,
        headers: { host: `${site}.localhost:${PORT}`, 'user-agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/124.0 Safari/537.36', ...(payload ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) } : {}), ...headers } },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text: Buffer.concat(chunks).toString() }));
      },
    );
    r.on('timeout', () => r.destroy(new Error('timeout')));
    r.on('error', reject);
    if (payload) r.write(payload);
    r.end();
  });
}

const pct = (arr, q) => { const s = [...arr].sort((a, b) => a - b); return s.length ? s[Math.min(s.length - 1, Math.floor(q * s.length))] : 0; };
const sh = (cmd, args) => execFileSync(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] }).toString().trim();

// Aguarda a próxima janela TOTP para não colidir com a proteção contra replay
const wait = 30000 - (Date.now() % 30000) + 500;
console.log(`Aguardando ${(wait / 1000).toFixed(1)} s para uma janela TOTP nova…`);
await new Promise((r) => setTimeout(r, wait));
const l1 = await req('painel', 'POST', '/api/v1/auth/login', { body: { email: EMAIL, password: PASSWORD } });
const l2 = await req('painel', 'POST', '/api/v1/auth/totp/verify', { body: { challenge: JSON.parse(l1.text).challenge, code: authenticator.generate(SECRET) } });
if (l2.status !== 200) throw new Error(`login falhou: ${l2.text}`);
const cookie = l2.headers['set-cookie'][0].split(';')[0];
const csrf = JSON.parse(l2.text).csrfToken;
const slug = `load-${Date.now().toString(36)}`;
const c = await req('painel', 'POST', '/api/v1/links', { headers: { cookie, 'x-csrf-token': csrf }, body: { slug, targetUrl: 'https://example.org/carga', label: 'Teste de carga' } });
if (c.status !== 201) throw new Error(`criar link falhou: ${c.text}`);

const results = [];
for (const rate of RATES) {
  const lat = [];
  let errors = 0;
  let non302 = 0;
  const statuses = {};
  let inflight = 0;
  let sent = 0;
  const total = rate * SECONDS;
  const started = performance.now();
  await new Promise((resolve) => {
    const tick = setInterval(() => {
      if (sent >= total) {
        clearInterval(tick);
        const done = setInterval(() => { if (inflight === 0) { clearInterval(done); resolve(); } }, 50);
        return;
      }
      // dispara em rajadas de 10 ms para manter a taxa média
      const due = Math.floor(((performance.now() - started) / 1000) * rate) - sent;
      for (let i = 0; i < due && sent < total; i++) {
        sent++;
        inflight++;
        const t0 = performance.now();
        req('links', 'GET', `/${slug}`)
          .then((res) => { lat.push(performance.now() - t0); statuses[res.status] = (statuses[res.status] ?? 0) + 1; if (res.status !== 302) non302++; })
          .catch(() => { errors++; })
          .finally(() => { inflight--; });
      }
    }, 10);
  });
  const stats = sh('docker', ['stats', '--no-stream', '--format', '{{.Name}} cpu={{.CPUPerc}} mem={{.MemUsage}}', 'iplogger-api-1', 'iplogger-caddy-1', 'iplogger-postgres-1', 'iplogger-worker-1']);
  let internal = '';
  try {
    internal = sh('docker', ['compose', 'exec', '-T', 'api', 'wget', '-qO-', 'http://127.0.0.1:3000/metrics']).split('\n').filter((l) => l.startsWith('iplogger_redirect_ms')).join(' ');
  } catch { /* métrica indisponível */ }
  const queue = sh('docker', ['compose', 'exec', '-T', 'postgres', 'psql', '-U', 'iplogger', '-d', 'iplogger', '-Atc', "select count(*) filter (where published_at is null) || ' pendentes na outbox'  from outbox_events"]);
  const row = { rate, sent, statuses: JSON.stringify(statuses), ok302: lat.length - non302, non302, errors, clientP50: +pct(lat, 0.5).toFixed(1), clientP95: +pct(lat, 0.95).toFixed(1), clientP99: +pct(lat, 0.99).toFixed(1) };
  results.push(row);
  console.log(`\n== ${rate} req/s por ${SECONDS}s ==`);
  console.log(JSON.stringify(row));
  console.log('interno (handler):', internal);
  console.log(stats);
  console.log('outbox:', queue);
  await new Promise((r) => setTimeout(r, 3000));
}
console.log('\nResumo:');
console.table(results);
await req('painel', 'DELETE', '/api/v1/links/' + JSON.parse(c.text).id, { headers: { cookie, 'x-csrf-token': csrf } });
agent.destroy();
