/**
 * Gera apps/api/data/oui.json a partir do registro público de OUI do IEEE.
 * Uso: node infra/scripts/update-oui.mjs [caminho/do/oui.csv]
 * Sem argumento, baixa https://standards-oui.ieee.org/oui/oui.csv.
 * O arquivo gerado mapeia o prefixo (6, 7 ou 9 dígitos hex: MA-L, MA-M, MA-S) para o nome da organização.
 */
import { readFileSync, writeFileSync } from 'node:fs';

const src = process.argv[2];
const csv = src ? readFileSync(src, 'utf8') : await (await fetch('https://standards-oui.ieee.org/oui/oui.csv', { headers: { 'user-agent': 'iplogger-build' } })).text();

function parseCsv(text) {
  const rows = [];
  let row = [];
  let cell = '';
  let q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"' && text[i + 1] === '"') { cell += '"'; i++; }
      else if (c === '"') q = false;
      else cell += c;
    } else if (c === '"') q = true;
    else if (c === ',') { row.push(cell); cell = ''; }
    else if (c === '\n') { row.push(cell.replace(/\r$/, '')); rows.push(row); row = []; cell = ''; }
    else cell += c;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  return rows;
}

const map = {};
for (const [registry, assignment, org] of parseCsv(csv).slice(1)) {
  if (!registry || !assignment || !org) continue;
  if (!/^[0-9A-F]{6,9}$/i.test(assignment)) continue;
  map[assignment.toUpperCase()] = org.replace(/\s+/g, ' ').trim().slice(0, 120);
}
writeFileSync(new URL('../../apps/api/data/oui.json', import.meta.url), JSON.stringify(map));
console.log(`OUI: ${Object.keys(map).length} prefixos gravados`);
