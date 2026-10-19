import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPool, migrate, type Pool } from '@ipl/database';
import { EMPTY_GEO, GeoService, describeSource, firstExisting } from '../../apps/worker/src/geo.ts';
import { TEST_DATABASE_URL } from './helpers.ts';

describe('bases de geolocalização (GeoLite2 ou DB-IP Lite)', () => {
  it('prefere GeoLite2 quando as duas existem; aceita só DB-IP Lite', () => {
    const dir = mkdtempSync(join(tmpdir(), 'geo-'));
    expect(firstExisting(dir, ['GeoLite2-City.mmdb', 'dbip-city-lite.mmdb'])).toBeNull();
    writeFileSync(join(dir, 'dbip-city-lite.mmdb'), 'x');
    expect(firstExisting(dir, ['GeoLite2-City.mmdb', 'dbip-city-lite.mmdb'])).toBe(join(dir, 'dbip-city-lite.mmdb'));
    writeFileSync(join(dir, 'GeoLite2-City.mmdb'), 'x');
    expect(firstExisting(dir, ['GeoLite2-City.mmdb', 'dbip-city-lite.mmdb'])).toBe(join(dir, 'GeoLite2-City.mmdb'));
  });

  it('a atribuição exigida pela licença acompanha a base em uso', () => {
    expect(describeSource('/geoip/dbip-city-lite.mmdb')).toMatchObject({ source: 'DB-IP Lite', attribution: expect.stringContaining('DB-IP') });
    expect(describeSource('/geoip/GeoLite2-City.mmdb')).toMatchObject({ source: 'GeoLite2', attribution: expect.stringContaining('MaxMind') });
    expect(describeSource(null)).toBeNull();
  });

  describe('GeoService', () => {
    let pool: Pool;
    beforeAll(async () => {
      pool = createPool(TEST_DATABASE_URL, { max: 2 });
      await migrate(pool);
    });
    afterAll(async () => {
      await pool.end();
    });
    const state = async () => (await pool.query("SELECT value FROM job_state WHERE key = 'geoip'")).rows[0].value;

    it('desabilitado, sem bases ou com arquivo corrompido: nunca quebra e devolve geolocalização vazia', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'geo-'));
      const off = new GeoService(dir, false);
      await off.reload(pool);
      expect((await state()).state).toBe('disabled');

      const missing = new GeoService(dir, true);
      await missing.reload(pool);
      expect((await state()).state).toBe('missing_databases');
      expect(missing.lookup('8.8.8.8')).toEqual(EMPTY_GEO);

      writeFileSync(join(dir, 'dbip-city-lite.mmdb'), 'isto não é um arquivo MMDB');
      const bad = new GeoService(dir, true);
      await bad.reload(pool);
      const s = await state();
      expect(s.state).toBe('error');
      expect(s.attribution).toContain('DB-IP');
      expect(bad.lookup('8.8.8.8')).toEqual(EMPTY_GEO);
    });
  });
});
