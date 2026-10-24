/**
 * Passkeys (WebAuthn) für die Konsole, CONTRACT v1.4 3.6. Ablauf: Erst-Admin per CLI mit Passwort und TOTP,
 * danach in der Konsole Passkey hinzufügen; ab dann Anmeldung mit Passkey (Nutzerprüfung Pflicht).
 * Passwort und TOTP bleiben Rückfallweg, abschaltbar mit `BETRIEB_NUR_PASSKEY=1`, sobald ein Passkey existiert.
 * Bibliothek: @simplewebauthn/server (MIT).
 */
import crypto from 'node:crypto';
import {
  generateAuthenticationOptions, generateRegistrationOptions, verifyAuthenticationResponse, verifyRegistrationResponse,
  type AuthenticationResponseJSON, type RegistrationResponseJSON, type WebAuthnCredential,
} from '@simplewebauthn/server';
import type { DB } from './db.js';

interface Gespeichert { id: string; publicKey: string; counter: number; transports?: string[]; name: string }

export class Passkeys {
  /** Offene Challenges, je 5 Minuten gültig, einmal verwendbar. */
  private challenges = new Map<string, { challenge: string; admin?: string; bis: number }>();
  constructor(private db: DB, private rp: { id: string; name: string; origin: string }) {}

  anzahl(admin?: string): number {
    return (this.db.prepare(`SELECT COUNT(*) AS n FROM passkeys ${admin ? 'WHERE admin = ?' : ''}`).get(...(admin ? [admin] : [])) as { n: number }).n;
  }
  liste(admin: string): { id: string; name: string; erstellt: string }[] {
    return (this.db.prepare('SELECT id, daten, erstellt FROM passkeys WHERE admin = ? ORDER BY erstellt').all(admin) as { id: string; daten: string; erstellt: string }[])
      .map((r) => ({ id: r.id, name: (JSON.parse(r.daten) as Gespeichert).name, erstellt: r.erstellt }));
  }
  entfernen(admin: string, id: string) { this.db.prepare('DELETE FROM passkeys WHERE admin = ? AND id = ?').run(admin, id); }

  private merke(challenge: string, admin?: string): string {
    const j = Date.now();
    for (const [k, v] of this.challenges) if (v.bis < j) this.challenges.delete(k);
    const schluessel = crypto.randomBytes(18).toString('base64url');
    this.challenges.set(schluessel, { challenge, ...(admin ? { admin } : {}), bis: j + 5 * 60_000 });
    return schluessel;
  }
  private nimm(schluessel: string) {
    const c = this.challenges.get(schluessel);
    this.challenges.delete(schluessel);
    if (!c || c.bis < Date.now()) throw new Error('Challenge abgelaufen');
    return c;
  }

  async registrierOptionen(admin: string) {
    const vorhanden = (this.db.prepare('SELECT daten FROM passkeys WHERE admin = ?').all(admin) as { daten: string }[]).map((r) => JSON.parse(r.daten) as Gespeichert);
    const o = await generateRegistrationOptions({
      rpName: this.rp.name, rpID: this.rp.id, userName: admin, userID: new TextEncoder().encode(`leitstand:${admin}`), attestationType: 'none',
      excludeCredentials: vorhanden.map((v) => ({ id: v.id, ...(v.transports ? { transports: v.transports as never } : {}) })),
      authenticatorSelection: { residentKey: 'required', userVerification: 'required' },
    });
    return { schluessel: this.merke(o.challenge, admin), optionen: o };
  }

  async registrieren(admin: string, schluessel: string, antwort: RegistrationResponseJSON, name: string) {
    const c = this.nimm(schluessel);
    if (c.admin !== admin) throw new Error('Challenge gehört zu anderem Admin');
    const v = await verifyRegistrationResponse({ response: antwort, expectedChallenge: c.challenge, expectedOrigin: this.rp.origin, expectedRPID: this.rp.id, requireUserVerification: true });
    if (!v.verified || !v.registrationInfo) throw new Error('Passkey nicht bestätigt');
    const k = v.registrationInfo.credential;
    const g: Gespeichert = { id: k.id, publicKey: Buffer.from(k.publicKey).toString('base64url'), counter: k.counter, ...(k.transports ? { transports: k.transports } : {}), name: name.slice(0, 60) || 'Passkey' };
    this.db.prepare('INSERT INTO passkeys (id, admin, daten, erstellt) VALUES (?, ?, ?, ?)').run(k.id, admin, JSON.stringify(g), new Date().toISOString());
    return { id: k.id };
  }

  async anmeldeOptionen() {
    const o = await generateAuthenticationOptions({ rpID: this.rp.id, userVerification: 'required' });
    return { schluessel: this.merke(o.challenge), optionen: o };
  }

  /** Liefert den Admin-Namen oder wirft. Zähler muss steigen (Klon-Erkennung), wenn der Authenticator einen führt. */
  async anmelden(schluessel: string, antwort: AuthenticationResponseJSON): Promise<string> {
    const c = this.nimm(schluessel);
    const r = this.db.prepare('SELECT admin, daten FROM passkeys WHERE id = ?').get(antwort.id) as { admin: string; daten: string } | undefined;
    if (!r) throw new Error('Passkey unbekannt');
    const g = JSON.parse(r.daten) as Gespeichert;
    const credential: WebAuthnCredential = { id: g.id, publicKey: new Uint8Array(Buffer.from(g.publicKey, 'base64url')), counter: g.counter, ...(g.transports ? { transports: g.transports } : {}) };
    const v = await verifyAuthenticationResponse({ response: antwort, expectedChallenge: c.challenge, expectedOrigin: this.rp.origin, expectedRPID: this.rp.id, credential, requireUserVerification: true });
    if (!v.verified) throw new Error('Passkey nicht bestätigt');
    this.db.prepare('UPDATE passkeys SET daten = ? WHERE id = ?').run(JSON.stringify({ ...g, counter: v.authenticationInfo.newCounter }), g.id);
    return r.admin;
  }
}
