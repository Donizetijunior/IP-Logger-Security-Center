/** Cifragem de notas no navegador: AES-GCM 256. A chave vai no fragmento da URL (#) e nunca é enviada ao servidor. */

const b64u = {
  enc(bytes: Uint8Array): string {
    let s = '';
    for (const b of bytes) s += String.fromCharCode(b);
    return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  },
  dec(text: string): Uint8Array<ArrayBuffer> {
    const pad = text.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((text.length + 3) % 4);
    const bin = atob(pad);
    return Uint8Array.from(bin, (c) => c.charCodeAt(0));
  },
};

export async function encryptNote(plain: string): Promise<{ ciphertext: string; iv: string; key: string }> {
  const key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt']);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const data = new TextEncoder().encode(plain);
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, data));
  const raw = new Uint8Array(await crypto.subtle.exportKey('raw', key));
  return { ciphertext: b64u.enc(ct), iv: b64u.enc(iv), key: b64u.enc(raw) };
}

export async function decryptNote(ciphertext: string, iv: string, keyText: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', b64u.dec(keyText), { name: 'AES-GCM' }, false, ['decrypt']);
  const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: b64u.dec(iv) }, key, b64u.dec(ciphertext));
  return new TextDecoder().decode(plain);
}
