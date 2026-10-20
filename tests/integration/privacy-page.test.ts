import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SHORT_HOST, startTestApp, type TestApp } from './helpers.ts';

let t: TestApp;
beforeAll(async () => {
  t = await startTestApp();
});
afterAll(async () => {
  await t.close();
});

describe('Aviso de Privacidade (LGPD art. 9º)', () => {
  it('traz os elementos exigidos e não exibe aviso de "modelo a revisar"', async () => {
    const r = await t.app.inject({ method: 'GET', url: '/privacy', headers: { host: SHORT_HOST } });
    expect(r.statusCode).toBe(200);
    const b = r.body;
    expect(b).not.toMatch(/modelo a revisar/i);
    for (const trecho of [
      'Versão', 'legítimo interesse', 'Seus direitos', 'oposição', 'ANPD', 'transferência internacional',
      'Cloudflare', 'Por quanto tempo guardamos', 'Cópias de segurança', 'Cookies', 'não registra o seu IP',
      `${t.ctx.config.ANALYTICS_RETENTION_DAYS} dias`,
    ]) expect(b, trecho).toContain(trecho);
  });

  it('só cita provedores opcionais quando estão habilitados', async () => {
    const r = await t.app.inject({ method: 'GET', url: '/privacy', headers: { host: SHORT_HOST } });
    expect(r.body).not.toContain('AbuseIPDB (reputação');
    expect(r.body).not.toContain('GreyNoise (classificação');
  });
});
