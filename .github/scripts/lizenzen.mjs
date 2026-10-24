#!/usr/bin/env node
// Lizenzprüfung der Laufzeit-Abhängigkeiten (ohne devDependencies). Ohne Netz, ohne Zusatzpakete.
// Erlaubt laut CONTRACT: MIT, Apache-2.0, BSD, ISC (plus gleichwertige freizügige); eigene Pakete AGPL-3.0-only.
// Ausdrücke mit OR genügen, wenn ein Zweig erlaubt ist; mit AND müssen alle Teile erlaubt sein.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ERLAUBT = new Set(['MIT', 'MIT-0', 'ISC', 'Apache-2.0', 'BSD-2-Clause', 'BSD-3-Clause', '0BSD', 'BlueOak-1.0.0', 'Zlib', 'CC0-1.0', 'Unlicense', 'Python-2.0', 'CC-BY-4.0',
  // Nicht-SPDX-Angabe "BSD" (z. B. duck, Abhängigkeit von mammoth): BSD-Familie, freizügig. Bei neuen Paketen von Hand prüfen.
  'BSD']);
const EIGEN = 'AGPL-3.0-only';

function erlaubt(ausdruck) {
  const s = String(ausdruck).replace(/[()]/g, ' ').trim();
  if (/\sOR\s/i.test(s)) return s.split(/\s+OR\s+/i).some(erlaubt);
  if (/\sAND\s/i.test(s)) return s.split(/\s+AND\s+/i).every(erlaubt);
  return ERLAUBT.has(s);
}

const pfade = execFileSync('npm', ['ls', '--omit=dev', '--all', '--parseable'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
  .split('\n').map((x) => x.trim()).filter(Boolean);
const fehler = [];
const zaehler = new Map();
for (const p of [...new Set(pfade)]) {
  let pkg;
  try { pkg = JSON.parse(readFileSync(join(p, 'package.json'), 'utf8')); } catch { continue; }
  if (!pkg.name) continue;
  const lic = typeof pkg.license === 'string' ? pkg.license : pkg.license?.type ?? (Array.isArray(pkg.licenses) ? pkg.licenses.map((l) => l.type ?? l).join(' OR ') : '');
  zaehler.set(lic || '(keine)', (zaehler.get(lic || '(keine)') ?? 0) + 1);
  const eigen = pkg.name.startsWith('@kern/') || pkg.name === 'kern';
  if (eigen ? lic !== EIGEN && !pkg.private : !erlaubt(lic)) fehler.push(`${pkg.name}@${pkg.version}: ${lic || '(keine Angabe)'}`);
  if (eigen && !lic) console.warn(`Hinweis: ${pkg.name} hat kein Lizenzfeld (erwartet ${EIGEN}).`);
  if (eigen && lic && lic !== EIGEN) fehler.push(`${pkg.name}: eigene Pakete müssen ${EIGEN} tragen (ist ${lic})`);
}
console.log('Lizenzen (Laufzeit):', Object.fromEntries([...zaehler].sort((a, b) => b[1] - a[1])));
if (fehler.length) {
  console.error(`Nicht erlaubte oder fehlende Lizenzen (${fehler.length}):\n  ${[...new Set(fehler)].join('\n  ')}`);
  process.exit(1);
}
console.log('Lizenzprüfung bestanden.');
