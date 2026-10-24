import fs from 'node:fs';
import path from 'node:path';

/**
 * D-L5: Sicherheitsprotokoll ohne Lesedaten. JSON-Zeilen in `.kern/protokoll/sicherheit-<yyyy-mm>.jsonl`.
 * Nur Ereignisse rund um Anmeldung und Verwaltung. Nie Pfade von Inhalten, Fragen, Suchbegriffe oder Lesevorgänge
 * (§ 87 Abs. 1 Nr. 6 BetrVG). Aufbewahrung 90 Tage, nur für Admins lesbar, nicht im git (.kern/), nicht im Export.
 */
export type SicherheitsEreignis =
  | 'anmeldung' | 'fehlversuch' | 'sperre' | 'abmeldung' | 'abmeldung_ueberall' | 'geraet_abgemeldet'
  | 'passwort_geaendert' | 'passwort_zurueckgesetzt' | 'entsperrt'
  | 'zugang_erzeugt' | 'zugang_widerrufen' | 'oauth_zustimmung' | 'oauth_widerruf' | 'oauth_client_registriert'
  | 'benutzer_angelegt' | 'benutzer_geaendert' | 'einstellungen' | 'ki_schluessel'
  | 'export' | 'loeschen_endgueltig' | 'modus' | 'betrieb_zugriff_abgelehnt';

export interface SicherheitsEintrag {
  am: string;
  ereignis: SicherheitsEreignis;
  /** Benutzer-ID des Handelnden (nicht der Name), bei Fehlversuchen null. */
  benutzer: string | null;
  /** Ziel als ID (Benutzer-ID, Token-ID, Client-ID), nie ein Inhaltspfad. */
  ziel?: string;
  ergebnis: 'ok' | 'abgelehnt' | 'fehler';
  /** IP gekürzt: IPv4 /24, IPv6 /48. */
  ip_kurz?: string;
}

const AUFBEWAHRUNG_TAGE = 90;

export function kuerzeIp(ip: string | undefined): string | undefined {
  if (!ip || ip === 'lokal') return undefined;
  const v4 = /^(?:::ffff:)?(\d+)\.(\d+)\.(\d+)\.\d+$/.exec(ip);
  if (v4) return `${v4[1]}.${v4[2]}.${v4[3]}.0/24`;
  if (ip.includes(':')) return `${ip.split(':').slice(0, 3).join(':')}::/48`;
  return undefined;
}

export class Sicherheitsprotokoll {
  private ordner: string;
  private zuletztAufgeraeumt = 0;
  constructor(dataDir: string) {
    this.ordner = path.join(dataDir, '.kern', 'protokoll');
  }

  schreibe(e: Omit<SicherheitsEintrag, 'am'> & { am?: string }): void {
    const eintrag: SicherheitsEintrag = { am: e.am ?? new Date().toISOString(), ereignis: e.ereignis, benutzer: e.benutzer, ergebnis: e.ergebnis, ...(e.ziel ? { ziel: e.ziel } : {}), ...(e.ip_kurz ? { ip_kurz: e.ip_kurz } : {}) };
    try {
      fs.mkdirSync(this.ordner, { recursive: true, mode: 0o700 });
      fs.appendFileSync(path.join(this.ordner, `sicherheit-${eintrag.am.slice(0, 7)}.jsonl`), `${JSON.stringify(eintrag)}\n`, { mode: 0o600 });
      if (Date.now() - this.zuletztAufgeraeumt > 3600_000) this.aufraeumen();
    } catch {
      // Protokoll darf den Betrieb nie stören.
    }
  }

  lies(seit?: string): SicherheitsEintrag[] {
    if (!fs.existsSync(this.ordner)) return [];
    const grenze = seit ?? new Date(Date.now() - AUFBEWAHRUNG_TAGE * 86400_000).toISOString();
    const out: SicherheitsEintrag[] = [];
    for (const f of fs.readdirSync(this.ordner).filter((x) => /^sicherheit-\d{4}-\d{2}\.jsonl$/.test(x)).sort()) {
      if (f.slice(11, 18) < grenze.slice(0, 7)) continue;
      for (const z of fs.readFileSync(path.join(this.ordner, f), 'utf8').split('\n')) {
        if (!z) continue;
        try { const e = JSON.parse(z) as SicherheitsEintrag; if (e.am >= grenze) out.push(e); } catch { /* defekte Zeile */ }
      }
    }
    return out;
  }

  /** Entfernt Einträge älter als 90 Tage (ganze Monatsdateien und Zeilen in der Grenzdatei). */
  aufraeumen(): void {
    this.zuletztAufgeraeumt = Date.now();
    if (!fs.existsSync(this.ordner)) return;
    const grenze = new Date(Date.now() - AUFBEWAHRUNG_TAGE * 86400_000).toISOString();
    for (const f of fs.readdirSync(this.ordner).filter((x) => /^sicherheit-\d{4}-\d{2}\.jsonl$/.test(x))) {
      const monat = f.slice(11, 18);
      const datei = path.join(this.ordner, f);
      if (monat < grenze.slice(0, 7)) { fs.rmSync(datei, { force: true }); continue; }
      if (monat === grenze.slice(0, 7)) {
        const rest = fs.readFileSync(datei, 'utf8').split('\n').filter((z) => { try { return z && (JSON.parse(z) as SicherheitsEintrag).am >= grenze; } catch { return false; } });
        fs.writeFileSync(datei, rest.length ? `${rest.join('\n')}\n` : '', { mode: 0o600 });
      }
    }
  }
}

/** Für core oder CLI: einen Eintrag direkt schreiben. */
export function protokolliere(dataDir: string, e: Omit<SicherheitsEintrag, 'am'>): void {
  new Sicherheitsprotokoll(dataDir).schreibe(e);
}
