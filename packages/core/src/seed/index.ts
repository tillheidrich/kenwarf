/**
 * Beispielbetrieb „Tischlerei Wendt GmbH“ (erfunden, Musterhude). Alle Namen, Zahlen und Lieferanten sind ausgedacht.
 * Inhalte stammen aus dem Wissensordner-Vorführstück von Heidrich Digital (block2b), umgebaut auf das Kern-Datenformat.
 */
import { existsSync } from 'node:fs';
import { cp, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Kern } from '../kern.js';
import type { KernConfig, ProviderConfig, Rolle, User } from '../types.js';

export const DEMO_PASSWORT = 'demo-passwort';

/** Demo-Zugänge (nur für Vorführungen; Passwort für alle: `demo-passwort`). */
export const DEMO_BENUTZER: { name: string; rollen: Rolle[]; teams: string[]; rolle: string }[] = [
  { name: 'Jörn Wendt', rollen: ['admin'], teams: ['buero', 'werkstatt'], rolle: 'Inhaber' },
  { name: 'Sabine Kröger', rollen: ['freigeber'], teams: ['buero'], rolle: 'Büro' },
  { name: 'Malte Ohlsen', rollen: ['freigeber'], teams: ['werkstatt'], rolle: 'Meister' },
  { name: 'Kai Brandes', rollen: ['autor'], teams: ['werkstatt'], rolle: 'Geselle, Ausbilder' },
  { name: 'Lena Meyer', rollen: ['leser'], teams: ['werkstatt'], rolle: 'Auszubildende' },
];

export function seedInhaltOrdner(): string {
  return fileURLToPath(new URL('./inhalt/', import.meta.url));
}

/**
 * Legt den Beispielbetrieb in `dataDir` an (nur, wenn dort noch kein Wissen liegt): Artikel, Quellen, Regel-Datei,
 * Faktenblatt, Benutzer, zwei offene Vorschläge im Eingang. Öffnet und schließt Kern selbst.
 */
export async function seedDemo(
  dataDir: string,
  opt: { provider?: ProviderConfig; heute?: () => Date; produktname?: string; vektoren?: boolean } = {},
): Promise<{ dataDir: string; benutzer: { name: string; passwort: string; rollen: Rolle[]; teams: string[] }[]; artikel: number; quellen: number; vorschlaege: number }> {
  const cfg: KernConfig = {
    dataDir,
    provider: opt.provider ?? { art: 'mock' },
    betrieb: 'Tischlerei Wendt GmbH (Beispiel)',
    sprache: 'de',
    ...(opt.heute ? { heute: opt.heute } : {}),
    ...(opt.produktname ? { produktname: opt.produktname } : {}),
    ...(opt.vektoren !== undefined ? { vektoren: opt.vektoren } : {}),
  };
  const wissen = join(dataDir, 'wissen');
  const leer = !existsSync(wissen) || (await readdir(wissen)).filter((x) => !x.startsWith('.') && x !== 'index.md' && x !== 'log.md').length === 0;
  const kern = await Kern.open(cfg);
  try {
    const vorhanden = await kern.benutzer.liste();
    const benutzer: User[] = [];
    for (const b of DEMO_BENUTZER) {
      benutzer.push(vorhanden.find((x) => x.name === b.name) ?? (await kern.benutzer.anlegen(b.name, DEMO_PASSWORT, b.rollen, b.teams)));
    }
    let vorschlaege = 0;
    if (leer) {
      await cp(seedInhaltOrdner(), dataDir, { recursive: true, force: false, errorOnExist: false });
      await kern.uebernimmAenderungen('Jörn Wendt', 'Beispielbetrieb Tischlerei Wendt angelegt');
      const malte = benutzer.find((b) => b.name === 'Malte Ohlsen')!;
      const kai = benutzer.find((b) => b.name === 'Kai Brandes')!;
      vorschlaege += (await kern.kompiliere(malte, 'quellen/2026/notiz-lackraum-lueftung.md')).length;
      vorschlaege += (await kern.kompiliere(kai, 'quellen/2026/notiz-lieferzeit-beschlaege.md')).length;
    }
    const admin = benutzer[0]!;
    return {
      dataDir,
      benutzer: DEMO_BENUTZER.map((b) => ({ name: b.name, passwort: DEMO_PASSWORT, rollen: b.rollen, teams: b.teams })),
      artikel: (await kern.listeWissen(admin)).length,
      quellen: (await kern.listeQuellen(admin)).length,
      vorschlaege,
    };
  } finally {
    await kern.schliesse();
  }
}
