import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

/**
 * v1.4 5.2: KI-Schlüssel verschlüsselt in `.kern/geheimnisse.json` (AES-256-GCM).
 * Schlüssel nur aus der Umgebung (`KERN_GEHEIMNIS_SCHLUESSEL`, im Managed-Betrieb vom Leitstand gesetzt).
 * Nicht im git (.kern/), nicht im Export, nicht im Umzugspaket. Werte werden nie zurückgegeben.
 */
interface Eintrag { iv: string; tag: string; daten: string; am: string }

function schluessel(geheimnis: string): Buffer {
  return Buffer.from(crypto.hkdfSync('sha256', Buffer.from(geheimnis, 'utf8'), Buffer.alloc(0), Buffer.from('kern/geheimnisse/v1'), 32));
}

export class Geheimnisse {
  private datei: string;
  constructor(dataDir: string, private geheimnis: string | null) {
    this.datei = path.join(dataDir, '.kern', 'geheimnisse.json');
  }
  get verfuegbar(): boolean { return !!this.geheimnis && this.geheimnis.length >= 32; }

  private lade(): Record<string, Eintrag> {
    try { return JSON.parse(fs.readFileSync(this.datei, 'utf8')) as Record<string, Eintrag>; } catch { return {}; }
  }

  setze(name: string, wert: string): void {
    if (!this.verfuegbar) throw new Error('KERN_GEHEIMNIS_SCHLUESSEL fehlt oder ist kürzer als 32 Zeichen.');
    const iv = crypto.randomBytes(12);
    const c = crypto.createCipheriv('aes-256-gcm', schluessel(this.geheimnis!), iv);
    c.setAAD(Buffer.from(name));
    const daten = Buffer.concat([c.update(wert, 'utf8'), c.final()]);
    const alle = this.lade();
    alle[name] = { iv: iv.toString('base64'), tag: c.getAuthTag().toString('base64'), daten: daten.toString('base64'), am: new Date().toISOString() };
    fs.mkdirSync(path.dirname(this.datei), { recursive: true });
    const tmp = `${this.datei}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(alle, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, this.datei);
  }

  hole(name: string): string | undefined {
    if (!this.verfuegbar) return undefined;
    const e = this.lade()[name];
    if (!e) return undefined;
    try {
      const d = crypto.createDecipheriv('aes-256-gcm', schluessel(this.geheimnis!), Buffer.from(e.iv, 'base64'));
      d.setAAD(Buffer.from(name));
      d.setAuthTag(Buffer.from(e.tag, 'base64'));
      return Buffer.concat([d.update(Buffer.from(e.daten, 'base64')), d.final()]).toString('utf8');
    } catch {
      return undefined; // falscher Schlüssel oder manipuliert
    }
  }

  loesche(name: string): boolean {
    const alle = this.lade();
    if (!(name in alle)) return false;
    delete alle[name];
    fs.writeFileSync(this.datei, JSON.stringify(alle, null, 2), { mode: 0o600 });
    return true;
  }

  namen(): string[] { return Object.keys(this.lade()); }
}
