import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

let table: Record<string, string> | null = null;

function load(): Record<string, string> {
  table ??= JSON.parse(readFileSync(fileURLToPath(new URL('../../data/oui.json', import.meta.url)), 'utf8')) as Record<string, string>;
  return table;
}

export interface MacInfo {
  input: string;
  normalized: string | null;
  vendor: string | null;
  /** true = endereço administrado localmente (típico de MAC aleatório de privacidade): o fabricante não se aplica. */
  locallyAdministered: boolean;
  multicast: boolean;
  matchedPrefix: string | null;
  valid: boolean;
}

/** Aceita "AA:BB:CC:DD:EE:FF", "AA-BB-CC", "aabb.ccdd.eeff" ou apenas o prefixo OUI (6+ hex). */
export function lookupMac(input: string, oui: Record<string, string> = load()): MacInfo {
  const raw = input.trim();
  const hex = raw.replace(/[:\-.\s]/g, '').toUpperCase();
  const base: MacInfo = { input: raw.slice(0, 40), normalized: null, vendor: null, locallyAdministered: false, multicast: false, matchedPrefix: null, valid: false };
  if (!/^[0-9A-F]{6,12}$/.test(hex) || /[^0-9A-Fa-f:\-.\s]/.test(raw)) return base;
  const firstOctet = parseInt(hex.slice(0, 2), 16);
  const pairs = hex.match(/.{1,2}/g) as string[];
  const info: MacInfo = {
    ...base,
    valid: true,
    normalized: pairs.join(':'),
    locallyAdministered: (firstOctet & 0x02) !== 0,
    multicast: (firstOctet & 0x01) !== 0,
  };
  for (const len of [9, 7, 6]) {
    const p = hex.slice(0, len);
    if (p.length === len && oui[p]) {
      info.vendor = oui[p]!;
      info.matchedPrefix = p;
      break;
    }
  }
  return info;
}
