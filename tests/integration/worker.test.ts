import { Queue, Worker } from 'bullmq';
import { Redis } from 'ioredis';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPool, migrate, type Pool } from '@ipl/database';
import { loadConfig, type AppConfig } from '@ipl/shared';
import { evaluateAlerts, raiseAlert } from '../../apps/worker/src/alerts.ts';
import { enrichEvent, type EnrichDeps } from '../../apps/worker/src/enrich.ts';
import { csvCell, generateExport } from '../../apps/worker/src/exports.ts';
import { GeoService } from '../../apps/worker/src/geo.ts';
import { IntelService } from '../../apps/worker/src/intel.ts';
import { publishOutbox, requeuePartial } from '../../apps/worker/src/outbox.ts';
import { AbuseIpDbProvider, GreyNoiseCommunityProvider } from '../../apps/worker/src/providers.ts';
import { runPurge } from '../../apps/worker/src/purge.ts';
import { parseTorExitList, refreshTorList } from '../../apps/worker/src/tor.ts';
import { TEST_DATABASE_URL, TEST_REDIS_URL, resetDatabase, testEnv } from './helpers.ts';

let pool: Pool;
let config: AppConfig;

const jsonResponse = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });

function abuseBody(score: number) {
  return { data: { ipAddress: '8.8.8.8', abuseConfidenceScore: score, totalReports: 12, numDistinctUsers: 5, lastReportedAt: '2026-10-18T10:00:00+00:00', usageType: 'Data Center', isp: 'Teste', domain: 'example.org', countryCode: 'US', isWhitelisted: false, isTor: false } };
}

interface Harness {
  deps: EnrichDeps;
  abuseFetch: ReturnType<typeof vi.fn>;
  greyFetch: ReturnType<typeof vi.fn>;
}

function harness(opts: {
  abuse?: (url: string) => Response | Promise<Response>;
  grey?: (url: string) => Response | Promise<Response>;
  abuseEnabled?: boolean;
  greyEnabled?: boolean;
  abuseQuota?: number;
  now?: () => number;
} = {}): Harness {
  const abuseFetch = vi.fn(async (url: string | URL) => (opts.abuse ?? (() => jsonResponse(abuseBody(0))))(String(url)));
  const greyFetch = vi.fn(async (url: string | URL) => (opts.grey ?? (() => jsonResponse({ message: 'nao observado' }, 404)))(String(url)));
  const abuse = new AbuseIpDbProvider({ enabled: opts.abuseEnabled ?? true, apiKey: 'chave-de-teste', dailyQuota: opts.abuseQuota ?? 1000, fetchImpl: abuseFetch as unknown as typeof fetch });
  const grey = new GreyNoiseCommunityProvider({ enabled: opts.greyEnabled ?? true, dailyQuota: 50, fetchImpl: greyFetch as unknown as typeof fetch });
  const intel = new IntelService(pool, { cacheTtlHours: 24, negativeTtlHours: 6, now: opts.now });
  return {
    abuseFetch, greyFetch,
    deps: { pool, config, geo: new GeoService('/nao-existe', false), intel, abuse, grey, rdns: async () => null },
  };
}

async function insertEvent(ip: string, extra: { occurredAt?: string; slug?: string; linkId?: string | null } = {}): Promise<string> {
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO access_events (short_link_id, slug, ip_address, method, http_status, user_agent, client_class, occurred_at)
     VALUES ($1, $2, $3, 'GET', 302, 'Teste/1.0', 'unknown', COALESCE($4::timestamptz, now())) RETURNING id`,
    [extra.linkId ?? null, extra.slug ?? 'teste-1', ip, extra.occurredAt ?? null],
  );
  return rows[0]!.id;
}

const eventRow = async (id: string) =>
  (await pool.query('SELECT enrichment_status, risk_score, risk_level, tor_exit FROM access_events WHERE id = $1', [id])).rows[0];

beforeAll(async () => {
  config = loadConfig(testEnv({ ABUSEIPDB_ENABLED: 'true', ABUSEIPDB_API_KEY: 'chave-de-teste', GREYNOISE_ENABLED: 'true' }));
  pool = createPool(TEST_DATABASE_URL, { max: 8 });
  await migrate(pool);
});
afterAll(async () => {
  await pool.end();
});
beforeEach(async () => {
  await resetDatabase(pool);
});

describe('enriquecimento e risco', () => {
  it('CA-07: IP privado/reservado/loopback nunca é consultado em provedores externos', async () => {
    const h = harness();
    for (const ip of ['10.1.2.3', '192.168.0.9', '127.0.0.1', '169.254.1.1', '203.0.113.42', '198.51.100.7', '::1', 'fe80::1', '2001:db8::7']) {
      const id = await insertEvent(ip);
      const r = await enrichEvent(h.deps, id);
      expect(r?.level).toBe('not_evaluated');
      expect((await eventRow(id)).enrichment_status).toBe('skipped');
    }
    expect(h.abuseFetch).not.toHaveBeenCalled();
    expect(h.greyFetch).not.toHaveBeenCalled();
  });

  it('IPv6 público não vai ao GreyNoise Community (somente IPv4) e não consome quota', async () => {
    const h = harness();
    const id = await insertEvent('2606:4700:4700::1111');
    await enrichEvent(h.deps, id);
    expect(h.greyFetch).not.toHaveBeenCalled();
    expect(h.abuseFetch).toHaveBeenCalledTimes(1);
    const q = await pool.query("SELECT used FROM provider_quota WHERE source = 'greynoise'");
    expect(q.rowCount).toBe(0);
  });

  it('CA-09: sem resultado em TI => sem falsa certeza (provedor sem dados e sem score alto)', async () => {
    const h = harness({ abuseEnabled: false, grey: () => jsonResponse({ message: 'nao observado' }, 404) });
    const id = await insertEvent('8.8.8.8');
    const r = await enrichEvent(h.deps, id);
    expect(r?.evidence.some((e) => e.rule === 'GREYNOISE_STATUS' && e.observed === 'no_data')).toBe(true);
    const row = await eventRow(id);
    expect(row.enrichment_status).toBe('done');
    const intel = await pool.query("SELECT status FROM ip_intelligence WHERE source = 'greynoise'");
    expect(intel.rows[0].status).toBe('no_data');
  });

  it('todos os provedores desabilitados => not_evaluated (nunca score zero)', async () => {
    const h = harness({ abuseEnabled: false, greyEnabled: false });
    const id = await insertEvent('8.8.8.8');
    const r = await enrichEvent(h.deps, id);
    expect(r?.level).toBe('not_evaluated');
    const row = await eventRow(id);
    expect(row.risk_score).toBeNull();
    expect(row.risk_level).toBe('not_evaluated');
  });

  it('CA-10: score alto grava avaliação com regras, pesos, fontes e cria alerta com evidência', async () => {
    const h = harness({
      abuse: () => jsonResponse(abuseBody(95)),
      grey: () => jsonResponse({ ip: '8.8.8.8', noise: true, riot: false, classification: 'malicious', name: 'unknown', last_seen: '2026-10-18' }),
    });
    const id = await insertEvent('8.8.8.8');
    const r = await enrichEvent(h.deps, id);
    expect(r?.level).toBe('high');
    expect(r?.score).toBe(80); // 30 + 35 + 15 (corroboração)
    const ass = await pool.query('SELECT score, level, evidence, engine_version FROM risk_assessments WHERE access_event_id = $1', [id]);
    expect(ass.rows).toHaveLength(1);
    expect(ass.rows[0].evidence.map((e: { rule: string }) => e.rule)).toEqual(expect.arrayContaining(['ABUSEIPDB_CONFIDENCE', 'GREYNOISE_MALICIOUS', 'INDEPENDENT_CORROBORATION']));
    expect(ass.rows[0].evidence[0]).toMatchObject({ points: 30, source: 'abuseipdb', version: '1.0.0' });
    const alerts = await pool.query("SELECT type, severity, status, evidence FROM alerts WHERE type = 'ip_high_risk'");
    expect(alerts.rows).toHaveLength(1);
    expect(alerts.rows[0].evidence.rules.length).toBeGreaterThan(0);
  });

  it('reprocessar o mesmo evento é idempotente (uma avaliação, um alerta agregado)', async () => {
    const h = harness({ abuse: () => jsonResponse(abuseBody(95)), grey: () => jsonResponse({ classification: 'malicious', noise: true }) });
    const id = await insertEvent('8.8.8.8');
    await enrichEvent(h.deps, id);
    await enrichEvent(h.deps, id);
    expect((await pool.query('SELECT 1 FROM risk_assessments WHERE access_event_id = $1', [id])).rowCount).toBe(1);
    const a = await pool.query("SELECT occurrences FROM alerts WHERE type = 'ip_high_risk'");
    expect(a.rowCount).toBe(1);
    // consulta ao provedor é cacheada por IP
    expect(h.abuseFetch).toHaveBeenCalledTimes(1);
  });

  it('CA-11: Tor/contexto apenas não gera pontos nem alerta de risco', async () => {
    await pool.query("INSERT INTO job_state (key, value) VALUES ('tor_list', '{\"state\":\"ready\"}'), ('x', '{}') ON CONFLICT DO NOTHING");
    await pool.query("INSERT INTO tor_exit_nodes (ip_address) VALUES ('8.8.4.4')");
    const h = harness({ abuse: () => jsonResponse(abuseBody(0)) });
    const id = await insertEvent('8.8.4.4');
    const r = await enrichEvent(h.deps, id);
    expect(r?.score).toBe(0);
    expect(r?.level).toBe('low');
    const row = await eventRow(id);
    expect(row.tor_exit).toBe('true');
    expect((await pool.query("SELECT 1 FROM alerts WHERE type = 'ip_high_risk'")).rowCount).toBe(0);
  });

  it('CA-08: 429 => rate_limited com backoff, sem laço de requisições; evento fica partial', async () => {
    const h = harness({ abuse: () => jsonResponse({ errors: [] }, 429, { 'retry-after': '3600' }), greyEnabled: false });
    const ids = [await insertEvent('8.8.8.8'), await insertEvent('1.1.1.1'), await insertEvent('9.9.9.9')];
    for (const id of ids) await enrichEvent(h.deps, id);
    expect(h.abuseFetch).toHaveBeenCalledTimes(1); // circuito aberto: as demais nem tentam
    const row = await eventRow(ids[2]!);
    expect(row.enrichment_status).toBe('partial');
    expect(row.risk_level).toBe('not_evaluated');
    const st = await pool.query("SELECT status FROM ip_intelligence WHERE source = 'abuseipdb'");
    expect(st.rows.map((r) => r.status)).toContain('rate_limited');
  });

  it('CA-08: quota diária esgotada => rate_limited sem chamar o provedor', async () => {
    const h = harness({ abuseQuota: 2, greyEnabled: false });
    for (const ip of ['8.8.8.8', '1.1.1.1', '9.9.9.9', '149.112.112.112']) await enrichEvent(h.deps, await insertEvent(ip));
    expect(h.abuseFetch).toHaveBeenCalledTimes(2);
    const q = await pool.query("SELECT used FROM provider_quota WHERE source = 'abuseipdb'");
    expect(q.rows[0].used).toBe(2);
  });

  it('falha de rede persistente abre o circuito (5 falhas) e marca unavailable', async () => {
    const h = harness({ abuse: () => { throw new Error('rede'); }, greyEnabled: false });
    const ips = ['8.8.8.8', '1.1.1.1', '9.9.9.9', '149.112.112.112', '208.67.222.222', '208.67.220.220', '4.2.2.2'];
    for (const ip of ips) await enrichEvent(h.deps, await insertEvent(ip));
    expect(h.abuseFetch.mock.calls.length).toBe(5);
    const js = await pool.query("SELECT value FROM job_state WHERE key = 'provider:abuseipdb'");
    expect(js.rows[0].value.state).toBe('open');
  });

  it('requeuePartial reenfileira eventos partial antigos para nova tentativa', async () => {
    const id = await insertEvent('8.8.8.8');
    await pool.query("UPDATE access_events SET enrichment_status = 'partial', enriched_at = now() - interval '20 minutes' WHERE id = $1", [id]);
    expect(await requeuePartial(pool)).toBe(1);
    expect(await requeuePartial(pool)).toBe(0);
  });
});

describe('outbox e fila (CA-04, CA-19)', () => {
  it('Redis indisponível: itens permanecem na outbox e são publicados quando voltar', async () => {
    const id = await insertEvent('8.8.8.8');
    await pool.query("INSERT INTO outbox_events (aggregate_id, type) VALUES ($1, 'access_event.enrich')", [id]);
    const down = { add: async () => { throw new Error('Redis offline'); } };
    const r1 = await publishOutbox(pool, down);
    expect(r1.failed).toBe(true);
    const pending = await pool.query('SELECT published_at, attempts FROM outbox_events');
    expect(pending.rows[0].published_at).toBeNull();
    expect(pending.rows[0].attempts).toBe(1);

    const added: Array<{ eventId: string; jobId: string }> = [];
    const up = { add: async (_n: string, d: { eventId: string }, o: { jobId: string }) => { added.push({ eventId: d.eventId, jobId: o.jobId }); } };
    const r2 = await publishOutbox(pool, up);
    expect(r2).toEqual({ published: 1, failed: false });
    expect(added[0]!.eventId).toBe(id);
    expect((await publishOutbox(pool, up)).published).toBe(0);
  });

  it('ponta a ponta com BullMQ/Redis reais: outbox -> fila -> worker -> evento enriquecido', async () => {
    const qName = `enrich-test-${Date.now()}`;
    const conn = new Redis(TEST_REDIS_URL, { maxRetriesPerRequest: null });
    const queue = new Queue(qName, { connection: conn });
    const h = harness({ abuse: () => jsonResponse(abuseBody(10)), greyEnabled: false });
    const worker = new Worker<{ eventId: string }>(qName, async (job) => { await enrichEvent(h.deps, job.data.eventId); }, { connection: new Redis(TEST_REDIS_URL, { maxRetriesPerRequest: null }) });
    try {
      const id = await insertEvent('8.8.8.8');
      await pool.query("INSERT INTO outbox_events (aggregate_id, type) VALUES ($1, 'access_event.enrich')", [id]);
      await publishOutbox(pool, queue);
      await publishOutbox(pool, queue); // idempotente
      const deadline = Date.now() + 15_000;
      let row = await eventRow(id);
      while (row.enrichment_status === 'pending' && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 200));
        row = await eventRow(id);
      }
      expect(row.enrichment_status).toBe('done');
      expect(row.risk_level).toBe('low');
      expect(h.abuseFetch).toHaveBeenCalledTimes(1);
    } finally {
      await worker.close();
      await queue.obliterate({ force: true });
      await queue.close();
      conn.disconnect();
    }
  });
});

describe('Tor', () => {
  it('parseia o formato oficial e descarta IPs não públicos', () => {
    const txt = 'ExitNode ABC\nPublished 2026-10-19 10:00:00\nExitAddress 8.8.4.4 2026-10-19 10:05:00\nExitAddress 10.0.0.1 2026-10-19\nExitAddress 2606:4700:4700::1111 2026-10-19\nlixo\n';
    expect(parseTorExitList(txt)).toEqual(['8.8.4.4', '2606:4700:4700::1111']);
  });
  it('lista suspeita (poucas entradas) não substitui a anterior', async () => {
    const f = vi.fn(async () => new Response('ExitAddress 8.8.4.4 2026-10-19\n', { status: 200 }));
    await expect(refreshTorList(pool, 'https://exemplo.test/lista', f as unknown as typeof fetch)).rejects.toThrow(/suspeita/);
  });
  it('lista válida é gravada e marcada como pronta', async () => {
    const body = Array.from({ length: 80 }, (_, i) => `ExitAddress 45.${i + 1}.7.9 2026-10-19 10:00:00`).join('\n');
    const f = vi.fn(async () => new Response(body, { status: 200 }));
    const r = await refreshTorList(pool, 'https://exemplo.test/lista', f as unknown as typeof fetch);
    expect(r.count).toBe(80);
    expect((await pool.query('SELECT count(*)::int AS n FROM tor_exit_nodes')).rows[0].n).toBe(80);
  });
});

describe('alertas', () => {
  it('deduplica por chave e agrega ocorrências', async () => {
    const a = { type: 'ip_rate_anomaly', severity: 'medium' as const, title: 't', ip: '8.8.8.8', evidence: {}, dedupeKey: 'rate:ip:8.8.8.8' };
    await raiseAlert(pool, a);
    await raiseAlert(pool, a);
    const { rows } = await pool.query('SELECT occurrences FROM alerts');
    expect(rows).toEqual([{ occurrences: 2 }]);
    await pool.query("UPDATE alerts SET status = 'resolved'");
    await raiseAlert(pool, a);
    expect((await pool.query('SELECT 1 FROM alerts')).rowCount).toBe(2);
  });

  it('detecta taxa anômala por IP, IP em múltiplos links e falha de captura', async () => {
    const cfg = loadConfig(testEnv({ RATE_ANOMALY_THRESHOLD: '5', MULTI_LINK_THRESHOLD: '3' }));
    const links: string[] = [];
    for (let i = 0; i < 3; i++) {
      const { rows } = await pool.query<{ id: string }>("INSERT INTO short_links (slug, target_url) VALUES ($1, 'https://example.org') RETURNING id", [`link-${i}-xyz`]);
      links.push(rows[0]!.id);
    }
    for (let i = 0; i < 6; i++) await insertEvent('8.8.8.8', { linkId: links[i % 3] });
    await pool.query("INSERT INTO telemetry_counters (key, bucket, value) VALUES ('capture_failed', date_trunc('minute', now()), 3)");
    await evaluateAlerts(pool, cfg, null);
    const types = (await pool.query('SELECT type FROM alerts ORDER BY type')).rows.map((r) => r.type);
    expect(types).toEqual(expect.arrayContaining(['ip_rate_anomaly', 'ip_multi_link', 'capture_failure']));
    await evaluateAlerts(pool, cfg, null);
    expect((await pool.query("SELECT count(*)::int AS n FROM alerts WHERE type = 'ip_rate_anomaly'")).rows[0].n).toBe(1);
  });

  it('alerta de outbox atrasada e fila travada', async () => {
    const id = await insertEvent('8.8.8.8');
    await pool.query("INSERT INTO outbox_events (aggregate_id, type, created_at) VALUES ($1, 'access_event.enrich', now() - interval '10 minutes')", [id]);
    await evaluateAlerts(pool, config, { waiting: 5000, active: 0, failed: 0, oldestWaitingMs: 0 });
    const types = (await pool.query('SELECT type FROM alerts')).rows.map((r) => r.type);
    expect(types).toEqual(expect.arrayContaining(['outbox_lag', 'queue_stuck']));
  });
});

describe('expurgo de 30 dias (CA-16, CA-18)', () => {
  it('remove eventos antigos e todos os vínculos identificáveis, preservando os recentes', async () => {
    const old = await insertEvent('8.8.8.8', { occurredAt: new Date(Date.now() - 31 * 86400_000).toISOString() });
    const old2 = await insertEvent('9.9.9.9', { occurredAt: new Date(Date.now() - 45 * 86400_000).toISOString() });
    const recent = await insertEvent('1.1.1.1');
    const recentOld = await insertEvent('1.1.1.1', { occurredAt: new Date(Date.now() - 29 * 86400_000).toISOString() });
    for (const ip of ['8.8.8.8', '9.9.9.9', '1.1.1.1']) {
      await pool.query("INSERT INTO ip_intelligence (ip_address, source, status, expires_at) VALUES ($1, 'abuseipdb', 'ok', now() + interval '1 day')", [ip]);
    }
    await pool.query("INSERT INTO risk_assessments (access_event_id, score, level, engine_version) VALUES ($1, 10, 'low', '1.0.0')", [old]);
    await pool.query("INSERT INTO alerts (type, severity, title, ip_address, dedupe_key, created_at) VALUES ('ip_high_risk', 'high', 'x', '8.8.8.8', 'k1', now() - interval '32 days')");
    await pool.query("INSERT INTO exports (admin_id, format, expires_at) SELECT id, 'csv', now() - interval '1 minute' FROM admins LIMIT 1");

    const res = await runPurge(pool, { retentionDays: 30, auditRetentionDays: 365 });
    expect(res.deleted.access_events).toBe(2);

    const ids = (await pool.query('SELECT id FROM access_events')).rows.map((r) => r.id);
    expect(ids.sort()).toEqual([recent, recentOld].sort());
    expect((await pool.query('SELECT 1 FROM risk_assessments')).rowCount).toBe(0);
    expect((await pool.query('SELECT 1 FROM alerts WHERE ip_address IS NOT NULL')).rowCount).toBe(0);
    const intelIps = (await pool.query('SELECT host(ip_address) AS ip FROM ip_intelligence')).rows.map((r) => r.ip);
    expect(intelIps).toEqual(['1.1.1.1']);
    expect(old2).toBeTruthy();
  });

  it('CA-18: backup antigo restaurado tem os dados vencidos removidos pelo expurgo', async () => {
    // simula restore: eventos vencidos reaparecem no banco
    for (let i = 0; i < 25; i++) {
      await insertEvent(`45.10.0.${i + 1}`, { occurredAt: new Date(Date.now() - (60 + i) * 86400_000).toISOString() });
    }
    expect((await pool.query('SELECT count(*)::int AS n FROM access_events')).rows[0].n).toBe(25);
    await runPurge(pool, { retentionDays: 30, auditRetentionDays: 365 });
    expect((await pool.query('SELECT count(*)::int AS n FROM access_events')).rows[0].n).toBe(0);
    expect((await pool.query("SELECT value FROM job_state WHERE key = 'purge'")).rows[0].value.deleted.access_events).toBe(25);
  });

  it('processa grandes volumes em lotes', async () => {
    await pool.query(`INSERT INTO access_events (slug, ip_address, method, http_status, occurred_at)
      SELECT 'lote', ('45.20.' || (g / 250) || '.' || (g % 250 + 1))::inet, 'GET', 302, now() - interval '40 days' FROM generate_series(0, 12000) g`);
    const res = await runPurge(pool, { retentionDays: 30, auditRetentionDays: 365 });
    expect(res.deleted.access_events).toBe(12001);
  });
});

describe('exportação (CA-17)', () => {
  async function createExport(format: 'csv' | 'json', filters: Record<string, unknown>, maskIp: boolean) {
    const { rows: ad } = await pool.query<{ id: string }>(`INSERT INTO admins (email, password_hash, totp_secret_encrypted) VALUES ('a@example.org', 'x', 'y') ON CONFLICT (email) DO UPDATE SET email = EXCLUDED.email RETURNING id`);
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO exports (admin_id, format, filters, mask_ip, expires_at) VALUES ($1, $2, $3, $4, now() + interval '30 minutes') RETURNING id`,
      [ad[0]!.id, format, JSON.stringify(filters), maskIp],
    );
    return rows[0]!.id;
  }

  it('CSV respeita filtros, mascara IP por padrão e neutraliza injeção de fórmulas', async () => {
    await pool.query(`INSERT INTO access_events (slug, ip_address, method, http_status, user_agent, client_class) VALUES
      ('a', '203.0.113.42', 'GET', 302, '=HYPERLINK("http://evil","x")', 'bot'),
      ('a', '198.51.100.9', 'GET', 302, 'Mozilla', 'human_probable')`);
    const id = await createExport('csv', { clientClass: 'bot' }, true);
    await generateExport(pool, id);
    const { rows } = await pool.query('SELECT status, content, row_count FROM exports WHERE id = $1', [id]);
    expect(rows[0].status).toBe('ready');
    expect(rows[0].row_count).toBe(1);
    const csv = rows[0].content as string;
    expect(csv).toContain('203.0.113.0/24');
    expect(csv).not.toContain('203.0.113.42');
    expect(csv).not.toContain('198.51.100');
    expect(csv).toContain(`"'=HYPERLINK(""http://evil"",""x"")"`);
  });

  it('JSON com IP completo apenas quando solicitado', async () => {
    await insertEvent('203.0.113.42');
    const id = await createExport('json', {}, false);
    await generateExport(pool, id);
    const doc = JSON.parse((await pool.query('SELECT content FROM exports WHERE id = $1', [id])).rows[0].content);
    expect(doc.ipMasked).toBe(false);
    expect(doc.items[0].ip).toBe('203.0.113.42');
  });

  it('csvCell escapa corretamente', () => {
    expect(csvCell('a,b')).toBe('"a,b"');
    expect(csvCell('@cmd')).toBe("'@cmd");
    expect(csvCell(null)).toBe('');
  });
});
