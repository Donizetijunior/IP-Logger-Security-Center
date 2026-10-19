import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const DIR = new URL('../../infra/scripts/', import.meta.url);
const files = readdirSync(DIR).filter((f) => f.endsWith('.sh'));

describe('scripts de operação (infra/scripts)', () => {
  it.each(files)('%s tem sintaxe válida de bash', (f) => {
    execFileSync('bash', ['-n', new URL(f, DIR).pathname.replace(/^\/([A-Za-z]:)/, '$1')]);
  });

  it('nenhum script executa o .env como código (valores com espaço/parênteses quebrariam o shell)', () => {
    for (const f of files) {
      const text = readFileSync(new URL(f, DIR), 'utf8');
      expect(text, f).not.toMatch(/^\s*(\.|source)\s+\.?\/?\.env\b/m);
      expect(text, f).not.toMatch(/set -a;.*\.env/);
    }
  });

  it('envval lê o .env sem executá-lo, inclusive com espaços, parênteses e aspas', () => {
    const dir = mkdtempSync(join(tmpdir(), 'envt-'));
    writeFileSync(join(dir, '.env'), 'POSTGRES_USER=iplogger\nPRIVACY_CONTROLLER_NAME=Operador do serviço (pessoa física)\nPOSTGRES_DB="meu banco"\n');
    const fn = readFileSync(new URL('backup.sh', DIR), 'utf8').split('\n').find((l) => l.startsWith('envval()'))!;
    const out = execFileSync('bash', ['-c', `${fn}\nprintf '%s|%s|%s' "$(envval POSTGRES_USER)" "$(envval POSTGRES_DB)" "$(envval NAO_EXISTE)"`], { cwd: dir }).toString();
    expect(out).toBe('iplogger|meu banco|');
  });
});
