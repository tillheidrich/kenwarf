/**
 * Geheimnisse je Instanz im Leitstand (Sitzungsschlüssel, Betriebs-Token, Egress-Token, Konto-Token), verschlüsselt mit
 * AES-256-GCM. Der Schlüssel kommt nur aus der Umgebung (`BETRIEB_GEHEIMNIS_SCHLUESSEL`, 32 Byte hex oder base64),
 * nie aus der Datenbank. Der Leitstand braucht das Betriebs-Token im Klartext, um /_betrieb/* aufzurufen; die Instanz
 * vergleicht nur den Hash.
 */
import crypto from 'node:crypto';
import type { DB } from './db.js';

export interface InstanzGeheimnisse { secret: string; betrieb_token: string; egress_token: string; konto_token?: string; rueckruf_token_sha256?: string; /** Verwaltungstoken des kern-egress auf einer eigenen Maschine. */ egress_admin?: string }

export class Geheimnisse {
  private schluessel: Buffer;
  constructor(private db: DB, schluessel: string | Buffer) {
    const k = Buffer.isBuffer(schluessel) ? schluessel : /^[0-9a-f]{64}$/i.test(schluessel) ? Buffer.from(schluessel, 'hex') : Buffer.from(schluessel, 'base64');
    if (k.length !== 32) throw new Error('BETRIEB_GEHEIMNIS_SCHLUESSEL muss 32 Byte haben');
    this.schluessel = k;
    db.exec('CREATE TABLE IF NOT EXISTS geheimnisse (instanz_id TEXT PRIMARY KEY, iv TEXT NOT NULL, tag TEXT NOT NULL, daten TEXT NOT NULL)');
  }
  static zufall(): string { return crypto.randomBytes(32).toString('hex'); }

  hole(id: string): InstanzGeheimnisse | null {
    const r = this.db.prepare('SELECT iv, tag, daten FROM geheimnisse WHERE instanz_id = ?').get(id) as { iv: string; tag: string; daten: string } | undefined;
    if (!r) return null;
    const d = crypto.createDecipheriv('aes-256-gcm', this.schluessel, Buffer.from(r.iv, 'base64'));
    d.setAAD(Buffer.from(id));
    d.setAuthTag(Buffer.from(r.tag, 'base64'));
    return JSON.parse(Buffer.concat([d.update(Buffer.from(r.daten, 'base64')), d.final()]).toString('utf8')) as InstanzGeheimnisse;
  }
  setze(id: string, g: InstanzGeheimnisse) {
    const iv = crypto.randomBytes(12);
    const c = crypto.createCipheriv('aes-256-gcm', this.schluessel, iv);
    c.setAAD(Buffer.from(id));
    const daten = Buffer.concat([c.update(JSON.stringify(g), 'utf8'), c.final()]);
    this.db.prepare('INSERT INTO geheimnisse VALUES (?, ?, ?, ?) ON CONFLICT(instanz_id) DO UPDATE SET iv = excluded.iv, tag = excluded.tag, daten = excluded.daten')
      .run(id, iv.toString('base64'), c.getAuthTag().toString('base64'), daten.toString('base64'));
  }
  /** Legt fehlende Werte an, lässt vorhandene stehen (Schritt muss wiederholbar sein). */
  sichere(id: string, extra: Partial<InstanzGeheimnisse> = {}): InstanzGeheimnisse {
    const alt = this.hole(id);
    const g: InstanzGeheimnisse = { ...alt, secret: alt?.secret ?? Geheimnisse.zufall(), betrieb_token: alt?.betrieb_token ?? Geheimnisse.zufall(), egress_token: alt?.egress_token ?? Geheimnisse.zufall(), ...extra };
    this.setze(id, g);
    return g;
  }
  loesche(id: string) { this.db.prepare('DELETE FROM geheimnisse WHERE instanz_id = ?').run(id); }
}

export const sha256 = (s: string) => crypto.createHash('sha256').update(s).digest('hex');
