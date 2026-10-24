/**
 * v1.4 Abschnitt 9: Kontextbilanz, zugleich der Wert-Bericht (M1). Messen ohne Beobachten (R4 Grundsatz 1):
 * nur Zahlen aus Dateien, git, Eingang, Fakten und den Tageszählern in `.kern/zaehler.sqlite`. Keine Fragen, keine Namen,
 * keine Benutzer-IDs, keine Kennzahl je Person. Nichts davon verlässt die Instanz (kein MCP-Werkzeug, nie an den Leitstand).
 * Reichweite: was der Aufrufende sehen darf (freigeber, admin).
 */
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Kern } from './kern.js';
import { brauchtRolle, darfSehen, hatRolle } from './rechte.js';
import type { KiStatus, PruefbankLauf } from './pruefbank.js';
import type { User, Vorschlag } from './types.js';
import { parseMarkdown } from './util.js';

export interface KontextStufe {
  nr: 1 | 2 | 3 | 4 | 5 | 6;
  name: string;
  /** gemessen: Zahlen unten belegen die Stufe; fahrplan: Engine trägt die Stufe noch nicht (CONTRACT v1.4 14). */
  status: 'gemessen' | 'teilweise' | 'fahrplan';
  kennzahl: string;
}

export interface Kontextbilanz {
  stand: string;
  bestand: { artikel: number; quellen: number; fakten: number; entscheidungen: number };
  pflege: { mitVerantwortlich: number; mitPruefdatum: number; faellig: number; veraltet: number; faktenMitGueltigkeit: number };
  antworten: { belegt: number; stehtNichtDrin: number; zeitraum: { von: string; bis: string } };
  ersteBelegteAntwort: { am: string; sekundenSeitStart: number } | null;
  bemerkt: { befundeOffen: number; befundeErledigt: number; abgelaufeneFristen: number; vorAblaufGemeldet: number };
  eingang: { offen: number; freigegebenSeit: number; abgelehntSeit: number };
  anbindungen: { verbundeneApps: number; agentenZugaenge: number };
  /** Sammlungen mit Quellen, zu denen es keine Wissensgruppe gibt (Annahme bis v1.3 `luecken()`). */
  luecken: number;
  ausstieg: { letzteProbe: string | null; bestanden: boolean | null };
  pruefbank: { letzterLauf: string | null; anbieter: string | null; modell: string | null; belegtreue: number | null; lecks: number | null; kiStatus: KiStatus };
  /** additiv: die sechs Stufen mit ehrlichem Status. */
  stufen: KontextStufe[];
  /** additiv: Quellen je Sammlung (Bereich), nur Zahlen. */
  quellenJeBereich: Record<string, number>;
  /** additiv: Datum der letzten Änderung im Wissen (git). */
  letztePflege: string | null;
}

/** Sichtbarkeit eines Vorschlags (wie im Eingang). */
function vorschlagSichtbar(u: User, v: Vorschlag): boolean {
  const k = parseMarkdown(v.art === 'loeschung' ? v.alt ?? '' : v.neu).kopf;
  return darfSehen(u, String(k['sichtbarkeit'] ?? 'betrieb'), String(k['besitzer'] ?? v.von)) || v.von === u.id || v.von.endsWith(`@${u.id}`);
}

export async function kontextbilanz(k: Kern, u: User): Promise<Kontextbilanz> {
  brauchtRolle(u, 'freigeber', 'die Kontextbilanz sehen');
  const heute = k._intern.heute();
  const plus = (t: number) => { const d = new Date(`${heute}T12:00:00Z`); d.setUTCDate(d.getUTCDate() + t); return d.toISOString().slice(0, 10); };

  const artikel = await k.listeWissen(u);
  const inhalt = artikel.filter((a) => !a.pfad.startsWith('wissen/_regeln/'));
  const quellenDateien = k._intern.sichtbar(u, 'quelle').filter((d) => d.aktiv);
  const fakten = await k.fakten(u);
  const bestand = {
    artikel: inhalt.length,
    quellen: quellenDateien.length,
    fakten: fakten.length,
    entscheidungen: inhalt.filter((a) => a.kopf.type === 'Entscheidung').length,
  };
  const pflege = {
    mitVerantwortlich: inhalt.filter((a) => a.kopf.verantwortlich?.trim()).length,
    mitPruefdatum: inhalt.filter((a) => a.kopf.pruefen_bis).length,
    faellig: inhalt.filter((a) => a.kopf.status !== 'veraltet' && a.kopf.pruefen_bis && a.kopf.pruefen_bis < heute).length,
    veraltet: inhalt.filter((a) => a.kopf.status === 'veraltet').length,
    faktenMitGueltigkeit: fakten.filter((f) => f.gilt_ab || f.gilt_bis).length,
  };

  // Zähler ohne Personen: Tagessummen
  const von = k.zaehler.erstesEreignis() ?? heute;
  const ev = k.zaehler.ereignisse(von, heute);
  const antworten = { belegt: ev['antwort_belegt'] ?? 0, stehtNichtDrin: ev['antwort_steht_nicht_drin'] ?? 0, zeitraum: { von, bis: heute } };

  // Start = erster Commit des Datenordners
  const log = await k.git.log();
  const start = log.at(-1)?.am ?? null;
  const ersteAm = k.zaehler.leseMeilenstein('erste_belegte_antwort');
  const ersteBelegteAntwort = ersteAm ? { am: ersteAm, sekundenSeitStart: start ? Math.max(0, Math.round((Date.parse(ersteAm) - Date.parse(start)) / 1000)) : 0 } : null;

  // Bemerkt: Befunde aus pruefe() (ohne Vorschläge anzulegen), erledigte Aufräum-Vorschläge, Fristen
  const befunde = (await k.pruefe(u, { vorschlaegeAnlegen: false })).filter((b) => b.art !== 'index_veraltet');
  const erledigt: Vorschlag[] = [];
  for (const n of (await readdir(join(k.dir, 'eingang', 'erledigt')).catch(() => [] as string[])).filter((x) => x.endsWith('.json'))) {
    try { erledigt.push(JSON.parse(await readFile(join(k.dir, 'eingang', 'erledigt', n), 'utf8')) as Vorschlag); } catch { /* überspringen */ }
  }
  const sichtbarErledigt = erledigt.filter((v) => vorschlagSichtbar(u, v));
  const bemerkt = {
    befundeOffen: befunde.length,
    befundeErledigt: sichtbarErledigt.filter((v) => v.status === 'freigegeben' && v.grund.startsWith('Aufräumen:')).length,
    abgelaufeneFristen: fakten.filter((f) => f.gilt_bis && f.gilt_bis < heute).length,
    vorAblaufGemeldet: fakten.filter((f) => f.gilt_bis && f.gilt_bis >= heute && f.gilt_bis <= plus(30)).length,
  };
  const offen = await k.eingang(u, { alle: true });
  const eingang = {
    offen: offen.length,
    freigegebenSeit: sichtbarErledigt.filter((v) => v.status === 'freigegeben').length,
    abgelehntSeit: sichtbarErledigt.filter((v) => v.status === 'abgelehnt').length,
  };

  // Anbindungen: Admin sieht alle Zugänge der Instanz, sonst nur die eigenen
  const jetzt = new Date(k._intern.jetzt()).toISOString();
  const leute = hatRolle(u, 'admin') ? await k.benutzer.liste() : [u];
  const apps = new Set<string>();
  let agenten = 0;
  for (const b of leute) {
    for (const t of k.zugang.liste(hatRolle(u, 'admin') ? u : b, b.id)) {
      if (t.widerrufen || (t.laeuftAb && t.laeuftAb < jetzt)) continue;
      if ((t.art === 'oauth_zugriff' || t.art === 'oauth_erneuerung') && t.clientId) apps.add(t.clientId);
      if ((t.art === 'api' || t.art === 'mcp') && t.agent) agenten++;
    }
  }

  const quellenJeBereich: Record<string, number> = {};
  for (const d of quellenDateien) quellenJeBereich[d.sammlung || 'ohne'] = (quellenJeBereich[d.sammlung || 'ohne'] ?? 0) + 1;
  const gruppen = new Set(inhalt.map((a) => a.kopf.gruppe));
  const luecken = Object.keys(quellenJeBereich).filter((s) => s !== 'beispiel' && !gruppen.has(s)).length;

  const probe = await k.letzteAusstiegsprobe().catch(() => null);
  let lauf: PruefbankLauf | null = null;
  const lo = join(k.dir, 'pruefung', 'laeufe');
  const namen = (await readdir(lo).catch(() => [] as string[])).filter((x) => x.endsWith('.json'));
  for (const n of namen) {
    try {
      const l = JSON.parse(await readFile(join(lo, n), 'utf8')) as PruefbankLauf;
      if (!lauf || l.am > lauf.am) lauf = l;
    } catch { /* überspringen */ }
  }
  const kiStatus = await k.kiStatus();
  const letztePflege = (await k.git.log({ pfad: 'wissen', max: 1 }))[0]?.am?.slice(0, 10) ?? null;

  const stufen: KontextStufe[] = [
    { nr: 1, name: 'Erfassen', status: 'gemessen', kennzahl: `${bestand.quellen} Quellen, erste belegte Antwort ${ersteBelegteAntwort ? `nach ${ersteBelegteAntwort.sekundenSeitStart} s` : 'noch offen'}` },
    { nr: 2, name: 'Es weiß Bescheid', status: 'gemessen', kennzahl: `${antworten.belegt} belegte Antworten, ${antworten.stehtNichtDrin} mal „steht nicht drin“` },
    { nr: 3, name: 'Es bemerkt', status: 'teilweise', kennzahl: `${bemerkt.befundeOffen} offene Befunde, ${bemerkt.abgelaufeneFristen} abgelaufene Fristen; Widersprüche zwischen Texten sind Fahrplan` },
    { nr: 4, name: 'Es arbeitet zu', status: 'fahrplan', kennzahl: `${eingang.freigegebenSeit} freigegebene Vorschläge; Entwürfe mit Belegen und Einarbeitungsmappe sind Fahrplan` },
    { nr: 5, name: 'Kontextschicht für jede KI', status: 'gemessen', kennzahl: `${apps.size} verbundene Apps, ${agenten} Agenten-Zugänge, Prüfbank ${lauf ? (lauf.bestanden ? 'bestanden' : 'unter Schwelle') : 'noch nicht gelaufen'}` },
    { nr: 6, name: 'Es bleibt', status: 'teilweise', kennzahl: `Ausstiegsprobe ${probe ? (probe.bestanden ? 'bestanden' : 'nicht bestanden') : 'noch nicht gelaufen'}; Übergabepaket ist Fahrplan` },
  ];

  return {
    stand: heute,
    bestand,
    pflege,
    antworten,
    ersteBelegteAntwort,
    bemerkt,
    eingang,
    anbindungen: { verbundeneApps: apps.size, agentenZugaenge: agenten },
    luecken,
    ausstieg: { letzteProbe: probe?.am ?? null, bestanden: probe ? probe.bestanden : null },
    pruefbank: { letzterLauf: lauf?.am ?? null, anbieter: lauf?.anbieter ?? null, modell: lauf?.modell ?? null, belegtreue: lauf?.kennzahlen.belegtreue ?? null, lecks: lauf?.kennzahlen.lecks ?? null, kiStatus },
    stufen,
    quellenJeBereich,
    letztePflege,
  };
}
