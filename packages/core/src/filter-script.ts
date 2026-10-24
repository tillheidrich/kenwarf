/**
 * Index-Filter für `git filter-branch` (Art. 17 DSGVO): wird je Commit mit node ausgeführt.
 * Umgebung: KERN_ENTFERNEN (JSON: Pfade, exakt oder als Präfix bei `.orig.`), KERN_ERSETZEN (JSON: Zeichenketten, die in
 * index.md/log.md/eingang-JSON durch „[gelöscht]“ ersetzt werden). Eingangs-Dateien, die einen der Pfade nennen, werden entfernt.
 */
export const FILTER_SKRIPT = String.raw`
const { execFileSync } = require('node:child_process');
const entfernen = JSON.parse(process.env.KERN_ENTFERNEN || '[]');
const ersetzen = JSON.parse(process.env.KERN_ERSETZEN || '[]').filter((s) => s && s.length >= 3);
const git = (args, input) => execFileSync('git', args, { input, maxBuffer: 1 << 28 });
const ls = git(['ls-files', '-s', '-z']).toString('utf8').split('\0').filter(Boolean);
const raus = [];
for (const z of ls) {
  const tab = z.indexOf('\t');
  const [mode, sha] = z.slice(0, tab).split(' ');
  const p = z.slice(tab + 1);
  const basis = (x) => x.replace(/\.md$/, '');
  if (entfernen.some((e) => p === e || p.startsWith(basis(e) + '.orig.'))) { raus.push(p); continue; }
  const pruefe = /\.md$/.test(p) || /^eingang\/.*\.json$/.test(p);
  if (!pruefe) continue;
  let inhalt = git(['cat-file', 'blob', sha]).toString('utf8');
  if (p.startsWith('eingang/') && entfernen.some((e) => inhalt.includes(e))) { raus.push(p); continue; }
  let neu = inhalt;
  if (/(^|\/)(index|log)\.md$/.test(p)) neu = neu.split('\n').filter((z) => !entfernen.some((e) => z.includes(e))).join('\n');
  // S1 M6: Titel nur in index.md, log.md und eingang/ ersetzen, nie in fremden Artikeln oder Quellen
  if (/(^|\/)(index|log)\.md$/.test(p) || p.startsWith('eingang/')) for (const s of ersetzen) neu = neu.split(s).join('[gelöscht]');
  if (neu !== inhalt) {
    const h = git(['hash-object', '-w', '--stdin'], neu).toString().trim();
    git(['update-index', '--cacheinfo', mode + ',' + h + ',' + p]);
  }
}
if (raus.length) git(['rm', '-q', '--cached', '--ignore-unmatch', '--', ...raus]);
`;

export const MSG_SKRIPT = String.raw`
const ersetzen = JSON.parse(process.env.KERN_ERSETZEN || '[]').filter((s) => s && s.length >= 3);
let s = '';
process.stdin.on('data', (d) => (s += d)).on('end', () => { for (const x of ersetzen) s = s.split(x).join('[gelöscht]'); process.stdout.write(s); });
`;
