/**
 * Versand des Postausgangs über SMTP (nodemailer). Kein US-SaaS als Standard: ohne Konfiguration wird nichts verschickt,
 * die Mails bleiben „vorgemerkt“. Vorgesehen ist das eigene Postfach (z. B. ALL-INKL oder ein selbst betriebener
 * Mailserver), Zugang nur aus der Umgebung:
 *   BETRIEB_SMTP_HOST, BETRIEB_SMTP_PORT (465 = TLS, 587 = STARTTLS Pflicht), BETRIEB_SMTP_USER, BETRIEB_SMTP_PASS,
 *   BETRIEB_MAIL_ABSENDER ("Kern <betrieb@…>"), BETRIEB_MAIL_ANTWORT (optional).
 *
 * Mails der Art „geheim“ (Einmal-Passwort, Schlüssel `geheim:…`) werden nach dem Versand im Postausgang geleert.
 * Fehlversuche: bis zu 5, mit wachsendem Abstand; danach „fehler“ und sichtbar in der Konsole.
 */
import nodemailer from 'nodemailer';
import type { DB } from '../db.js';

export interface SmtpEinstellung { host: string; port: number; user?: string; pass?: string; absender: string; antwort?: string; tlsUnsicherNurTest?: boolean }

export function smtpAusUmgebung(env: NodeJS.ProcessEnv = process.env): SmtpEinstellung | null {
  if (!env.BETRIEB_SMTP_HOST || !env.BETRIEB_MAIL_ABSENDER) return null;
  return { host: env.BETRIEB_SMTP_HOST, port: Number(env.BETRIEB_SMTP_PORT ?? 587), ...(env.BETRIEB_SMTP_USER ? { user: env.BETRIEB_SMTP_USER } : {}), ...(env.BETRIEB_SMTP_PASS ? { pass: env.BETRIEB_SMTP_PASS } : {}), absender: env.BETRIEB_MAIL_ABSENDER, ...(env.BETRIEB_MAIL_ANTWORT ? { antwort: env.BETRIEB_MAIL_ANTWORT } : {}) };
}

export interface Sender { senden(m: { an: string; betreff: string; text: string; kopf?: Record<string, string> }): Promise<{ id: string }> }

export class SmtpSender implements Sender {
  private t: ReturnType<typeof nodemailer.createTransport>;
  constructor(private e: SmtpEinstellung) {
    this.t = nodemailer.createTransport({
      host: e.host, port: e.port, secure: e.port === 465, requireTLS: e.port !== 465 && !e.tlsUnsicherNurTest,
      ...(e.user ? { auth: { user: e.user, pass: e.pass ?? '' } } : {}),
      ...(e.tlsUnsicherNurTest ? { ignoreTLS: true } : {}),
      connectionTimeout: 15_000, socketTimeout: 30_000,
    });
  }
  async senden(m: { an: string; betreff: string; text: string; kopf?: Record<string, string> }) {
    const r = await this.t.sendMail({ from: this.e.absender, to: m.an, subject: m.betreff, text: m.text, ...(this.e.antwort ? { replyTo: this.e.antwort } : {}), headers: { 'Auto-Submitted': 'auto-generated', ...m.kopf } });
    return { id: String(r.messageId ?? '') };
  }
}

function spalten(db: DB) {
  const da = new Set((db.prepare('PRAGMA table_info(postausgang)').all() as { name: string }[]).map((c) => c.name));
  if (!da.has('versuche')) db.exec('ALTER TABLE postausgang ADD COLUMN versuche INTEGER NOT NULL DEFAULT 0');
  if (!da.has('naechster')) db.exec('ALTER TABLE postausgang ADD COLUMN naechster TEXT');
  if (!da.has('meldung')) db.exec('ALTER TABLE postausgang ADD COLUMN meldung TEXT');
  if (!da.has('kopf')) db.exec('ALTER TABLE postausgang ADD COLUMN kopf TEXT');
}

export const MAX_VERSUCHE = 5;

/** Ein Durchlauf: alles Fällige verschicken. Liefert Zähler (nie Inhalte). */
export async function versendePostausgang(db: DB, s: Sender, jetzt: Date = new Date()): Promise<{ versendet: number; fehler: number; wartet: number }> {
  spalten(db);
  const faellig = db.prepare("SELECT id, schluessel, an, betreff, text, versuche, kopf FROM postausgang WHERE status IN ('vorgemerkt', 'wiederholen') AND (naechster IS NULL OR naechster <= ?) ORDER BY id LIMIT 200").all(jetzt.toISOString()) as { id: number; schluessel: string | null; an: string; betreff: string; text: string; versuche: number; kopf: string | null }[];
  let versendet = 0, fehler = 0, wartet = 0;
  for (const m of faellig) {
    try {
      await s.senden({ an: m.an, betreff: m.betreff, text: m.text, ...(m.kopf ? { kopf: JSON.parse(m.kopf) as Record<string, string> } : {}) });
      const geheim = m.schluessel?.startsWith('geheim:');
      db.prepare(`UPDATE postausgang SET status = 'versendet', meldung = ?, versuche = versuche + 1${geheim ? ", text = '[nach Versand geleert]'" : ''} WHERE id = ?`).run(jetzt.toISOString(), m.id);
      versendet++;
    } catch (e) {
      const n = m.versuche + 1;
      const endgueltig = n >= MAX_VERSUCHE;
      db.prepare('UPDATE postausgang SET status = ?, versuche = ?, naechster = ?, meldung = ? WHERE id = ?')
        .run(endgueltig ? 'fehler' : 'wiederholen', n, new Date(jetzt.getTime() + 5 * 60_000 * 2 ** (n - 1)).toISOString(), (e as Error).message.slice(0, 200), m.id);
      if (endgueltig) fehler++; else wartet++;
    }
  }
  return { versendet, fehler, wartet };
}
