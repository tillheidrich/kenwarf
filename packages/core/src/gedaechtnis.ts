/**
 * v1.4 8.4 und 8.5 (R4 P5.3, P5.4): Agentenprofile und Gedächtnis-Adapter für das Claude-Memory-Tool
 * (`memory_20250818`, Befehle view, create, str_replace, insert, delete, rename unter /memories; Meldungstexte nach
 * https://platform.claude.com/en/docs/agents-and-tools/tool-use/memory-tool, geprüft 24.10.2026).
 *
 * Abbildung:
 *  - `/memories/wissen/…`  → `wissen/…`: `view` zeigt nur, was der Mensch sehen darf; jede Änderung wird ein Vorschlag
 *    im Eingang (delete → `loeschung`, rename → `neu` plus `loeschung`). Die Datei bleibt unverändert.
 *  - `/memories/notizen/…` → `nutzer/<id>/notizen/…`: Arbeitsnotizen des Agenten, direktes Schreiben, git-Commit mit
 *    `generated`. Liegen nur dort, werden nie indiziert, sind nie Fundstelle und nie Kompilierbasis.
 *  - alles andere unter /memories: Fehler mit Hinweis auf die zwei Bereiche.
 * Grundsatz: Modellgedächtnis ist Quelle, nie Wissen. Schreiben (auch Notizen) braucht mindestens die Rolle autor
 * (Scope `kern:vorschlagen` prüft der Server).
 */
import { existsSync } from 'node:fs';
import { mkdir, readdir, readFile, rename, rm, stat } from 'node:fs/promises';
import { dirname, join, posix } from 'node:path';
import type { Kern } from './kern.js';
import { hatRolle, inReichweite } from './rechte.js';
import type { Scope, TokenEintrag } from './zugang.js';
import { KernFehler, type User, type Vorschlag } from './types.js';
import { parseMarkdown, slugify, stringifyMarkdown } from './util.js';

/* ---------------------------- 8.4 Agentenprofile ---------------------------- */

export type AgentenProfil = 'leser' | 'autor';
/** v1.4 6.3/8.4: Scopes je Agentenprofil. `kern:verwalten` nie für Agenten. */
export function agentenScopes(profil: AgentenProfil): Scope[] {
  return profil === 'autor' ? ['kern:lesen', 'kern:fragen', 'kern:vorschlagen', 'kern:bericht'] : ['kern:lesen', 'kern:fragen'];
}
/** `von` eines Agentenvorschlags: `agent/<name>@<userId>`. */
export function agentVon(agent: string, userId: string): string {
  const n = agent.replace(/[^\p{L}\p{N} ._-]/gu, '').trim().slice(0, 80) || 'agent';
  return `agent/${n}@${userId}`;
}
/**
 * Effektiver Benutzer für einen Agenten-Zugang: nie mehr Rechte als der Mensch; ohne `kern:vorschlagen` höchstens leser,
 * nie freigeber oder admin (Agenten geben nie frei). Die Reichweite des Zugangs filtert zusätzlich (`imZugang`).
 */
export function alsAgent(u: User, z: Pick<TokenEintrag, 'agent' | 'scopes' | 'reichweite'>): User & { agent: string | null; reichweite: TokenEintrag['reichweite'] } {
  const darfVorschlagen = z.scopes.includes('kern:vorschlagen') && hatRolle(u, 'autor');
  return { ...u, rollen: [darfVorschlagen ? 'autor' : 'leser'], agent: z.agent, reichweite: z.reichweite };
}
/** Sieht ein Agenten-Zugang diese Datei? (Rechte des Menschen UND Reichweite des Zugangs.) */
export function imZugang(u: User, reichweite: TokenEintrag['reichweite'], sichtbarkeit: string, besitzer: string): boolean {
  return inReichweite(u, sichtbarkeit, besitzer, reichweite ?? undefined);
}

/* ---------------------------- 8.5 Gedächtnis-Adapter ---------------------------- */

export type GedaechtnisBefehl =
  | { command: 'view'; path: string; view_range?: [number, number] }
  | { command: 'create'; path: string; file_text: string }
  | { command: 'str_replace'; path: string; old_str: string; new_str?: string }
  | { command: 'insert'; path: string; insert_line: number; insert_text: string }
  | { command: 'delete'; path: string }
  | { command: 'rename'; old_path: string; new_path: string };

export interface GedaechtnisErgebnis {
  /** false = als `is_error: true` an das Modell zurückgeben. */
  ok: boolean;
  text: string;
  /** Vorschläge im Eingang (Schreiben auf /memories/wissen). */
  vorschlaege?: Vorschlag[];
}

const WURZEL = '/memories';
export const NOTIZ_MAX_BYTES = 64 * 1024;
const VIEW_MAX_ZEILEN = 2000;
export const NOTIZEN_ABLAUF_TAGE = 90;

type Ziel = { bereich: 'wurzel' } | { bereich: 'wissen'; rel: string; daten: string } | { bereich: 'notizen'; rel: string; daten: string };

/** Pfad nach Anthropic-Vorgabe prüfen: unter /memories, dekodiert, kanonisch, ohne `..`, `\`, Steuerzeichen. */
export function pruefePfad(pfad: unknown, u: User): Ziel {
  if (typeof pfad !== 'string' || !pfad) throw new KernFehler('ungueltig', 'Error: path fehlt');
  let p = pfad;
  for (let i = 0; i < 3; i++) {
    let d: string;
    try { d = decodeURIComponent(p); } catch { throw new KernFehler('ungueltig', `Error: Invalid path ${pfad}`); }
    if (d === p) break;
    p = d;
  }
  if (/%[0-9a-f]{2}/i.test(p) || /[\\\0-\x1f]/.test(p) || p.split('/').some((t) => t === '..' || t === '.')) throw new KernFehler('ungueltig', `Error: Invalid path ${pfad}`);
  const n = posix.normalize(p).replace(/\/+$/, '');
  if (n !== WURZEL && !n.startsWith(`${WURZEL}/`)) throw new KernFehler('ungueltig', `Error: The path ${pfad} must start with ${WURZEL}`);
  if (n === WURZEL) return { bereich: 'wurzel' };
  const rest = n.slice(WURZEL.length + 1);
  const [kopf, ...weiter] = rest.split('/');
  const rel = weiter.join('/');
  if (weiter.some((t) => t.startsWith('.'))) throw new KernFehler('ungueltig', `Error: Invalid path ${pfad}`);
  if (kopf === 'wissen') return { bereich: 'wissen', rel, daten: rel ? `wissen/${rel}` : 'wissen' };
  if (kopf === 'notizen') return { bereich: 'notizen', rel, daten: `nutzer/${slugify(u.id, 64)}/notizen${rel ? `/${rel}` : ''}` };
  throw new KernFehler('ungueltig', `Error: The path ${pfad} does not exist. Use ${WURZEL}/notizen/ for your own working notes and ${WURZEL}/wissen/ to read knowledge (changes there become proposals).`);
}

const groesse = (b: number) => (b < 1024 ? `${b}` : b < 1024 * 1024 ? `${Math.round((b / 1024) * 10) / 10}K` : `${Math.round((b / 1024 / 1024) * 10) / 10}M`);
const mitZeilen = (text: string, von = 1) => text.split('\n').map((z, i) => `${String(i + von).padStart(6, ' ')}\t${z}`).join('\n');
const fehler = (text: string): GedaechtnisErgebnis => ({ ok: false, text });

/** Sichtbare Wissensdateien als Map rel → Bytes. */
function wissenListe(k: Kern, u: User, reichweite?: TokenEintrag['reichweite']): Map<string, number> {
  const m = new Map<string, number>();
  for (const d of k._intern.sichtbar(u, 'wissen', reichweite ?? undefined)) m.set(d.pfad.slice('wissen/'.length), d.groesse);
  return m;
}

async function notizDateien(k: Kern, ordner: string): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  const lauf = async (rel: string) => {
    for (const e of await readdir(join(k.dir, ordner, rel), { withFileTypes: true }).catch(() => [])) {
      if (e.name.startsWith('.')) continue;
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) await lauf(r);
      else if (e.isFile()) out.set(r, (await stat(join(k.dir, ordner, r))).size);
    }
  };
  await lauf('');
  return out;
}

/** Verzeichnisansicht im Format des Memory-Tools (2 Ebenen, Tab, lesbare Größe). */
function verzeichnis(anzeige: string, dateien: Map<string, number>, praefix: string): string {
  const eintraege = new Map<string, number>();
  let summe = 0;
  for (const [rel, b] of dateien) {
    if (praefix && !rel.startsWith(`${praefix}/`)) continue;
    const teile = (praefix ? rel.slice(praefix.length + 1) : rel).split('/');
    summe += b;
    for (let t = 1; t <= Math.min(2, teile.length); t++) {
      const r = teile.slice(0, t).join('/');
      eintraege.set(r, (eintraege.get(r) ?? 0) + b);
    }
  }
  const zeilen = [...eintraege].sort(([x], [y]) => x.localeCompare(y)).map(([r, b]) => `${groesse(b)}\t${anzeige}/${r}`);
  return [`Here're the files and directories up to 2 levels deep in ${anzeige}, excluding hidden items and node_modules:`, `${groesse(summe)}\t${anzeige}`, ...zeilen].join('\n');
}

function dateiAnsicht(anzeige: string, text: string, bereich?: [number, number]): GedaechtnisErgebnis {
  const z = text.split('\n');
  if (z.length > 999_999) return fehler(`File ${anzeige} exceeds maximum line limit of 999,999 lines.`);
  let von = 1;
  let bis = z.length;
  if (bereich) {
    von = Math.max(1, bereich[0]);
    bis = bereich[1] === -1 ? z.length : Math.min(z.length, bereich[1]);
    if (von > bis) return fehler(`Error: Invalid view_range ${JSON.stringify(bereich)}`);
  }
  if (bis - von + 1 > VIEW_MAX_ZEILEN) bis = von + VIEW_MAX_ZEILEN - 1;
  return { ok: true, text: `Here's the content of ${anzeige} with line numbers:\n${mitZeilen(z.slice(von - 1, bis).join('\n'), von)}` };
}

/** Text ohne YAML-Kopf zu einem Artikel machen (für Vorschläge auf /memories/wissen). */
function alsArtikel(text: string, ziel: string, alt: string | null, u: User, heute: string, standard: string): string {
  const p = parseMarkdown(text);
  if (Object.keys(p.kopf).length && !p.fehler) return text;
  if (alt) {
    const a = parseMarkdown(alt);
    return stringifyMarkdown(a.kopf, text);
  }
  const titel = /^#\s+(.+)$/m.exec(text)?.[1]?.trim() || posix.basename(ziel, '.md').replace(/-/g, ' ');
  const gruppe = ziel.split('/')[1] && ziel.split('/').length > 2 ? ziel.split('/')[1]! : 'notizen';
  const satz = text.replace(/^#.*$/gm, '').replace(/\s+/g, ' ').trim().split(/(?<=[.!?])\s/)[0] ?? '';
  return stringifyMarkdown({
    type: 'Artikel', titel, gruppe, kurzfassung: satz.slice(0, 300) || titel, stand: heute, verantwortlich: '', pruefen_bis: null,
    sichtbarkeit: standard, besitzer: u.id, fundstellen: [], status: 'entwurf',
  }, text);
}

async function commitNotiz(k: Kern, u: User, agent: string | undefined, dateien: { pfad: string; inhalt: string | null }[], grund: string): Promise<void> {
  const autor = agent ? agentVon(agent, u.id) : u.name;
  await k._intern.schreibeCommit(dateien, autor, `Notiz: ${grund}`, `generated: ${autor}`);
}

export async function gedaechtnis(k: Kern, u: User, b: GedaechtnisBefehl, opt: { agent?: string; reichweite?: TokenEintrag['reichweite'] } = {}): Promise<GedaechtnisErgebnis> {
  try {
    return await ausfuehren(k, u, b, opt);
  } catch (e) {
    if (e instanceof KernFehler) return fehler(e.message.startsWith('Error') || e.message.startsWith('The path') || e.message.startsWith('No replacement') ? e.message : `Error: ${e.message}`);
    throw e;
  }
}

async function ausfuehren(k: Kern, u: User, b: GedaechtnisBefehl, opt: { agent?: string; reichweite?: TokenEintrag['reichweite'] }): Promise<GedaechtnisErgebnis> {
  const schreibt = b.command !== 'view';
  if (schreibt && !hatRolle(u, 'autor')) return fehler('Error: read-only access. This connection may only read (/memories is view-only for role leser).');
  const anzeigeVon = (p: string) => posix.normalize(p).replace(/\/+$/, '');

  if (b.command === 'rename') {
    const a = pruefePfad(b.old_path, u);
    const n = pruefePfad(b.new_path, u);
    if (a.bereich === 'wurzel' || n.bereich === 'wurzel') return fehler('Error: Cannot rename the /memories root');
    if (a.bereich !== n.bereich) return fehler('Error: rename only within /memories/notizen or within /memories/wissen');
    if (a.bereich === 'notizen') {
      if (!existsSync(join(k.dir, a.daten))) return fehler(`Error: The path ${b.old_path} does not exist`);
      if (existsSync(join(k.dir, n.daten))) return fehler(`Error: The destination ${b.new_path} already exists`);
      if (!a.rel) return fehler('Error: Cannot rename the notes root');
      const alt = await readFile(join(k.dir, a.daten)).catch(() => null);
      if (!alt) return fehler(`Error: The path ${b.old_path} does not exist`);
      await mkdir(dirname(join(k.dir, n.daten)), { recursive: true });
      await rename(join(k.dir, a.daten), join(k.dir, n.daten));
      await commitNotiz(k, u, opt.agent, [{ pfad: a.daten, inhalt: null }, { pfad: n.daten, inhalt: alt.toString('utf8') }], `rename ${a.rel} → ${n.rel}`);
      return { ok: true, text: `Successfully renamed ${b.old_path} to ${b.new_path}` };
    }
    const sicht = wissenListe(k, u, opt.reichweite);
    if (!sicht.has(a.rel)) return fehler(`Error: The path ${b.old_path} does not exist`);
    if (existsSync(join(k.dir, n.daten))) return fehler(`Error: The destination ${b.new_path} already exists`);
    const text = (await k._intern.lies(a.daten)) ?? '';
    const von = opt.agent ? agentVon(opt.agent, u.id) : u.id;
    const grund = `Gedächtnis: ${a.rel} umbenennen in ${n.rel}`;
    const v1 = await k._intern.legeVorschlagAn(u, { art: 'neu', ziel: n.daten, alt: null, neu: text, grund }, von);
    const v2 = await k._intern.legeVorschlagAn(u, { art: 'loeschung', ziel: a.daten, alt: text, neu: '', grund }, von);
    return { ok: true, text: `Proposals ${v1.id} and ${v2.id} created to rename ${b.old_path} to ${b.new_path}. A human must approve them; nothing changed yet.`, vorschlaege: [v1, v2] };
  }

  const z = pruefePfad(b.path, u);
  const anzeige = anzeigeVon(b.path);
  if (z.bereich === 'wurzel') {
    if (b.command !== 'view') return fehler(`Error: Cannot ${b.command} the ${WURZEL} root`);
    const w = wissenListe(k, u, opt.reichweite);
    const notizen = await notizDateien(k, `nutzer/${slugify(u.id, 64)}/notizen`);
    const alle = new Map<string, number>();
    for (const [r, s] of w) alle.set(`wissen/${r}`, s);
    for (const [r, s] of notizen) alle.set(`notizen/${r}`, s);
    const t = verzeichnis(WURZEL, alle, '');
    return { ok: true, text: notizen.size ? t : `${t}\n0\t${WURZEL}/notizen` };
  }

  if (z.bereich === 'notizen') {
    const abs = join(k.dir, z.daten);
    const istOrdner = existsSync(abs) && (await stat(abs)).isDirectory();
    switch (b.command) {
      case 'view': {
        if (!z.rel || istOrdner) return { ok: true, text: verzeichnis(anzeige, await notizDateien(k, z.daten), '') };
        const t = await readFile(abs, 'utf8').catch(() => null);
        if (t === null) return fehler(`The path ${b.path} does not exist. Please provide a valid path.`);
        return dateiAnsicht(anzeige, t, b.view_range);
      }
      case 'create': {
        if (!z.rel) return fehler('Error: path must name a file');
        if (istOrdner) return fehler(`Error: ${b.path} is a directory`);
        if (Buffer.byteLength(b.file_text ?? '') > NOTIZ_MAX_BYTES) return fehler(`Error: File too large (max ${NOTIZ_MAX_BYTES / 1024} KB)`);
        await commitNotiz(k, u, opt.agent, [{ pfad: z.daten, inhalt: b.file_text ?? '' }], `create ${z.rel}`);
        return { ok: true, text: `File created successfully at: ${anzeige}` };
      }
      case 'str_replace': {
        const t = istOrdner ? null : await readFile(abs, 'utf8').catch(() => null);
        if (t === null) return fehler(`Error: The path ${b.path} does not exist. Please provide a valid path.`);
        const neu = ersetze(t, b.old_str, b.new_str ?? '', b.path);
        if (!neu.ok) return fehler(neu.text);
        if (Buffer.byteLength(neu.text) > NOTIZ_MAX_BYTES) return fehler(`Error: File too large (max ${NOTIZ_MAX_BYTES / 1024} KB)`);
        await commitNotiz(k, u, opt.agent, [{ pfad: z.daten, inhalt: neu.text }], `str_replace ${z.rel}`);
        return { ok: true, text: `The memory file has been edited.\n${ausschnitt(neu.text, neu.zeile)}` };
      }
      case 'insert': {
        const t = istOrdner ? null : await readFile(abs, 'utf8').catch(() => null);
        if (t === null) return fehler(`Error: The path ${b.path} does not exist`);
        const neu = einfuegen(t, b.insert_line, b.insert_text ?? '');
        if (!neu.ok) return fehler(neu.text);
        await commitNotiz(k, u, opt.agent, [{ pfad: z.daten, inhalt: neu.text }], `insert ${z.rel}`);
        return { ok: true, text: `The file ${anzeige} has been edited.` };
      }
      case 'delete': {
        if (!z.rel) return fehler('Error: Cannot delete the notes root');
        if (!existsSync(abs)) return fehler(`Error: The path ${b.path} does not exist`);
        const pfade = istOrdner ? [...(await notizDateien(k, z.daten)).keys()].map((r) => `${z.daten}/${r}`) : [z.daten];
        await rm(abs, { recursive: true, force: true });
        await commitNotiz(k, u, opt.agent, pfade.map((p) => ({ pfad: p, inhalt: null })), `delete ${z.rel}`);
        return { ok: true, text: `Successfully deleted ${anzeige}` };
      }
    }
  }

  // Bereich wissen: lesen nach Rechten, schreiben nur als Vorschlag
  const w = z as { bereich: 'wissen'; rel: string; daten: string };
  const sicht = wissenListe(k, u, opt.reichweite);
  const sichtbar = w.rel !== '' && sicht.has(w.rel);
  const istOrdner = w.rel === '' || [...sicht.keys()].some((r) => r.startsWith(`${w.rel}/`));
  const von = opt.agent ? agentVon(opt.agent, u.id) : u.id;
  const lies = async () => (sichtbar ? await k._intern.lies(w.daten) : null);
  const vorschlag = async (art: Vorschlag['art'], neu: string, alt: string | null, grund: string): Promise<GedaechtnisErgebnis> => {
    const e = await k._intern.einstellungen();
    const text = art === 'loeschung' ? '' : alsArtikel(neu, w.daten, alt, u, k._intern.heute(), String(e.standard_sichtbarkeit ?? 'betrieb'));
    const v = await k._intern.legeVorschlagAn(u, { art, ziel: w.daten, alt, neu: text, grund }, von);
    return { ok: true, text: `Proposal ${v.id} created for ${anzeige}. Knowledge only changes after a human approves it; the file is unchanged. Use ${WURZEL}/notizen/ for your own working notes.`, vorschlaege: [v] };
  };
  switch (b.command) {
    case 'view': {
      if (istOrdner && !sichtbar) return { ok: true, text: verzeichnis(anzeige, sicht, w.rel) };
      const t = await lies();
      if (t === null) return fehler(`The path ${b.path} does not exist. Please provide a valid path.`);
      return dateiAnsicht(anzeige, t, b.view_range);
    }
    case 'create': {
      if (!w.rel.endsWith('.md')) return fehler('Error: knowledge files must end with .md');
      const vorhanden = existsSync(join(k.dir, w.daten));
      if (vorhanden && !sichtbar) return fehler(`Error: File ${b.path} already exists`);
      const alt = vorhanden ? await lies() : null;
      return vorschlag(vorhanden ? 'aenderung' : 'neu', b.file_text ?? '', alt, `Gedächtnis: ${vorhanden ? 'ersetzen' : 'anlegen'} ${w.rel}`);
    }
    case 'str_replace': {
      const t = await lies();
      if (t === null) return fehler(`Error: The path ${b.path} does not exist. Please provide a valid path.`);
      const neu = ersetze(t, b.old_str, b.new_str ?? '', b.path);
      if (!neu.ok) return fehler(neu.text);
      return vorschlag('aenderung', neu.text, t, `Gedächtnis: Änderung in ${w.rel}`);
    }
    case 'insert': {
      const t = await lies();
      if (t === null) return fehler(`Error: The path ${b.path} does not exist`);
      const neu = einfuegen(t, b.insert_line, b.insert_text ?? '');
      if (!neu.ok) return fehler(neu.text);
      return vorschlag('aenderung', neu.text, t, `Gedächtnis: Ergänzung in ${w.rel}`);
    }
    case 'delete': {
      const t = await lies();
      if (t === null) return fehler(`Error: The path ${b.path} does not exist`);
      return vorschlag('loeschung', '', t, `Gedächtnis: ${w.rel} löschen`);
    }
  }
  return fehler('Error: unknown command');
}

function ersetze(text: string, alt: string | undefined, neu: string, pfad: string): { ok: true; text: string; zeile: number } | { ok: false; text: string } {
  if (!alt) return { ok: false, text: 'Error: old_str fehlt' };
  const stellen: number[] = [];
  for (let i = text.indexOf(alt); i >= 0; i = text.indexOf(alt, i + 1)) stellen.push(i);
  if (!stellen.length) return { ok: false, text: `No replacement was performed, old_str \`${alt}\` did not appear verbatim in ${pfad}.` };
  if (stellen.length > 1) {
    const zeilen = stellen.map((i) => text.slice(0, i).split('\n').length);
    return { ok: false, text: `No replacement was performed. Multiple occurrences of old_str \`${alt}\` in lines: ${zeilen.join(', ')}. Please ensure it is unique` };
  }
  return { ok: true, text: text.slice(0, stellen[0]) + neu + text.slice(stellen[0]! + alt.length), zeile: text.slice(0, stellen[0]).split('\n').length };
}

function einfuegen(text: string, zeile: number, einfuege: string): { ok: true; text: string } | { ok: false; text: string } {
  const z = text.split('\n');
  if (!Number.isInteger(zeile) || zeile < 0 || zeile > z.length) return { ok: false, text: `Error: Invalid \`insert_line\` parameter: ${zeile}. It should be within the range of lines of the file: [0, ${z.length}]` };
  z.splice(zeile, 0, ...einfuege.replace(/\n$/, '').split('\n'));
  return { ok: true, text: z.join('\n') };
}

function ausschnitt(text: string, zeile: number): string {
  const z = text.split('\n');
  const von = Math.max(1, zeile - 4);
  return mitZeilen(z.slice(von - 1, Math.min(z.length, zeile + 4)).join('\n'), von);
}

/**
 * v1.4 8.5: abgelaufene Arbeitsnotizen (letzter Commit älter als `notizen.ablauf_tage`, Standard 90). Notizen liegen nicht
 * unter wissen/, ein Eingangs-Vorschlag ist dort nicht möglich; deshalb liefert core die Liste (Pfade relativ zu
 * /memories/notizen) und `loescheAbgelaufen` entfernt sie mit Commit. Admin sieht nur Anzahlen fremder Notizen nicht.
 */
export async function notizenAblauf(k: Kern, u: User): Promise<string[]> {
  const e = await k._intern.einstellungen();
  const tage = Number((e['notizen'] as { ablauf_tage?: number } | undefined)?.ablauf_tage ?? NOTIZEN_ABLAUF_TAGE);
  const grenze = new Date(`${k._intern.heute()}T00:00:00Z`).getTime() - tage * 86400_000;
  const ordner = `nutzer/${slugify(u.id, 64)}/notizen`;
  const out: string[] = [];
  for (const rel of (await notizDateien(k, ordner)).keys()) {
    const c = (await k.git.log({ pfad: `${ordner}/${rel}`, max: 1 }))[0];
    const am = c ? Date.parse(c.am) : (await stat(join(k.dir, ordner, rel))).mtimeMs;
    if (am < grenze) out.push(rel);
  }
  return out.sort();
}
