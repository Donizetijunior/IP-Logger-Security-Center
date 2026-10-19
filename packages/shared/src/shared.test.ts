import { describe, expect, it } from 'vitest';
import {
  classifyClient, computeRisk, isPublicIp, isValidSlug, maskIp, normalizeIp, parseCidrs, resolveClientIp,
  sanitizeReferer, sanitizeText, validateTargetUrl, loadConfig,
} from './index.ts';

describe('isPublicIp (CA-07)', () => {
  it.each([
    ['8.8.8.8', true], ['1.1.1.1', true], ['2606:4700:4700::1111', true],
    ['127.0.0.1', false], ['10.0.0.5', false], ['172.16.3.4', false], ['192.168.1.1', false],
    ['169.254.1.1', false], ['100.64.0.1', false], ['224.0.0.1', false], ['0.0.0.0', false],
    ['192.0.2.10', false], ['198.51.100.7', false], ['203.0.113.42', false],
    ['::1', false], ['fe80::1', false], ['fc00::1', false], ['2001:db8::1', false],
    ['::ffff:10.0.0.1', false], ['::ffff:8.8.8.8', true],
    ['not-an-ip', false], ['', false], ['999.1.1.1', false],
  ])('%s -> %s', (ip, expected) => {
    expect(isPublicIp(ip)).toBe(expected);
  });

  it('normaliza IPv4-mapped', () => {
    expect(normalizeIp('::ffff:8.8.8.8')).toBe('8.8.8.8');
  });
});

describe('resolveClientIp (CA-06)', () => {
  const trusted = parseCidrs('172.18.0.0/16');

  it('conexão direta ignora X-Forwarded-For forjado', () => {
    expect(resolveClientIp({ socketIp: '198.51.100.9', forwardedFor: '1.2.3.4', trusted })).toBe('198.51.100.9');
  });
  it('proxy confiável: usa o último salto não confiável', () => {
    expect(resolveClientIp({ socketIp: '172.18.0.5', forwardedFor: '6.6.6.6, 203.0.113.42', trusted })).toBe('203.0.113.42');
  });
  it('valor forjado à esquerda não prevalece', () => {
    expect(resolveClientIp({ socketIp: '172.18.0.5', forwardedFor: '6.6.6.6', trusted })).toBe('6.6.6.6');
    expect(resolveClientIp({ socketIp: '172.18.0.5', forwardedFor: '6.6.6.6, 9.9.9.9, 172.18.0.9', trusted })).toBe('9.9.9.9');
  });
  it('cadeia malformada cai para o IP do socket', () => {
    expect(resolveClientIp({ socketIp: '172.18.0.5', forwardedFor: 'lixo', trusted })).toBe('172.18.0.5');
  });
  it('sem header usa o socket', () => {
    expect(resolveClientIp({ socketIp: '172.18.0.5', forwardedFor: undefined, trusted })).toBe('172.18.0.5');
  });
  it('sem proxies confiáveis nunca confia no header', () => {
    expect(resolveClientIp({ socketIp: '172.18.0.5', forwardedFor: '1.1.1.1', trusted: [] })).toBe('172.18.0.5');
  });
});

describe('sanitização (CA-15)', () => {
  it('remove CR/LF e controles', () => {
    expect(sanitizeText('abc\r\nSet-Cookie: x=1\u0000', 100)).toBe('abc Set-Cookie: x=1');
  });
  it('trunca', () => {
    expect(sanitizeText('a'.repeat(1000), 10)).toHaveLength(10);
  });
  it('referer guarda só a origem', () => {
    expect(sanitizeReferer('https://exemplo.org/a/b?token=secret#frag')).toBe('https://exemplo.org');
    expect(sanitizeReferer('javascript:alert(1)')).toBeNull();
  });
  it('máscara de IP', () => {
    expect(maskIp('203.0.113.42')).toBe('203.0.113.0/24');
    expect(maskIp('2001:db8:1:2::1')).toBe('2001:db8:1::/48');
  });
});

describe('slug e URL de destino (CA-20)', () => {
  it('slugs', () => {
    expect(isValidSlug('campanha-a1')).toBe(true);
    expect(isValidSlug('api')).toBe(false);
    expect(isValidSlug('privacy')).toBe(false);
    expect(isValidSlug('a')).toBe(false);
    expect(isValidSlug('a b c')).toBe(false);
    expect(isValidSlug('../etc')).toBe(false);
  });
  it.each([
    ['https://exemplo.org/recurso', true],
    ['http://exemplo.org', true],
    ['javascript:alert(1)', false],
    ['data:text/html,<script>', false],
    ['file:///etc/passwd', false],
    ['https://user:pass@exemplo.org', false],
    ['http://localhost/admin', false],
    ['http://127.0.0.1/', false],
    ['http://2130706433/', false],
    ['http://0x7f.1/', false],
    ['http://169.254.169.254/latest/meta-data', false],
    ['http://[::1]/', false],
    ['https://exemplo.org/\r\nX: y', false],
    ['', false],
  ])('%s -> %s', (u, ok) => {
    expect(validateTargetUrl(u).ok).toBe(ok);
  });
  it('allowlist de domínio', () => {
    expect(validateTargetUrl('https://sub.exemplo.org/x', ['exemplo.org']).ok).toBe(true);
    expect(validateTargetUrl('https://evil.com/x', ['exemplo.org']).ok).toBe(false);
    expect(validateTargetUrl('https://notexemplo.org/x', ['exemplo.org']).ok).toBe(false);
  });
});

describe('classifyClient (CA-21)', () => {
  const chrome = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
  it('HEAD nunca é humano', () => {
    expect(classifyClient('HEAD', chrome).clientClass).toBe('head_probe');
  });
  it('navegador comum é humano provável', () => {
    expect(classifyClient('GET', chrome).clientClass).toBe('human_probable');
  });
  it('prévia de mensageiro', () => {
    expect(classifyClient('GET', 'WhatsApp/2.23.20 A').clientClass).toBe('preview');
    expect(classifyClient('GET', 'Slackbot-LinkExpanding 1.0').clientClass).toBe('preview');
  });
  it('robôs e ferramentas', () => {
    expect(classifyClient('GET', 'curl/8.4.0').clientClass).toBe('bot');
    expect(classifyClient('GET', 'python-requests/2.31').clientClass).toBe('bot');
  });
  it('sem UA é desconhecido', () => {
    expect(classifyClient('GET', null).clientClass).toBe('unknown');
  });
});

describe('computeRisk (CA-09, CA-10, CA-11)', () => {
  const at = '2026-10-19T12:00:00Z';
  const abuse = (score: number) => ({ source: 'abuseipdb', status: 'ok' as const, checkedAt: at, data: { abuseConfidenceScore: score } });
  const grey = (classification: string) => ({ source: 'greynoise', status: 'ok' as const, checkedAt: at, data: { classification, noise: true } });

  it('sem fontes mínimas => not_evaluated, nunca zero', () => {
    const r = computeRisk({ abuseipdb: { source: 'abuseipdb', status: 'disabled', checkedAt: null }, greynoise: null });
    expect(r.level).toBe('not_evaluated');
    expect(r.score).toBeNull();
  });
  it('fontes indisponíveis => not_evaluated', () => {
    const r = computeRisk({ abuseipdb: { source: 'abuseipdb', status: 'rate_limited', checkedAt: at }, greynoise: { source: 'greynoise', status: 'unavailable', checkedAt: at } });
    expect(r.level).toBe('not_evaluated');
  });
  it('sem resultado (no_data) é avaliável e baixo, sem falsa certeza de segurança', () => {
    const r = computeRisk({ abuseipdb: { source: 'abuseipdb', status: 'no_data', checkedAt: at } });
    expect(r.level).toBe('low');
    expect(r.score).toBe(0);
  });
  it('AbuseIPDB alto pontua 30 com evidência rastreável', () => {
    const r = computeRisk({ abuseipdb: abuse(90) });
    expect(r.score).toBe(30);
    expect(r.level).toBe('medium');
    expect(r.evidence[0]).toMatchObject({ rule: 'ABUSEIPDB_CONFIDENCE', points: 30, observed: 90, source: 'abuseipdb', version: '1.0.0' });
  });
  it('combinação de fontes e anomalia chega a high', () => {
    const r = computeRisk({ abuseipdb: abuse(95), greynoise: grey('malicious'), rate: { count: 100, windowMinutes: 10 } });
    expect(r.score).toBe(100);
    expect(r.level).toBe('high');
    expect(r.evidence.map((e) => e.rule)).toEqual(
      expect.arrayContaining(['ABUSEIPDB_CONFIDENCE', 'GREYNOISE_MALICIOUS', 'INDEPENDENT_CORROBORATION', 'RATE_ANOMALY']),
    );
  });
  it('noise sem classificação maliciosa não pontua', () => {
    const r = computeRisk({ abuseipdb: { source: 'abuseipdb', status: 'no_data', checkedAt: at }, greynoise: grey('benign') });
    expect(r.score).toBe(0);
  });
  it('Tor apenas não pontua', () => {
    const r = computeRisk({ abuseipdb: { source: 'abuseipdb', status: 'no_data', checkedAt: at }, torExit: true });
    expect(r.score).toBe(0);
    expect(r.evidence.find((e) => e.rule === 'TOR_EXIT_CONTEXT')?.points).toBe(0);
  });
  it('score limitado a 100', () => {
    const r = computeRisk({ abuseipdb: abuse(100), greynoise: grey('malicious'), rate: { count: 9999, windowMinutes: 10 } });
    expect(r.score).toBeLessThanOrEqual(100);
  });
});

describe('loadConfig', () => {
  const base = {
    DATABASE_URL: 'postgresql://u:p@h/db',
    SESSION_SECRET: 'x'.repeat(40),
    TOTP_ENCRYPTION_KEY: 'a'.repeat(64),
  };
  it('carrega defaults', () => {
    const c = loadConfig({ ...base, NODE_ENV: 'development' });
    expect(c.ANALYTICS_RETENTION_DAYS).toBe(30);
    expect(c.ABUSEIPDB_ENABLED).toBe(false);
  });
  it('produção bloqueia sem decisão jurídica', () => {
    expect(() => loadConfig({ ...base, NODE_ENV: 'production' })).toThrow(/Go-live bloqueado/);
  });
  it('produção rejeita CHANGE_ME', () => {
    expect(() => loadConfig({ ...base, SESSION_SECRET: 'CHANGE_ME_'.repeat(5), NODE_ENV: 'production', LEGAL_REVIEW_ACKNOWLEDGED: 'true' })).toThrow(/CHANGE_ME/);
  });
});
