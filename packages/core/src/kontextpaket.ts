/**
 * v1.4 8.3 (R4 P5.2): Kontextpaket. Die kleinste belegte Menge für ein fremdes Modell oder einen Agenten zu einer Frage
 * oder einem Thema: Abschnitte mit wörtlichem Zitat aus den Dateizeilen, Fakten mit Gültigkeit, Entscheidungen mit Verlauf,
 * offene Widersprüche, ein kurzer Wegweiser. Rechte wie `suche`, nie Ansichten, Notizen, `nutzer/` oder `.kern/`.
 * Budget: Tokens geschätzt als Zeichen / 4 (deterministisch) [Schätzung], nie überschritten; höchstens halbes Kontextfenster.
 * Jedes Element trägt seine Herkunft (Pfad, Zeilen, Commit).
 */
import type { Kern } from './kern.js';
import { ueberdeckung } from './provider.js';
import { KernFehler, type Fakt, type Treffer, type User } from './types.js';
import { parseMarkdown, slugify } from './util.js';

export interface KontextpaketAnfrage { frage?: string; thema?: string; budgetTokens: number; mitFakten?: boolean; reichweite?: 'ich' | 'team' | 'betrieb' }
export interface Herkunft { pfad: string; zeilen: [number, number] | null; commit: string | null }
export type PaketAbschnitt = Treffer & { zitat: string; stand: string; gilt_bis?: string; herkunft: Herkunft };
export interface PaketEntscheidung { pfad: string; titel: string; kurzfassung: string; stand: string; verlauf: { am: string; grund: string }[]; herkunft: Herkunft }
export interface PaketWiderspruch { gegenstand: string; werte: { wert: string; artikel: string; gilt_bis: string | null }[] }
export interface Kontextpaket {
  abschnitte: PaketAbschnitt[];
  fakten: (Fakt & { herkunft: Herkunft })[];
  entscheidungen: PaketEntscheidung[];
  widersprueche: PaketWiderspruch[];
  wegweiser: string;
  tokens: number;
  budgetTokens: number;
  hinweis: string;
  ki_erzeugt: false;
  modell: null;
}

export const KONTEXT_STANDARD_BUDGET = 4000;
export const KONTEXT_MIN_BUDGET = 200;
const ZITAT_MAX = 1600;
export const KONTEXT_HINWEIS = 'Auszug aus dem Wissensordner nach den Rechten dieses Zugangs. Jede Angabe mit Pfad und Zeilen; nur belegte Aussagen übernehmen. Was ein Modell sich merkt, ist Quelle, nie Wissen: Änderungen nur als Vorschlag.';

/** Deterministische Tokenschätzung: Zeichen / 4, aufgerundet [Schätzung]. */
export const schaetzeTokens = (x: unknown): number => Math.ceil(JSON.stringify(x).length / 4);

const verboten = (p: string) => p.startsWith('ansichten/') || p.startsWith('nutzer/') || p.startsWith('.kern/') || p.startsWith('pruefung/');

export async function kontextpaket(k: Kern, u: User, a: KontextpaketAnfrage): Promise<Kontextpaket> {
  const q = (a.frage ?? a.thema ?? '').trim();
  if (!q) throw new KernFehler('ungueltig', 'frage oder thema angeben');
  const fenster = k._intern.profil()?.kontextFenster;
  let budget = Math.max(KONTEXT_MIN_BUDGET, Math.floor(Number(a.budgetTokens) || KONTEXT_STANDARD_BUDGET));
  if (fenster && fenster > 0) budget = Math.min(budget, Math.floor(fenster / 2));
  const commit = await k.git.head();
  const paket: Kontextpaket = { abschnitte: [], fakten: [], entscheidungen: [], widersprueche: [], wegweiser: '', tokens: 0, budgetTokens: budget, hinweis: KONTEXT_HINWEIS, ki_erzeugt: false, modell: null };
  const passt = (zusatz: unknown) => schaetzeTokens({ ...paket, tokens: budget }) + schaetzeTokens(zusatz) + 1 <= budget;

  const opt = a.reichweite ? { reichweite: a.reichweite } : {};
  const roh = (await k._intern.rohSuche(u, q, { ...opt, limit: a.thema && !a.frage ? 30 : 15 })).filter((t) => !verboten(t.pfad));
  const kopfCache = new Map<string, Record<string, unknown>>();
  const kopf = async (p: string) => {
    if (!kopfCache.has(p)) kopfCache.set(p, parseMarkdown((await k._intern.lies(p)) ?? '').kopf);
    return kopfCache.get(p)!;
  };

  // 1. Fakten zuerst (klein, mit Gültigkeit und Beleg); nur gültige und solche, die zur Frage oder zu den Treffern passen
  const trefferDateien = new Set(roh.map((t) => t.pfad));
  const alleFakten = a.mitFakten === false ? [] : await k.fakten(u, opt);
  const relevant = alleFakten.filter((f) => f.beleg && (ueberdeckung(f.gegenstand, q) >= 0.5 || ueberdeckung(q, f.gegenstand) >= 0.5 || trefferDateien.has(f.artikel)));
  for (const f of relevant.filter((x) => x.gueltig)) {
    const e = { ...f, herkunft: { pfad: f.beleg!.quelle, zeilen: f.beleg!.zeilen, commit } };
    if (passt(e)) paket.fakten.push(e);
  }
  // Widersprüche unter den gültigen relevanten Fakten (gleiche Art, gleicher Gegenstand, gleiche Einheit, anderer Wert)
  const gruppen = new Map<string, Fakt[]>();
  for (const f of relevant.filter((x) => x.gueltig)) {
    const s = `${f.art}|${slugify(f.gegenstand)}|${f.einheit ?? ''}`;
    gruppen.set(s, [...(gruppen.get(s) ?? []), f]);
  }
  for (const fs of gruppen.values()) {
    if (new Set(fs.map((f) => String(f.wert).trim().toLowerCase())).size < 2) continue;
    const w: PaketWiderspruch = { gegenstand: fs[0]!.gegenstand, werte: fs.map((f) => ({ wert: `${f.wert}${f.einheit ? ` ${f.einheit}` : ''}`, artikel: f.artikel, gilt_bis: f.gilt_bis ?? null })) };
    if (passt(w)) paket.widersprueche.push(w);
  }

  // 2. Abschnitte mit wörtlichem Zitat aus den Dateizeilen
  const dateiCache = new Map<string, string[]>();
  for (const t of roh) {
    if (!dateiCache.has(t.pfad)) dateiCache.set(t.pfad, ((await k._intern.lies(t.pfad)) ?? '').split(/\r?\n/));
    const zeilen = dateiCache.get(t.pfad)!;
    let bis = t.bis;
    let zitat = zeilen.slice(t.von - 1, bis).join('\n').trim();
    while (zitat.length > ZITAT_MAX && bis > t.von) zitat = zeilen.slice(t.von - 1, --bis).join('\n').trim();
    if (!zitat) continue;
    const kf = await kopf(t.pfad);
    const stand = String(t.art === 'wissen' ? kf['stand'] ?? '' : String(kf['erfasst_am'] ?? '').slice(0, 10));
    const giltBis = t.art === 'wissen' && kf['pruefen_bis'] ? String(kf['pruefen_bis']) : undefined;
    const e: PaketAbschnitt = {
      pfad: t.pfad, art: t.art, titel: t.titel, abschnitt: t.abschnitt, zeilen: [t.von, bis], ausschnitt: '', score: Math.round(t.score * 1e6) / 1e6,
      zitat, stand, ...(giltBis ? { gilt_bis: giltBis } : {}), herkunft: { pfad: t.pfad, zeilen: [t.von, bis], commit },
    };
    if (passt(e)) paket.abschnitte.push(e);
  }

  // 3. Entscheidungen mit Verlauf (Artikel vom Typ Entscheidung, die zur Frage passen)
  const entscheidungen = k._intern.sichtbar(u, 'wissen', a.reichweite).filter((d) => d.aktiv && !verboten(d.pfad));
  for (const d of entscheidungen) {
    const kf = await kopf(d.pfad);
    if (kf['type'] !== 'Entscheidung') continue;
    const kurz = String(kf['kurzfassung'] ?? '');
    if (!trefferDateien.has(d.pfad) && ueberdeckung(q, `${d.titel} ${kurz}`) < 0.5) continue;
    const verlauf = (await k.git.log({ pfad: d.pfad, max: 5 })).map((c) => ({ am: c.am.slice(0, 10), grund: c.grund }));
    const e: PaketEntscheidung = { pfad: d.pfad, titel: d.titel, kurzfassung: kurz, stand: String(kf['stand'] ?? ''), verlauf, herkunft: { pfad: d.pfad, zeilen: null, commit } };
    if (passt(e)) paket.entscheidungen.push(e);
  }

  // 4. Wegweiser: welche Dateien drin sind und wie man mehr liest
  const dateien = [...new Set([...paket.abschnitte.map((x) => x.pfad), ...paket.fakten.map((x) => x.artikel), ...paket.entscheidungen.map((x) => x.pfad)])];
  const wegweiser = (n: number) => `${dateien.length} Dateien im Paket${dateien.length ? `: ${dateien.slice(0, n).join(', ')}${dateien.length > n ? ', …' : ''}` : ''}. Mehr mit kern_lese(pfad) oder kern_suche; Änderungen nur mit kern_vorschlag.`;
  for (let n = Math.min(dateien.length, 12); n >= 0; n--) {
    paket.wegweiser = wegweiser(n);
    if (schaetzeTokens({ ...paket, tokens: budget }) <= budget) break;
  }
  // Sicherheitsnetz: Budget nie überschreiten
  while (schaetzeTokens({ ...paket, tokens: budget }) > budget && (paket.abschnitte.length || paket.entscheidungen.length || paket.fakten.length || paket.widersprueche.length)) {
    if (paket.abschnitte.length) paket.abschnitte.pop();
    else if (paket.entscheidungen.length) paket.entscheidungen.pop();
    else if (paket.widersprueche.length) paket.widersprueche.pop();
    else paket.fakten.pop();
  }
  if (schaetzeTokens({ ...paket, tokens: budget }) > budget) paket.wegweiser = '';
  // `tokens` selbst zählt mit: bis zur stabilen Zahl rechnen (höchstens wenige Schritte)
  for (let i = 0; i < 4; i++) {
    paket.tokens = budget;
    const t = schaetzeTokens(paket);
    paket.tokens = t;
    if (schaetzeTokens(paket) === t) break;
  }
  return paket;
}
