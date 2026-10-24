import fs from 'node:fs';
import path from 'node:path';

/**
 * v1.4 4.1: Zustand des Einrichtungsassistenten in `.kern/einrichtung.json` (nicht git, nie an HD).
 * `start` ist der erste Start dieser Instanz mit dem Assistenten; `erste_belegte_antwort` misst die Zeit bis
 * zur ersten Antwort mit Status `beantwortet` und mindestens einem Beleg (R4 M1, W27: verlässt die Instanz nie).
 */
export interface EinrichtungsStand {
  start: string;
  fertig: string | null;
  erste_belegte_antwort: { am: string; sekunden_seit_start: number } | null;
}

export class Einrichtungszustand {
  private datei: string;
  private s: EinrichtungsStand;
  constructor(dataDir: string, bestandVorhanden: () => boolean) {
    this.datei = path.join(dataDir, '.kern', 'einrichtung.json');
    let roh: Partial<EinrichtungsStand> | null = null;
    try { roh = JSON.parse(fs.readFileSync(this.datei, 'utf8')) as Partial<EinrichtungsStand>; } catch { /* neu */ }
    if (roh?.start) {
      this.s = { start: roh.start, fertig: roh.fertig ?? null, erste_belegte_antwort: roh.erste_belegte_antwort ?? null };
    } else {
      const jetzt = new Date().toISOString();
      // Bestehende Installationen mit Wissen bekommen den Assistenten nicht noch einmal.
      this.s = { start: jetzt, fertig: bestandVorhanden() ? jetzt : null, erste_belegte_antwort: null };
      this.speichere();
    }
  }
  get stand(): EinrichtungsStand { return this.s; }
  private speichere() {
    try {
      fs.mkdirSync(path.dirname(this.datei), { recursive: true });
      fs.writeFileSync(this.datei, JSON.stringify(this.s, null, 2), { mode: 0o600 });
    } catch { /* Lesezugriff: Zustand bleibt im Speicher */ }
  }
  fertig() { if (!this.s.fertig) { this.s.fertig = new Date().toISOString(); this.speichere(); } }
  /** Nach jeder Antwort aufrufen; merkt sich nur die erste belegte. */
  antwort(a: { status?: string; belege?: unknown[] }) {
    if (this.s.erste_belegte_antwort || a.status !== 'beantwortet' || !a.belege?.length) return;
    const am = new Date();
    this.s.erste_belegte_antwort = { am: am.toISOString(), sekunden_seit_start: Math.max(0, Math.round((am.getTime() - Date.parse(this.s.start)) / 1000)) };
    this.speichere();
  }
}

/** Rückfall für Vorschlagsfragen (4.1): aus Überschriften der neuesten sichtbaren Quellen, deterministisch, höchstens 3. */
export function fragenAusQuellen(quellen: { pfad: string; kopf: { titel?: string; erfasst_am?: string }; text: string }[]): string[] {
  const sortiert = [...quellen].sort((a, b) => String(b.kopf.erfasst_am ?? '').localeCompare(String(a.kopf.erfasst_am ?? '')) || a.pfad.localeCompare(b.pfad));
  const out: string[] = [];
  for (const q of sortiert) {
    for (const z of q.text.split('\n')) {
      const m = /^#{1,3}\s+(.{3,80}?)\s*#*\s*$/.exec(z.trim());
      if (!m) continue;
      const t = m[1]!.replace(/[*_`[\]]/g, '').trim();
      if (!t || /^(inhalt|einleitung|übersicht|anhang)$/i.test(t)) continue;
      const f = `Was steht zu „${t}“ drin?`;
      if (!out.includes(f)) out.push(f);
      if (out.length >= 3) return out;
    }
  }
  return out;
}
