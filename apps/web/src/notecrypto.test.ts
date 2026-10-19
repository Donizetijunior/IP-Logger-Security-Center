import { describe, expect, it } from 'vitest';
import { decryptNote, encryptNote } from './notecrypto';

describe('cifragem de notas no navegador', () => {
  it('ida e volta com acentos, emoji e quebras de linha', async () => {
    const msg = 'Senha do cofre: ação\nlinha 2 🔐';
    const e = await encryptNote(msg);
    expect(e.ciphertext).not.toContain('cofre');
    expect(e.key).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(await decryptNote(e.ciphertext, e.iv, e.key)).toBe(msg);
  });

  it('chave errada ou conteúdo adulterado não decifra', async () => {
    const a = await encryptNote('segredo');
    const b = await encryptNote('outro');
    await expect(decryptNote(a.ciphertext, a.iv, b.key)).rejects.toBeTruthy();
    const tampered = (a.ciphertext[0] === 'A' ? 'B' : 'A') + a.ciphertext.slice(1);
    await expect(decryptNote(tampered, a.iv, a.key)).rejects.toBeTruthy();
  });

  it('cada nota usa chave e IV novos', async () => {
    const a = await encryptNote('x');
    const b = await encryptNote('x');
    expect(a.key).not.toBe(b.key);
    expect(a.iv).not.toBe(b.iv);
    expect(a.ciphertext).not.toBe(b.ciphertext);
  });
});
