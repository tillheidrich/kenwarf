/**
 * Minimales tar (POSIX ustar mit pax-Kopf für lange Pfade), nur reguläre Dateien und Ordner. Eigene Umsetzung,
 * weil die verbreiteten npm-Pakete nicht unter MIT/Apache/BSD/ISC stehen. Lesen prüft Pfade (kein Ausbruch,
 * keine Links) und Größen.
 */
const BLOCK = 512;

function oktal(n: number, laenge: number): string {
  return n.toString(8).padStart(laenge - 1, '0') + '\0';
}

function kopf(name: string, groesse: number, typ: '0' | '5' | 'x', mtime: number): Buffer {
  const b = Buffer.alloc(BLOCK, 0);
  b.write(name.slice(0, 100), 0, 'utf8');
  b.write(oktal(typ === '5' ? 0o755 : 0o644, 8), 100);
  b.write(oktal(0, 8), 108);
  b.write(oktal(0, 8), 116);
  b.write(oktal(groesse, 12), 124);
  b.write(oktal(Math.floor(mtime / 1000), 12), 136);
  b.write('        ', 148);
  b.write(typ, 156);
  b.write('ustar\0', 257);
  b.write('00', 263);
  let summe = 0;
  for (const x of b) summe += x;
  b.write(oktal(summe, 7) + ' ', 148);
  return b;
}

function auffuellen(n: number): Buffer {
  const r = n % BLOCK;
  return r ? Buffer.alloc(BLOCK - r, 0) : Buffer.alloc(0);
}

/** tar aus einer Liste von Einträgen (Pfade mit `/`, Ordner enden auf `/`). */
export function packeTar(eintraege: { pfad: string; daten?: Buffer }[], mtime = Date.now()): Buffer {
  const teile: Buffer[] = [];
  for (const e of eintraege) {
    const ordner = e.pfad.endsWith('/');
    const daten = ordner ? Buffer.alloc(0) : e.daten ?? Buffer.alloc(0);
    if (Buffer.byteLength(e.pfad) > 99) {
      const rec = (k: string, v: string) => {
        const roh = ` ${k}=${v}\n`;
        let len = Buffer.byteLength(roh);
        let s = `${len}${roh}`;
        while (Buffer.byteLength(s) !== len) { len = Buffer.byteLength(s); s = `${len}${roh}`; }
        return s;
      };
      const pax = Buffer.from(rec('path', e.pfad));
      teile.push(kopf('PaxHeader', pax.length, 'x', mtime), pax, auffuellen(pax.length));
    }
    teile.push(kopf(e.pfad, daten.length, ordner ? '5' : '0', mtime), daten, auffuellen(daten.length));
  }
  teile.push(Buffer.alloc(BLOCK * 2, 0));
  return Buffer.concat(teile);
}

export class TarFehler extends Error {}

/** tar lesen: nur Dateien und Ordner, Pfade relativ ohne `..`, Summe höchstens `maxBytes`. */
export function lieseTar(tar: Buffer, maxBytes = 20 * 1024 * 1024 * 1024): { pfad: string; daten: Buffer }[] {
  const out: { pfad: string; daten: Buffer }[] = [];
  let pos = 0;
  let paxPfad: string | null = null;
  let summe = 0;
  while (pos + BLOCK <= tar.length) {
    const h = tar.subarray(pos, pos + BLOCK);
    if (h.every((x) => x === 0)) break;
    const name = h.subarray(0, 100).toString('utf8').replace(/\0.*$/s, '');
    const groesse = parseInt(h.subarray(124, 136).toString('ascii').replace(/\0.*$/s, '').trim() || '0', 8);
    const typ = String.fromCharCode(h[156]!) || '0';
    const praefix = h.subarray(345, 500).toString('utf8').replace(/\0.*$/s, '');
    if (!Number.isFinite(groesse) || groesse < 0) throw new TarFehler('tar beschädigt');
    const daten = tar.subarray(pos + BLOCK, pos + BLOCK + groesse);
    if (daten.length !== groesse) throw new TarFehler('tar abgeschnitten');
    pos += BLOCK + Math.ceil(groesse / BLOCK) * BLOCK;
    if (typ === 'x') {
      const m = /(?:^|\n)\d+ path=([^\n]*)\n/.exec(daten.toString('utf8'));
      paxPfad = m?.[1] ?? null;
      continue;
    }
    const pfad = (paxPfad ?? (praefix ? `${praefix}/${name}` : name)).replace(/^\.\//, '');
    paxPfad = null;
    if (typ === '5') continue;
    if (typ !== '0' && typ !== '\0') throw new TarFehler(`Nicht erlaubter Eintrag im Paket (Typ ${typ}): ${pfad}`);
    if (!pfad || pfad.startsWith('/') || pfad.split('/').some((t) => t === '..') || pfad.includes('\\') || pfad.includes('\0')) throw new TarFehler(`Unzulässiger Pfad im Paket: ${pfad}`);
    summe += groesse;
    if (summe > maxBytes) throw new TarFehler('Paket zu groß');
    out.push({ pfad, daten: Buffer.from(daten) });
  }
  return out;
}
