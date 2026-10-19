import { promises as dns } from 'node:dns';
import { sanitizeText } from '@ipl/shared';

/** DNS reverso com timeout curto (contexto apenas: não prova propriedade do IP). */
export async function reverseDnsLookup(ip: string, timeoutMs = 2000): Promise<string | null> {
  try {
    const names = await Promise.race([
      dns.reverse(ip),
      new Promise<string[]>((_, reject) => setTimeout(() => reject(new Error('timeout')), timeoutMs).unref()),
    ]);
    return sanitizeText(names[0] ?? null, 253);
  } catch {
    return null;
  }
}
