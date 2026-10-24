import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

/**
 * Schreibt ein ZIP-Archiv (Deflate) ohne fremde Abhängigkeit.
 * Grenzen: kein ZIP64, also höchstens 65.535 Einträge und je Datei unter 4 GB.
 */
export interface ZipErgebnis { dateien: number; bytes: number; }

function dosZeit(d: Date): { zeit: number; datum: number } {
  const jahr = Math.max(d.getFullYear(), 1980);
  return {
    zeit: (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2),
    datum: ((jahr - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
  };
}

export function sammleDateien(basis: string, ausschliessen: (rel: string) => boolean): string[] {
  const out: string[] = [];
  const geh = (rel: string) => {
    const abs = path.join(basis, rel);
    for (const e of fs.readdirSync(abs, { withFileTypes: true })) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (ausschliessen(r)) continue;
      if (e.isDirectory()) geh(r);
      else if (e.isFile()) out.push(r);
      // symbolische Links werden bewusst nicht verfolgt
    }
  };
  geh('');
  return out.sort();
}

export function schreibeZip(basis: string, dateien: string[], ziel: string): ZipErgebnis {
  if (dateien.length > 0xffff) throw new Error('Zu viele Dateien für ZIP ohne ZIP64 (höchstens 65.535).');
  const fd = fs.openSync(ziel, 'w');
  let versatz = 0;
  const zentral: Buffer[] = [];
  const schreibe = (b: Buffer) => { fs.writeSync(fd, b); versatz += b.length; };
  try {
    for (const rel of dateien) {
      const abs = path.join(basis, rel);
      const st = fs.statSync(abs);
      if (st.size >= 0xffffffff) throw new Error(`Datei zu groß für ZIP ohne ZIP64: ${rel}`);
      const roh = fs.readFileSync(abs);
      const komprimiert = zlib.deflateRawSync(roh, { level: 6 });
      const nutzeDeflate = komprimiert.length < roh.length;
      const daten = nutzeDeflate ? komprimiert : roh;
      const crc = zlib.crc32(roh) >>> 0;
      const name = Buffer.from(rel, 'utf8');
      const { zeit, datum } = dosZeit(st.mtime);
      const lokal = Buffer.alloc(30);
      lokal.writeUInt32LE(0x04034b50, 0);
      lokal.writeUInt16LE(20, 4);
      lokal.writeUInt16LE(0x0800, 6); // UTF-8-Namen
      lokal.writeUInt16LE(nutzeDeflate ? 8 : 0, 8);
      lokal.writeUInt16LE(zeit, 10);
      lokal.writeUInt16LE(datum, 12);
      lokal.writeUInt32LE(crc, 14);
      lokal.writeUInt32LE(daten.length, 18);
      lokal.writeUInt32LE(roh.length, 22);
      lokal.writeUInt16LE(name.length, 26);
      lokal.writeUInt16LE(0, 28);
      const kopfVersatz = versatz;
      schreibe(lokal);
      schreibe(name);
      schreibe(daten);
      const z = Buffer.alloc(46);
      z.writeUInt32LE(0x02014b50, 0);
      z.writeUInt16LE(0x031e, 4); // Unix, Version 3.0
      z.writeUInt16LE(20, 6);
      z.writeUInt16LE(0x0800, 8);
      z.writeUInt16LE(nutzeDeflate ? 8 : 0, 10);
      z.writeUInt16LE(zeit, 12);
      z.writeUInt16LE(datum, 14);
      z.writeUInt32LE(crc, 16);
      z.writeUInt32LE(daten.length, 20);
      z.writeUInt32LE(roh.length, 24);
      z.writeUInt16LE(name.length, 28);
      z.writeUInt16LE(0, 30);
      z.writeUInt16LE(0, 32);
      z.writeUInt16LE(0, 34);
      z.writeUInt16LE(0, 36);
      z.writeUInt32LE(((st.mode & 0o777) | 0o100000) << 16 >>> 0, 38);
      z.writeUInt32LE(kopfVersatz, 42);
      zentral.push(z, name);
    }
    const zStart = versatz;
    const zDaten = Buffer.concat(zentral);
    schreibe(zDaten);
    const ende = Buffer.alloc(22);
    ende.writeUInt32LE(0x06054b50, 0);
    ende.writeUInt16LE(dateien.length, 8);
    ende.writeUInt16LE(dateien.length, 10);
    ende.writeUInt32LE(zDaten.length, 12);
    ende.writeUInt32LE(zStart, 16);
    schreibe(ende);
  } finally {
    fs.closeSync(fd);
  }
  return { dateien: dateien.length, bytes: versatz };
}

/** Liest die Namen aus dem zentralen Verzeichnis (für Tests und `kern export --pruefen`). */
export function leseZipNamen(datei: string): string[] {
  const b = fs.readFileSync(datei);
  const e = b.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  if (e < 0) throw new Error('Kein ZIP-Archiv.');
  const anzahl = b.readUInt16LE(e + 10);
  let p = b.readUInt32LE(e + 16);
  const namen: string[] = [];
  for (let i = 0; i < anzahl; i++) {
    const nl = b.readUInt16LE(p + 28);
    const xl = b.readUInt16LE(p + 30);
    const kl = b.readUInt16LE(p + 32);
    namen.push(b.subarray(p + 46, p + 46 + nl).toString('utf8'));
    p += 46 + nl + xl + kl;
  }
  return namen;
}
