// Mock der REST-API mit denselben JSON-Formen (CONTRACT.md v1/v1.1). Zustand liegt im Speicher,
// die Anmeldung zusätzlich in sessionStorage. Für Entwicklung und Demo, nie für den Betrieb.
import { ApiFehler } from '../api/types';
import type {
  Abgleich,
  Heute,
  LeseEinstellungen,
  Punkt,
  Antwort,
  Artikel,
  Befund,
  Einstellungen,
  Fakt,
  Fundstelle,
  KernApi,
  Geraet,
  Ausstiegsprobe,
  Einrichtung,
  KiVoreinstellung,
  KiWeg,
  Konto,
  Kontextbilanz,
  PruefbankLauf,
  VerbundeneApp,
  TokenScope,
  ZugangsToken,
  Quelle,
  Reichweite,
  Treffer,
  User,
  Vorschlag,
} from '../api/types';
import { NUTZER, erzeugeDaten, hashVon, nameVon, type MockNutzer } from './daten';
import { heuteIso, tageZwischen } from '../lib/datum';
import { normal } from '../lib/finden';
import { findeBereich } from '../lib/fundstelle';

const daten = erzeugeDaten();
const nutzer: MockNutzer[] = structuredClone(NUTZER);
let einstellungen: Einstellungen = {
  betrieb: 'Tischlerei Wendt GmbH',
  sprache: 'de',
  teams: ['buero', 'werkstatt'],
  sammlungen: ['Grundlagen', 'Abläufe', 'Vorlagen', 'Einarbeitung'],
  provider: { art: 'mock' },
};
let naechsteId = 60;

// Demo-Modi über die Adresse: ?modus=neu (frische Instanz nach Kauf, Testphase, erste Schritte)
// und ?modus=managed (von HD betrieben, mit Beispieldaten). Ohne Angabe: selbst gehostet.
const MODUS = (() => {
  try {
    return new URLSearchParams(location.search).get('modus') ?? '';
  } catch {
    return '';
  }
})();
const MANAGED = MODUS === 'neu' || MODUS === 'managed' || MODUS === 'lesen';

/** Beispieldaten liegen bei ?modus=neu bereit und kommen erst auf Wunsch dazu. */
const beispielVorrat = MODUS === 'neu' ? { artikel: daten.artikel.splice(0), quellen: daten.quellen.splice(0), vorschlaege: daten.vorschlaege.splice(0) } : null;
const startStand: Record<string, { fertig: boolean; ersteFrage: boolean }> = {};
let beispielGeladen = false;
let einrichtungWeg: KiWeg | null = MODUS === 'neu' ? null : 'eigener_schluessel';
let letzterLauf: PruefbankLauf | null = null;
let probe: Ausstiegsprobe | null = null;
const exporte: Record<string, { art: string; start: number }> = {};
const kontoStand: Konto = {
  status: 'test',
  paket: 'klein',
  stufe: 'geteilt',
  test_ende: new Date(Date.now() + 11 * 86400000).toISOString().slice(0, 10),
  loeschen_am: null,
  kuendigung_zum: null,
  test_selbst_verlaengert: false,
  preise: null,
  kauf_offen: false,
};
if (MODUS === 'lesen') Object.assign(kontoStand, { status: 'test_abgelaufen', test_ende: new Date(Date.now() - 2 * 86400000).toISOString().slice(0, 10), loeschen_am: new Date(Date.now() + 28 * 86400000).toISOString().slice(0, 10) });
/** v1.4 3.2: im Modus nur_lesen antworten schreibende Aufrufe mit 423 */
function nichtNurLesen() {
  if (MODUS === 'lesen') throw new ApiFehler(423, 'Gerade ist alles nur lesbar. Export und Anmelden gehen weiter.');
}
const appsVon: Record<string, VerbundeneApp[]> = {
  joern: [{ clientId: 'claude-ai', name: 'Claude', anbieter: 'Anthropic (claude.ai)', scopes: ['kern:lesen', 'kern:fragen'], verbunden: '2026-10-12T08:30:00Z', zuletzt: '2026-10-23T17:05:00Z' }],
};
const VOREINSTELLUNGEN: KiVoreinstellung[] = [
  { id: 'mistral', name: 'Mistral', art: 'openai', url: 'https://api.mistral.ai/v1', chatModelle: ['mistral-small-latest', 'mistral-medium-latest'], embedModelle: ['mistral-embed'], region: 'eu', quelle_geprueft: null, managed_erlaubt: true },
  { id: 'ionos', name: 'IONOS AI Model Hub', art: 'openai', url: 'https://openai.inference.de-txl.ionos.com/v1', chatModelle: ['meta-llama/Llama-3.3-70B-Instruct'], embedModelle: ['BAAI/bge-m3'], region: 'eu', quelle_geprueft: null, managed_erlaubt: true },
  { id: 'stackit', name: 'STACKIT AI Model Serving', art: 'openai', url: 'https://api.openai-compat.model-serving.eu01.onstackit.cloud/v1', chatModelle: ['neuralmagic/Meta-Llama-3.1-70B-Instruct-FP8'], embedModelle: [], region: 'eu', quelle_geprueft: null, managed_erlaubt: true },
  { id: 'scaleway', name: 'Scaleway Generative APIs', art: 'openai', url: 'https://api.scaleway.ai/v1', chatModelle: ['llama-3.3-70b-instruct'], embedModelle: ['bge-multilingual-gemma2'], region: 'eu', quelle_geprueft: null, managed_erlaubt: true },
  { id: 'ollama', name: 'Ollama (lokal)', art: 'ollama', url: 'http://localhost:11434', chatModelle: ['qwen2.5:14b'], embedModelle: ['bge-m3'], region: 'lokal', quelle_geprueft: null, managed_erlaubt: false },
  { id: 'anthropic', name: 'Anthropic', art: 'anthropic', url: 'https://api.anthropic.com', chatModelle: ['claude-sonnet-4-5'], embedModelle: [], region: 'usa', quelle_geprueft: null, managed_erlaubt: true },
];

const zugaenge: Record<string, ZugangsToken[]> = {
  joern: [
    {
      id: 't1',
      art: 'mcp',
      bezeichnung: 'Claude Desktop im Büro',
      geraet: 'Mac mini Büro',
      scopes: ['kern:lesen', 'kern:fragen'],
      erstellt: '2026-10-02T09:12:00Z',
      laeuftAb: '2026-12-31T09:12:00Z',
      zuletzt: '2026-10-23T16:40:00Z',
    },
  ],
};
const geraeteListe: Record<string, Geraet[]> = {};
function geraeteVon(id: string): Geraet[] {
  return (geraeteListe[id] ??= [
    { id: 's-dieses', geraet: 'Dieser Browser', erstellt: new Date().toISOString(), zuletzt: new Date().toISOString(), aktuell: true },
    { id: 's-handy', geraet: 'Safari auf iPhone', erstellt: '2026-10-20T06:55:00Z', zuletzt: '2026-10-23T19:02:00Z', aktuell: false },
    { id: 's-werkstatt', geraet: 'Firefox auf Windows, Werkstatt-PC', erstellt: '2026-10-11T07:10:00Z', zuletzt: '2026-10-22T12:31:00Z', aktuell: false },
  ]);
}
const ALLE_SCOPES: string[] = ['kern:lesen', 'kern:fragen', 'kern:vorschlagen', 'kern:bericht', 'kern:verwalten'];

const SCHLUESSEL = 'kern-mock-nutzer';

function warte(ms = 180 + Math.random() * 260): Promise<void> {
  const schnell = typeof navigator !== 'undefined' && navigator.webdriver;
  return new Promise((r) => setTimeout(r, schnell ? 40 : ms));
}

function aktuell(): MockNutzer {
  let id: string | null = null;
  try {
    id = sessionStorage.getItem(SCHLUESSEL);
  } catch {
    id = null;
  }
  const n = nutzer.find((x) => x.id === id);
  if (!n) throw new ApiFehler(401, 'Du bist nicht mehr angemeldet.');
  return n;
}

function oeffentlich(n: MockNutzer): User {
  return { id: n.id, name: n.name, rollen: [...n.rollen], teams: [...n.teams], ...(n.mussAendern ? { mussPasswortAendern: true } : {}) };
}

function darfSehen(u: User, s: string, besitzer?: string): boolean {
  if (s === 'betrieb') return true;
  if (s === 'ich') return besitzer === u.id;
  if (s.startsWith('team:')) return u.teams.includes(s.slice(5)) || u.rollen.includes('admin');
  return false;
}

function inReichweite(u: User, s: string, besitzer: string | undefined, r: Reichweite | undefined): boolean {
  if (!darfSehen(u, s, besitzer)) return false;
  if (!r || r === 'betrieb') return true;
  if (r === 'ich') return s === 'ich' && besitzer === u.id;
  return s === 'ich' || s.startsWith('team:');
}

function istFreigeber(u: User) {
  return u.rollen.includes('freigeber') || u.rollen.includes('admin');
}
function istAutor(u: User) {
  return istFreigeber(u) || u.rollen.includes('autor');
}

function brauche(cond: boolean, msg = 'Dafür fehlen dir die Rechte.') {
  if (!cond) throw new ApiFehler(403, msg);
}

function besitzerVonQuelle(q: Quelle) {
  return q.kopf.erfasst_von;
}

// ---------- Suche ----------

const STOPP = new Set(
  'der die das den dem des ein eine einer eines einem einen und oder aber wie was wer wo wann wieviel viel viele ist sind war bin bist hat haben wird werden ich du er sie es wir ihr mir mich dir dich uns euch sich im in an am auf aus bei mit nach von vor zu zum zur für fuer über ueber unter um nicht kein keine noch nur auch so dann denn dass ob wenn als bis man mal schon sehr ja nein bitte gibt soll sollen muss müssen kann können darf dürfen mache machen sag sage sagen steht stehen'.split(
    ' ',
  ),
);

export function begriffe(s: string): string[] {
  return normal(s)
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length > 2 && !STOPP.has(w))
    .map((w) => (w.length > 5 ? w.replace(/(en|er|es|e|n|s)$/, '') : w));
}

interface Abschnitt {
  pfad: string;
  art: 'wissen' | 'quelle';
  titel: string;
  abschnitt: string;
  zeilen: [number, number];
  text: string;
  sicht: string;
  besitzer?: string;
  sammlung: string;
}

function abschnitte(): Abschnitt[] {
  const aus: Abschnitt[] = [];
  const zerlege = (pfad: string, art: 'wissen' | 'quelle', titel: string, text: string, sicht: string, besitzer: string | undefined, sammlung: string) => {
    const zeilen = text.split('\n');
    let start = 0;
    let ueberschrift = titel;
    const schiebe = (ende: number) => {
      const t = zeilen.slice(start, ende).join('\n').trim();
      if (t) aus.push({ pfad, art, titel, abschnitt: ueberschrift, zeilen: [start + 1, ende], text: t, sicht, besitzer, sammlung });
    };
    zeilen.forEach((z, i) => {
      const m = /^#{1,4}\s+(.*)/.exec(z);
      if (m) {
        schiebe(i);
        start = i;
        ueberschrift = m[1].trim();
      }
    });
    schiebe(zeilen.length);
  };
  for (const a of daten.artikel) zerlege(a.pfad, 'wissen', a.kopf.titel, a.text, a.kopf.sichtbarkeit, a.kopf.besitzer, a.kopf.gruppe);
  for (const q of daten.quellen) zerlege(q.pfad, 'quelle', q.kopf.titel, q.text, q.kopf.sichtbarkeit, besitzerVonQuelle(q), q.kopf.sammlung);
  return aus;
}

function bewerte(ab: Abschnitt, q: string[]): number {
  const t = begriffe(ab.titel + ' ' + ab.abschnitt + ' ' + ab.text);
  const titel = new Set(begriffe(ab.titel + ' ' + ab.abschnitt));
  let p = 0;
  for (const w of new Set(q)) {
    const n = t.filter((x) => x === w || (w.length > 4 && x.startsWith(w))).length;
    if (n) p += 1 + Math.log(n) + (titel.has(w) ? 1.5 : 0);
  }
  if (ab.art === 'wissen') p *= 1.15;
  return p;
}

function sucheIntern(u: User, frage: string, opt: { reichweite?: Reichweite; sammlung?: string } = {}) {
  const q = begriffe(frage);
  if (!q.length) return [];
  return abschnitte()
    .filter((a) => inReichweite(u, a.sicht, a.besitzer, opt.reichweite))
    .filter((a) => !opt.sammlung || a.sammlung === opt.sammlung)
    .map((a) => ({ a, p: bewerte(a, q) }))
    .filter((e) => e.p > 0)
    .sort((x, y) => y.p - x.p);
}

function besterSatz(text: string, q: string[]): string {
  const saetze = text
    .replace(/^#+.*$/gm, '')
    .replace(/^>.*$/gm, '')
    .replace(/\[\^[^\]]+\](:.*)?/g, '')
    .split(/(?<=[.!?])\s+|\n+/)
    .map((s) => s.replace(/^[-*\d.)\s]+/, '').replace(/\*\*/g, '').trim())
    .filter((s) => s.length > 20);
  let best = saetze[0] ?? text.slice(0, 160);
  let bp = -1;
  for (const s of saetze) {
    const b = begriffe(s);
    const p = q.filter((w) => b.some((x) => x === w || x.startsWith(w))).length;
    if (p > bp) {
      bp = p;
      best = s;
    }
  }
  return best;
}

function dateiAus(file: string): Artikel | undefined {
  const slug = file.split('/').pop()!;
  return daten.artikel.find((a) => a.pfad.endsWith('/' + slug));
}

function beleg(pfad: string, text: string, abschnitt: string, zitat: string): Fundstelle {
  const b = findeBereich(text, zitat, undefined);
  return { quelle: pfad, abschnitt, zeilen: [Math.max(b.von, 1), Math.max(b.bis, 1)], zitat };
}

function kuratiert(u: User, frage: string): Antwort | null {
  const f = normal(frage);
  const regeln: [string, RegExp][] = [
    ['kratzer', /kratzer|reklamation|beschwer|schranktuer/],
    ['anzahlung', /anzahlung/],
    ['foto-ki', /foto.*\bki\b|\bki\b.*foto/],
    ['lackraum', /lueftung|lackraum/],
    ['stundensatz', /stundensatz|stundenlohn|kalkulation|zuschlag/],
  ];
  const id = regeln.find(([, r]) => r.test(f))?.[0];
  if (!id) return null;
  const k = daten.fragen.find((x) => x.id === id);
  if (!k) return null;
  const belege: Fundstelle[] = [];
  for (const s of k.sources) {
    if (s.unreleased) continue;
    const a = dateiAus(s.file);
    if (!a || !darfSehen(u, a.kopf.sichtbarkeit, a.kopf.besitzer)) continue;
    belege.push(beleg(a.pfad, a.text, s.heading ?? a.kopf.titel, s.quote));
  }
  if (k.kind === 'ok') {
    return {
      status: 'beantwortet',
      punkte: k.bullets.map(([text, b]) => ({ text, belege: b.filter((n) => n <= belege.length) })).filter((p) => p.belege.length),
      belege,
      hinweis: 'Antwort aus eurem Wissen. Prüf bei Maßen, Preisen und Terminen die Belege.',
    };
  }
  if (k.kind === 'missing') {
    return {
      status: 'steht_nicht_drin',
      punkte: [],
      belege,
      hinweis:
        'Die Nachlaufzeit steht nirgends im freigegebenen Wissen. Auf der Seite zur Werkstatt-Sicherheit steht nur „Lüftung an“. Im Eingang liegt ein Vorschlag vom 22.10.2026 zur Nachlaufzeit, der noch nicht freigegeben ist. Bis dahin: Frag Malte.',
    };
  }
  return {
    status: 'gehoert_nicht_hierher',
    punkte: [],
    belege,
    hinweis:
      'Stundensätze und Zuschläge stehen absichtlich nicht im Wissen, nur in der Tabelle „Kalkulation 2026“ im Büro. Darum nennt die KI auch keinen geschätzten Wert. Preise setzt Jörn.',
  };
}

const FREMD = /wetter|fussball|bundesliga|aktie|kochrezept|witz|lotto|horoskop/;

function frageIntern(u: User, frage: string, opt: { reichweite?: Reichweite; sammlung?: string }): Antwort {
  if (/testfehler/i.test(frage)) throw new ApiFehler(503, 'Die KI ist gerade nicht erreichbar. Versuch es in einer Minute noch einmal.');
  if (FREMD.test(normal(frage)))
    return {
      status: 'gehoert_nicht_hierher',
      punkte: [],
      belege: [],
      hinweis: 'Das hat mit eurem Betrieb nichts zu tun. Kern beantwortet nur Fragen zu dem, was in eurem Wissen und euren Dokumenten steht.',
    };
  const k = (!opt.reichweite || opt.reichweite === 'betrieb' || opt.reichweite === 'team') && !opt.sammlung ? kuratiert(u, frage) : null;
  if (k) return k;
  const q = begriffe(frage);
  const treffer = sucheIntern(u, frage, opt);
  const oben = treffer[0]?.p ?? 0;
  const gute = treffer.filter((t) => t.p >= Math.max(1.6, oben * 0.55));
  const gesehen = new Set<string>();
  const auswahl = gute.filter((t) => {
    const s = t.a.pfad + '#' + t.a.abschnitt;
    if (gesehen.has(s)) return false;
    gesehen.add(s);
    return true;
  }).slice(0, 3);
  if (!auswahl.length || oben < 1.6)
    return {
      status: 'steht_nicht_drin',
      punkte: [],
      belege: [],
      hinweis:
        opt.reichweite && opt.reichweite !== 'betrieb'
          ? 'In deiner gewählten Reichweite steht dazu nichts. Probier „Betrieb“ oder andere Wörter.'
          : 'Dazu steht in dem, was du sehen darfst, nichts. Probier andere Wörter oder leg das Wissen über „Hinzufügen“ an.',
    };
  const belege: Fundstelle[] = [];
  const punkte = auswahl.map((t, i) => {
    const satz = besterSatz(t.a.text, q);
    const voll = t.a.art === 'wissen' ? daten.artikel.find((a) => a.pfad === t.a.pfad)!.text : daten.quellen.find((x) => x.pfad === t.a.pfad)!.text;
    belege.push(beleg(t.a.pfad, voll, t.a.abschnitt, satz));
    return { text: satz, belege: [i + 1] };
  });
  return { status: 'beantwortet', punkte, belege, hinweis: 'Testmodus: Die Antwort besteht aus wörtlichen Sätzen der besten Fundstellen.' };
}

// ---------- Hinzufügen ----------

function slug(s: string): string {
  return normal(s).replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 48) || 'eintrag';
}

async function lies(datei: Blob | File | undefined): Promise<string> {
  if (!datei) return '';
  const name = datei instanceof File ? datei.name : 'aufnahme';
  if (/^text\//.test(datei.type) || /\.(md|txt|csv|html?)$/i.test(name)) {
    try {
      return await datei.text();
    } catch {
      return '';
    }
  }
  return '';
}

function vorschlagAusQuelle(q: Quelle, u: User): Vorschlag {
  const absaetze = q.text
    .split(/\n\n+/)
    .map((s) => s.trim())
    .filter((s) => s && !s.startsWith('#'));
  const kurz = (absaetze[0] ?? q.kopf.titel).slice(0, 280);
  const gruppe = slug(q.kopf.sammlung || 'allgemein');
  return {
    id: `v${naechsteId++}`,
    art: 'neu',
    ziel: `wissen/${gruppe}/${slug(q.kopf.titel)}.md`,
    alt: null,
    neu: `Kurz gesagt: ${kurz}\n\n## Aus der Quelle\n\n${absaetze.slice(1, 4).join('\n\n') || 'Weitere Punkte ergänzt die verantwortliche Person.'}\n`,
    grund: `Aus der neuen Quelle „${q.kopf.titel}“ (${q.pfad}). Die KI hat einen Artikel vorgeschlagen.`,
    von: `KI für ${u.name}`,
    erstellt: heuteIso(),
    status: 'offen',
  };
}


// ---------- v1.3 Lese-Engpass ----------

const LESEN_STANDARD: LeseEinstellungen = {
  stil: 'zusammenfassung',
  lesebudget_an: false,
  budget_hart: false,
  lesebudget_min_tag: 10,
  woerter_pro_minute: 200,
  max_offene_vorschlaege: 3,
  zustellzeiten: ['07:30'],
  modus_erst_ich: false,
  nur_abweichungen: true,
  verstaendnisfrage: 'stichprobe',
  regeln: [
    { id: 'r1', wenn: 'fakt_aendert', filter: { art: 'preis' }, dann: 'melden' },
    { id: 'r2', wenn: 'artikel_aendert', filter: { gruppe: 'Einarbeitung' }, dann: 'sammeln' },
  ],
};
// Lesedaten je Person, nur für diese Person abrufbar
const leseEinst: Record<string, LeseEinstellungen> = { joern: { ...structuredClone(LESEN_STANDARD), lesebudget_min_tag: 1 } };
const hinweisGezeigt: Record<string, number> = {};
const lesestand: Record<string, { objekt: string; punkt?: string; stufe: number; am: string }[]> = {};

function belegAus(slug: string, zitat: string): Fundstelle[] {
  const a = daten.artikel.find((x) => x.pfad.endsWith('/' + slug + '.md'));
  if (!a) return [];
  return [beleg(a.pfad, a.text, a.kopf.titel, zitat)];
}

function heuteFuer(u: User): Heute {
  const e = leseEinst[u.id] ?? LESEN_STANDARD;
  const offen = daten.vorschlaege.filter((v) => v.status === 'offen' || v.status === 'konflikt');
  const punkte: Punkt[] = [];
  const bg = daten.quellen.find((q) => q.kopf.beobachtung?.status === 'nicht_abrufbar');
  if (bg)
    punkte.push({
      id: 'P1',
      block: 'unsicher',
      satz: `Die Seite „${bg.kopf.titel}“ war nicht abrufbar, ihr Stand ist vom ${bg.kopf.erfasst_am.split('-').reverse().join('.')}.`,
      absatz: 'Die Seite sperrt automatische Abrufe. Kern umgeht das nicht. Was dort zu Unterweisungen steht, ist deshalb womöglich nicht aktuell. Am einfachsten: Malte lädt die Unterweisungshilfe als PDF herunter und legt sie ab.',
      belege: [],
      ampel: { farbe: 'gelb', grund: 'Beobachtete Quelle nicht abrufbar', regel: 'unsicher' },
    });
  if (offen.some((v) => v.status === 'konflikt'))
    punkte.push({
      id: 'P2',
      block: 'unsicher',
      satz: 'Vorschlag Nr. 55 trifft auf eine Datei, die inzwischen jemand im Editor geändert hat.',
      absatz: 'Kern hat nichts überschrieben. Im Eingang steht ein neuer Vergleich zwischen heutigem Stand und Vorschlag. Wer freigibt, entscheidet, was bleibt.',
      belege: belegAus('16-montage-beim-kunden', 'Werkzeug nach der Montage zählen, bevor der Transporter losfährt.'),
      ampel: { farbe: 'rot', grund: 'Konflikt im Eingang ist eine harte Pflicht', regel: 'pflicht:konflikt' },
    });
  if (offen.some((v) => v.id === 'v53'))
    punkte.push({
      id: 'P3',
      block: 'entscheiden',
      satz: 'Nr. 53: Nachlaufzeit der Lüftung im Lackraum (zehn Minuten) in die Werkstatt-Sicherheit aufnehmen? Empfehlung: erst Malte fragen.',
      absatz: 'Die Notiz kam am 22.10. aus der Werkstatt. Ob die zehn Minuten stimmen, ist nicht geprüft. Wenn nichts passiert, wissen neue Leute weiter nicht, dass die Lüftung nachläuft. Frist: keine, aber es betrifft die Sicherheit.',
      belege: belegAus('41-werkstatt-sicherheit', 'Lacke und Lösungsmittel nur im Lackraum, Lüftung an.'),
      ampel: { farbe: 'rot', grund: 'Du gibst frei, und der Vorschlag wartet seit 2 Tagen', regel: 'pflicht:vorschlag_wartet' },
    });
  if (offen.some((v) => v.id === 'v51'))
    punkte.push({
      id: 'P4',
      block: 'entscheiden',
      satz: 'Nr. 51: Lieferzeit für Beschläge im Angebot von zwei bis drei auf vier Wochen setzen? Empfehlung: ja, mit „Stand 10/2026“.',
      absatz: 'Die letzten drei Lieferungen haben vier Wochen gebraucht, bei Auftrag 26-118 musste die Montage verschoben werden. Der heutige Fakt gilt nur bis 05.11.2026. Wenn nichts passiert, stehen ab November falsche Lieferzeiten in den Angeboten.',
      belege: belegAus('12-angebot-schreiben', 'Für Beschläge rechnen wir mit zwei bis drei Wochen ab Bestellung.'),
      ampel: { farbe: 'gelb', grund: 'Team Büro betroffen, Fakt läuft in 12 Tagen ab', regel: 'regel:r1 fakt_aendert' },
    });
  punkte.push(
    {
      id: 'P5',
      block: 'entscheiden',
      satz: 'Prüftermin der Werkstatt-Sicherheit ist seit 15.10. überschritten. Empfehlung: mit der jährlichen Unterweisung zusammenlegen.',
      absatz: 'Verantwortlich ist Malte. Die letzte Fassung ist vom 03.03.2026. Wenn nichts passiert, bleibt der Artikel als überfällig markiert und taucht in jedem Prüflauf auf.',
      belege: belegAus('41-werkstatt-sicherheit', 'Unterweisung wird jährlich wiederholt, Malte lädt dazu ein.'),
      ampel: { farbe: 'gelb', grund: 'Team Werkstatt betroffen', regel: 'team' },
    },
    {
      id: 'P6',
      block: 'aendert_sich',
      satz: 'Bei Reklamationen bittet ihr seit 14.10. um zwei Fotos mit Maßstab.',
      absatz: 'Eins aus etwa zwei Metern Abstand, eins aus der Nähe mit Zollstock oder Münze. Malte musste vorher zweimal umsonst rausfahren.',
      belege: belegAus('18-reklamation', 'Den Kunden bitten, zwei Fotos zu schicken: eins aus etwa zwei Metern Abstand, eins aus der Nähe mit einem Zollstock oder einer Münze daneben.'),
      ampel: { farbe: 'gruen', grund: 'Schon freigegeben, betrifft vor allem das Büro', regel: 'rest' },
    },
    {
      id: 'P7',
      block: 'aendert_sich',
      satz: 'Die Lieferantenliste 2026 ersetzt den Stand vom April.',
      absatz: 'Die neue Fassung ist ohne Preise. Bestellt wird weiter über Malte, Kai vertritt.',
      belege: belegAus('14-material-bestellen', 'Malte bestellt, Kai vertritt.'),
      ampel: { farbe: 'gruen', grund: 'Keine Regel von dir betroffen', regel: 'rest' },
    },
    {
      id: 'P8',
      block: 'aendert_sich',
      satz: 'Neuer Artikelvorschlag aus Maltes Sprachnotiz: Transporter beladen.',
      absatz: 'Die KI hat aus der Sprachnotiz vom 23.10. einen neuen Artikel vorgeschlagen. Er liegt im Eingang, freigeben muss Sabine oder du.',
      belege: [],
      ampel: { farbe: 'gruen', grund: 'Neue Quelle, keine Frist', regel: 'regel:neue_quelle sammeln' },
    },
  );
  for (const x of punkte) x.neu_seit = x.id === 'P6' || x.id === 'P5' ? null : 'a-gestern';
  // Punkte ohne Beleg nur im Block „unsicher“ (v1.3 2.1)
  const gueltig = punkte.filter((p) => p.block === 'unsicher' || p.belege.length || p.id === 'P8');
  return {
    datum: heuteIso(),
    ansicht: {
      id: `a-${heuteIso()}-7f3c`,
      zweck: 'briefing',
      titel: 'Heute',
      generated: { by: 'agent/kern-0.3+mock', at: `${heuteIso()}T07:30:00+02:00` },
      gilt_bis: (() => {
        const d = new Date();
        d.setDate(d.getDate() + 1);
        return heuteIso(d);
      })(),
      basis_stand: `${heuteIso()}T06:58:00+02:00`,
      lesezeit_min: 0,
      status: 'aktuell',
    },
    budget: { minuten: e.lesebudget_min_tag, woerter_pro_minute: e.woerter_pro_minute },
    punkte: gueltig,
    ignorieren_anzahl: 6,
    zurueckgestellt: 0,
    zusammenfassung: [
      `Im Eingang warten ${offen.length} Vorschläge. Der wichtigste betrifft die Werkstatt: Aus einer Notiz vom 22.10. stammt der Vorschlag, die Nachlaufzeit der Lüftung im Lackraum (zehn Minuten) in die Werkstatt-Sicherheit aufzunehmen. Ob die zehn Minuten stimmen, hat noch niemand geprüft.`,
      '',
      'Kai schlägt vor, die Lieferzeit für Beschläge im Angebot auf vier Wochen zu setzen. Die letzten drei Lieferungen haben so lange gebraucht, und der heutige Wert gilt nur noch bis 05.11.2026. Ein Vorschlag (Nr. 55) trifft auf eine Datei, die Malte gestern im Editor geändert hat; Kern hat nichts überschrieben.',
      '',
      'Sonst: Die Lieferantenliste 2026 ersetzt den Stand vom April, aus Maltes Sprachnotiz ist ein Artikelvorschlag „Transporter beladen“ entstanden, und die Seite der Berufsgenossenschaft war beim Abruf gesperrt. Der Prüftermin der Werkstatt-Sicherheit ist seit 15.10. überschritten.',
    ].join('\n'),
    abweichungen: [
      'Seit deiner letzten Ansicht neu:',
      '',
      '- Vorschlag Nr. 55 trifft auf eine geänderte Datei (Konflikt).',
      '- Nr. 53 Lackraum und Nr. 51 Lieferzeit Beschläge warten auf dich.',
      '- Lieferantenliste 2026 ersetzt den Stand vom April.',
      '- Neuer Artikelvorschlag aus Maltes Sprachnotiz.',
    ].join('\n'),
  };
}

/** Heute mit harter Grenze, wie der Server es nach R4 tun soll. */
function heuteLeer(): Heute {
  const jetzt = new Date().toISOString();
  return {
    datum: heuteIso(),
    ansicht: { id: 'a-leer', zweck: 'briefing', titel: 'Heute', generated: { by: 'agent/kern-mock', at: jetzt }, gilt_bis: heuteIso(), basis_stand: jetzt, lesezeit_min: 0, status: 'aktuell' },
    budget: { minuten: 10, woerter_pro_minute: 200 },
    punkte: [],
    ignorieren_anzahl: 0,
    zurueckgestellt: 0,
    zusammenfassung: 'Noch ist hier nichts passiert. Sobald Dokumente dazukommen oder jemand etwas vorschlägt, steht es hier.',
    abweichungen: 'Keine Abweichungen.',
  };
}

function mitKennzeichen(h: Heute): Heute {
  const p = einstellungen.provider;
  h.ansicht = p.art === 'mock' ? { ...h.ansicht, ki_erzeugt: false, modell: null } : { ...h.ansicht, ki_erzeugt: true, modell: { anbieter: einstellungen.ki?.voreinstellung ?? p.art, name: p.chatModell ?? 'unbekannt' } };
  return h;
}

function heuteMitBudget(u: User): Heute {
  return mitKennzeichen(heuteMitBudgetRoh(u));
}

function heuteMitBudgetRoh(u: User): Heute {
  if (!daten.quellen.length && !daten.artikel.length) return heuteLeer();
  const h = heuteFuer(u);
  const e = leseEinst[u.id] ?? LESEN_STANDARD;
  // v1.3.1: harte Grenze nur im Fokus-Stil und nur, wenn der Nutzer sie selbst gewählt hat
  if (!(e.stil === 'fokus' && e.lesebudget_an && e.budget_hart)) return h;
  const grenze = h.budget.minuten * h.budget.woerter_pro_minute;
  const reihe = ['unsicher', 'entscheiden', 'aendert_sich'];
  const farbe = { rot: 0, gelb: 1, gruen: 2 };
  const sortiert = h.punkte.filter((p) => p.block !== 'ignorieren').sort((a, b) => reihe.indexOf(a.block) - reihe.indexOf(b.block) || farbe[a.ampel.farbe] - farbe[b.ampel.farbe]);
  const drin: Punkt[] = [];
  let w = 0;
  let zurueck = 0;
  for (const p of sortiert) {
    const n = (p.satz + ' ' + (p.absatz ?? '')).split(/\s+/).filter(Boolean).length;
    if (w + n <= grenze) {
      drin.push(p);
      w += n;
    } else zurueck++;
  }
  h.punkte = drin;
  h.zurueckgestellt = zurueck;
  h.ansicht.lesezeit_min = Math.round((w / h.budget.woerter_pro_minute) * 10) / 10;
  return h;
}

// ---------- API ----------

function blobUrl(text: string, typ = 'text/plain'): string {
  try {
    return URL.createObjectURL(new Blob([text], { type: `${typ};charset=utf-8` }));
  } catch {
    return '#';
  }
}

function alleFakten(u: User): Fakt[] {
  return daten.artikel
    .filter((a) => darfSehen(u, a.kopf.sichtbarkeit, a.kopf.besitzer))
    .flatMap((a) => (a.kopf.fakten ?? []).map((f) => ({ ...f, artikel: a.pfad })));
}

export const mockApi: KernApi = {
  async login(name, passwort) {
    await warte();
    const n = nutzer.find((x) => normal(x.name) === normal(name.trim()) || normal(x.id) === normal(name.trim()) || normal(x.name.split(' ')[0]) === normal(name.trim()));
    if (!n || n.passwort !== passwort) throw new ApiFehler(401, 'Name oder Passwort stimmt nicht.');
    try {
      sessionStorage.setItem(SCHLUESSEL, n.id);
    } catch {
      /* ohne Speicher bleibt man nur bis zum Neuladen angemeldet */
    }
    return oeffentlich(n);
  },
  async logout() {
    await warte(60);
    try {
      sessionStorage.removeItem(SCHLUESSEL);
    } catch {
      /* egal */
    }
  },
  async ich() {
    await warte(60);
    try {
      return oeffentlich(aktuell());
    } catch {
      return null;
    }
  },
  async wissen(gruppe) {
    await warte();
    const u = aktuell();
    return structuredClone(daten.artikel.filter((a) => darfSehen(u, a.kopf.sichtbarkeit, a.kopf.besitzer) && (!gruppe || a.kopf.gruppe === gruppe)));
  },
  async artikel(pfad) {
    await warte();
    const u = aktuell();
    const a = daten.artikel.find((x) => x.pfad === pfad);
    if (!a || !darfSehen(u, a.kopf.sichtbarkeit, a.kopf.besitzer)) throw new ApiFehler(404, 'Diesen Artikel gibt es nicht oder du darfst ihn nicht sehen.');
    return structuredClone(a);
  },
  async verlauf(pfad) {
    await warte();
    aktuell();
    return structuredClone(daten.verlauf[pfad] ?? []);
  },
  async quellen(sammlung) {
    await warte();
    const u = aktuell();
    return structuredClone(daten.quellen.filter((q) => darfSehen(u, q.kopf.sichtbarkeit, besitzerVonQuelle(q)) && (!sammlung || q.kopf.sammlung === sammlung)));
  },
  async quelle(pfad) {
    await warte();
    const u = aktuell();
    const q = daten.quellen.find((x) => x.pfad === pfad);
    if (!q || !darfSehen(u, q.kopf.sichtbarkeit, besitzerVonQuelle(q))) throw new ApiFehler(404, 'Dieses Dokument gibt es nicht oder du darfst es nicht sehen.');
    return structuredClone(q);
  },
  originalUrl(pfad) {
    const q = daten.quellen.find((x) => x.pfad === pfad);
    return blobUrl(q ? `Demo: Hier käme die Originaldatei „${q.kopf.herkunft}“.\n\n${q.text}` : 'Nicht gefunden');
  },
  async suche(q, opt = {}) {
    await warte();
    const u = aktuell();
    return sucheIntern(u, q, opt)
      .slice(0, 20)
      .map(
        ({ a, p }): Treffer => ({ pfad: a.pfad, art: a.art, titel: a.titel, abschnitt: a.abschnitt, zeilen: a.zeilen, ausschnitt: besterSatz(a.text, begriffe(q)), score: Math.round(p * 100) / 100 }),
      );
  },
  async frage(frage, opt = {}) {
    await warte(700 + Math.random() * 500);
    const u = aktuell();
    (startStand[u.id] ??= { fertig: false, ersteFrage: false }).ersteFrage = true;
    const a = frageIntern(u, frage, opt);
    const p = einstellungen.provider;
    // v1.4 D-L13: der Mock arbeitet ohne Sprachmodell, sagt das aber nur im Testmodus; mit „verbundenem“ Anbieter tut er so, als hätte das Modell geantwortet
    return p.art === 'mock' ? { ...a, ki_erzeugt: false, modell: null } : { ...a, ki_erzeugt: true, modell: { anbieter: einstellungen.ki?.voreinstellung ?? p.art, name: p.chatModell ?? 'unbekannt' } };
  },
  async hinzufuegen(e) {
    await warte(600);
    nichtNurLesen();
    const u = aktuell();
    brauche(istAutor(u), 'Zum Hinzufügen brauchst du mindestens die Rolle Autor.');
    if (!e.sammlung) throw new ApiFehler(400, 'Bitte wähl eine Sammlung.');
    let text = e.inhalt ?? '';
    let titel = e.titel?.trim() ?? '';
    let herkunft = e.url ?? '';
    if (e.art === 'web') {
      if (!e.url || !/^https?:\/\//.test(e.url)) throw new ApiFehler(400, 'Die Adresse muss mit http:// oder https:// anfangen.');
      titel ||= e.url.replace(/^https?:\/\//, '').split('/')[0];
      text = `Demo: Inhalt der Seite ${e.url}. Im echten Betrieb liest Kern die Seite und wandelt sie in Text um.`;
    } else if (e.datei) {
      const name = e.dateiname ?? (e.datei instanceof File ? e.datei.name : 'aufnahme.webm');
      herkunft = name;
      titel ||= name.replace(/\.[^.]+$/, '');
      text = (await lies(e.datei)) || (e.art === 'audio' ? 'Wartet auf Transkript.' : `Demo: Text aus „${name}“ (${Math.max(1, Math.round(e.datei.size / 1024))} KB). Im echten Betrieb erkennt Kern PDF, Word und Text.`);
    } else if (!text.trim()) throw new ApiFehler(400, 'Da fehlt der Inhalt.');
    titel ||= text.split('\n')[0].slice(0, 60);
    const jahr = heuteIso().slice(0, 4);
    let pfad = `quellen/${jahr}/${slug(titel)}.md`;
    const ersetzt = daten.quellen.find((x) => x.kopf.herkunft === herkunft && herkunft)?.pfad ?? null;
    if (daten.quellen.some((x) => x.pfad === pfad)) pfad = pfad.replace(/\.md$/, `-${naechsteId}.md`);
    const quelle: Quelle = {
      pfad,
      kopf: {
        titel,
        art: e.art,
        herkunft: herkunft || 'Eingabe im Browser',
        erfasst_am: heuteIso(),
        erfasst_von: u.id,
        sichtbarkeit: e.sichtbarkeit,
        sammlung: e.sammlung,
        hash: 'sha256:' + Array.from({ length: 64 }, (_, i) => ((i * 7 + text.length) % 16).toString(16)).join(''),
        ersetzt,
        beobachtet: !!e.beobachten,
      },
      text: `# ${titel}\n\n${text}\n`,
    };
    daten.quellen.unshift(quelle);
    const vorschlaege = e.art === 'audio' && text === 'Wartet auf Transkript.' ? [] : [vorschlagAusQuelle(quelle, u)];
    daten.vorschlaege.unshift(...vorschlaege);
    return structuredClone({ quelle, vorschlaege });
  },
  async eingang() {
    await warte();
    const u = aktuell();
    return structuredClone(daten.vorschlaege.filter((v) => {
      const a = daten.artikel.find((x) => x.pfad === v.ziel);
      return !a || darfSehen(u, a.kopf.sichtbarkeit, a.kopf.besitzer);
    }));
  },
  async entscheide(id, e) {
    await warte(400);
    const u = aktuell();
    brauche(istFreigeber(u), 'Freigeben und Ablehnen dürfen nur Freigeber und Admins.');
    const v = daten.vorschlaege.find((x) => x.id === id);
    if (!v) throw new ApiFehler(404, 'Diesen Vorschlag gibt es nicht mehr.');
    if (v.status !== 'offen' && v.status !== 'konflikt') throw new ApiFehler(409, 'Über diesen Vorschlag wurde schon entschieden.');
    if (v.ziel.startsWith('wissen/_regeln/')) brauche(u.rollen.includes('admin'), 'Regeln gibt nur ein Admin frei.');
    const zielArtikel = daten.artikel.find((x) => x.pfad === v.ziel);
    // v1.2 Konfliktschutz: Datei inzwischen geändert? Dann nicht überschreiben, sondern neu vergleichen lassen.
    if (e.aktion !== 'ablehnen' && v.status === 'offen' && v.basis_hash && zielArtikel && hashVon(zielArtikel.text) !== v.basis_hash) {
      v.status = 'konflikt';
      return structuredClone(v);
    }
    if (e.aktion === 'ablehnen') {
      if (!e.begruendung?.trim()) throw new ApiFehler(400, 'Zum Ablehnen brauchst du eine Begründung.');
      v.status = 'abgelehnt';
    } else {
      const text = e.aktion === 'aendern' ? (e.neuerText ?? v.neu) : v.neu;
      if (e.aktion === 'aendern') v.neu = text;
      const a = daten.artikel.find((x) => x.pfad === v.ziel);
      if (v.art === 'loeschung') daten.artikel = daten.artikel.filter((x) => x.pfad !== v.ziel);
      else if (a) {
        a.text = text;
        a.kopf.stand = heuteIso();
        a.kopf.status = 'freigegeben';
        a.kopf.verified = [{ by: u.name, at: heuteIso(), commit: Math.random().toString(16).slice(2, 9) }, ...(a.kopf.verified ?? [])];
      } else {
        const gruppe = v.ziel.split('/')[1] ?? 'allgemein';
        const titel = (v.ziel.split('/').pop() ?? 'neu').replace(/\.md$/, '').replace(/^\d+-/, '').replace(/-/g, ' ');
        daten.artikel.push({
          pfad: v.ziel,
          kopf: {
            titel: titel.charAt(0).toUpperCase() + titel.slice(1),
            gruppe: gruppe.charAt(0).toUpperCase() + gruppe.slice(1).replace('ae', 'ä'),
            kurzfassung: text.split('\n')[0].replace(/^Kurz gesagt:\s*/, ''),
            stand: heuteIso(),
            verantwortlich: u.name,
            pruefen_bis: `${+heuteIso().slice(0, 4) + 1}${heuteIso().slice(4)}`,
            sichtbarkeit: 'betrieb',
            besitzer: u.id,
            fundstellen: [],
            status: 'freigegeben',
            type: 'Artikel',
            verified: [{ by: u.name, at: heuteIso() }],
          },
          text,
        });
      }
      daten.verlauf[v.ziel] = [
        { commit: Math.random().toString(16).slice(2, 9), von: u.name, am: heuteIso(), grund: `Freigegeben: ${v.grund.split('. ')[0]}` },
        ...(daten.verlauf[v.ziel] ?? []),
      ];
      v.status = 'freigegeben';
    }
    v.entscheidung = { von: u.name, am: heuteIso(), ...(e.begruendung ? { begruendung: e.begruendung } : {}) };
    return structuredClone(v);
  },
  async vorschlag(v) {
    await warte(300);
    const u = aktuell();
    brauche(istAutor(u), 'Vorschläge machen dürfen Autoren, Freigeber und Admins.');
    if (!v.grund?.trim()) throw new ApiFehler(400, 'Bitte schreib kurz, warum du das ändern willst.');
    const neu: Vorschlag = { ...v, id: `v${naechsteId++}`, von: u.name, erstellt: heuteIso(), status: 'offen' };
    daten.vorschlaege.unshift(neu);
    return structuredClone(neu);
  },
  async briefing(seit) {
    await warte();
    const u = aktuell();
    const b = daten.briefing;
    const offen = daten.vorschlaege.filter((v) => v.status === 'offen').length;
    const faellig = daten.artikel.filter((a) => a.kopf.pruefen_bis && tageZwischen(heuteIso(), a.kopf.pruefen_bis) < 0).length;
    const text = [
      `${u.name.split(' ')[0]}, ${offen === 0 ? 'im Eingang wartet nichts.' : offen === 1 ? 'im Eingang wartet ein Vorschlag.' : `im Eingang warten ${offen} Vorschläge.`} ${faellig ? `${faellig === 1 ? 'Ein Artikel ist' : `${faellig} Artikel sind`} über dem Prüftermin.` : ''}`.trim(),
      '',
      seit ? `Was seit ${seit.split('-').reverse().join('.')} neu ist:` : 'Was neu ist:',
      '',
      ...b.neu.map((n) => `- ${n.t}`),
      '',
      'Hinweis: ' + b.hinweise.map((h) => h.t).join(' '),
      '',
      'Die Lieferzeit für Beschläge (2 bis 3 Wochen) gilt nur noch bis 05.11.2026.',
    ].join('\n');
    return {
      datum: heuteIso(),
      text,
      entscheidungen: b.entscheidungen.map((e) => `${e.t} Empfehlung: ${e.emp}`),
      links: ['#/eingang', '#/wissen/einarbeitung/41-werkstatt-sicherheit.md', '#/fakten'],
    };
  },
  async faellig() {
    await warte();
    const u = aktuell();
    return structuredClone(
      daten.artikel.filter((a) => darfSehen(u, a.kopf.sichtbarkeit, a.kopf.besitzer) && a.kopf.pruefen_bis && tageZwischen(heuteIso(), a.kopf.pruefen_bis) < 0),
    );
  },
  async fakten(f = {}) {
    await warte();
    const u = aktuell();
    return alleFakten(u).filter((x) => {
      if (f.art && x.art !== f.art) return false;
      if (f.gegenstand && !normal(x.gegenstand).includes(normal(f.gegenstand))) return false;
      if (f.gueltig_am) {
        if (x.gilt_ab && x.gilt_ab > f.gueltig_am) return false;
        if (x.gilt_bis && x.gilt_bis < f.gueltig_am) return false;
      }
      return true;
    });
  },
  async pruefen() {
    await warte(900);
    const u = aktuell();
    brauche(istFreigeber(u), 'Den Prüflauf starten dürfen nur Freigeber und Admins.');
    const befunde: Befund[] = [];
    for (const f of alleFakten(u)) {
      if (f.gilt_bis && f.gilt_bis < heuteIso()) befunde.push({ art: 'fakt_abgelaufen', text: `Fakt „${f.gegenstand}“ galt nur bis ${f.gilt_bis.split('-').reverse().join('.')}.`, pfad: f.artikel, schwere: 'warnung' });
    }
    for (const a of daten.artikel) {
      if (a.text.length > 8000) befunde.push({ art: 'zu_lang', text: `„${a.kopf.titel}“ ist länger als 8 KB.`, pfad: a.pfad, schwere: 'hinweis' });
      if (a.kopf.status === 'veraltet') befunde.push({ art: 'veraltet', text: `„${a.kopf.titel}“ ist als veraltet markiert.`, pfad: a.pfad, schwere: 'hinweis' });
    }
    befunde.push({ art: 'widerspruch', text: 'Lieferzeit Beschläge: Artikel „Angebot schreiben“ nennt 2 bis 3 Wochen, die Lieferantenliste vom 21.10.2026 nennt 4 Wochen.', pfad: 'wissen/ablaeufe/12-angebot-schreiben.md', schwere: 'warnung' });
    const neu: Vorschlag[] = befunde
      .filter((b) => b.schwere === 'warnung')
      .map((b) => {
        const a = daten.artikel.find((x) => x.pfad === b.pfad);
        return {
          id: `v${naechsteId++}`,
          art: 'aenderung' as const,
          ziel: b.pfad ?? '',
          alt: a?.text ?? '',
          neu: (a?.text ?? '').trimEnd() + `\n\n> Prüflauf ${heuteIso().split('-').reverse().join('.')}: ${b.text} Bitte prüfen.\n`,
          grund: `Prüflauf: ${b.text}`,
          von: 'Prüflauf',
          erstellt: heuteIso(),
          status: 'offen' as const,
        };
      });
    daten.vorschlaege.unshift(...neu);
    return { befunde, vorschlaege: neu.length };
  },
  async heute() {
    await warte();
    return heuteMitBudget(aktuell());
  },
  async gelesen(e) {
    const u = aktuell();
    (lesestand[u.id] ??= []).push({ ...e, am: new Date().toISOString() });
  },
  async lesen() {
    await warte();
    const u = aktuell();
    return structuredClone(leseEinst[u.id] ?? LESEN_STANDARD);
  },
  async speichereLesen(e) {
    await warte(300);
    const u = aktuell();
    if (e.lesebudget_min_tag < 1 || e.lesebudget_min_tag > 120) throw new ApiFehler(400, 'Das Lesebudget muss zwischen 1 und 120 Minuten liegen.');
    if (e.zustellzeiten.length > 3) throw new ApiFehler(400, 'Höchstens drei Zustellzeiten am Tag.');
    leseEinst[u.id] = structuredClone(e);
    return structuredClone(e);
  },
  async lesebilanz() {
    await warte();
    const u = aktuell();
    const geoeffnet = (lesestand[u.id] ?? []).filter((x) => x.stufe >= 2).length;
    // sanfter Hinweis, höchstens einmal pro Sitzung, nur für die Person selbst
    const e = leseEinst[u.id] ?? LESEN_STANDARD;
    const hinweis = e.stil === 'zusammenfassung' && !hinweisGezeigt[u.id] ? { text: 'Diese Woche hast du etwa 23 Minuten Zusammenfassungen gelesen. Magst du die Entscheidungsvorlage ausprobieren? Sie zeigt nur, was sich ändert und was du entscheiden sollst.', vorschlag: 'entscheidung' as const } : null;
    hinweisGezeigt[u.id] = (hinweisGezeigt[u.id] ?? 0) + 1;
    return {
      hinweis,
      nieGeoeffnet: [
        { zweck: 'agentenbericht', regel: 'agent/nachtlauf', anzahl: 9, von: 10 },
        { zweck: 'briefing', anzahl: Math.max(0, 4 - geoeffnet), von: 7 },
      ],
      vorschlaege: ['Agentenberichte von agent/nachtlauf: 9 von 10 nie geöffnet. Abschalten oder auf „sammeln“ stellen?'],
    };
  },
  async neueAnsicht(e) {
    await warte(600);
    const u = aktuell();
    const h = heuteMitBudget(u);
    return { ...h.ansicht, zweck: e.zweck };
  },
  async einschaetzung(e) {
    await warte(700);
    const u = aktuell();
    const a = frageIntern(u, e.bezug, {});
    const eigene = new Set(begriffe(e.text));
    const punkte: Punkt[] = a.punkte.map((p, i) => ({
      id: `E${i + 1}`,
      block: 'aendert_sich',
      satz: p.text,
      absatz: null,
      belege: p.belege.map((n) => a.belege[n - 1]).filter(Boolean),
      ampel: { farbe: 'gruen', grund: '', regel: '' },
    }));
    const deckung = (p: Punkt) => {
      const b = begriffe(p.satz);
      return b.filter((w) => eigene.has(w)).length / Math.max(1, b.length);
    };
    const zahlen = (t: string) => new Set(t.match(/\d+([.,]\d+)?/g) ?? []);
    const eigeneZahlen = zahlen(e.text);
    const widerspricht = punkte.filter((p) => {
      const z = [...zahlen(p.satz)];
      return eigeneZahlen.size > 0 && z.length > 0 && !z.some((x) => eigeneZahlen.has(x)) && deckung(p) >= 0.15;
    });
    const fehlt = punkte.filter((p) => !widerspricht.includes(p) && deckung(p) < 0.3);
    const abgleich: Abgleich = { fehlt, widerspricht, uebereinstimmend_anzahl: punkte.length - fehlt.length - widerspricht.length };
    return abgleich;
  },
  async meldeFehler(f) {
    await warte(300);
    aktuell();
    if (!f.falsch.trim()) throw new ApiFehler(400, 'Was war falsch?');
    return { id: `f-${heuteIso()}-${String(naechsteId++).padStart(2, '0')}` };
  },
  async datenweg() {
    await warte();
    aktuell();
    const p = einstellungen.provider;
    const u0 = aktuell();
    const apps = (appsVon[u0.id] ?? []).map((a) => ({ name: a.name, anbieter: a.anbieter }));
    const basis = {
      apps,
      daten: ['deine Frage', 'die gefundenen Abschnitte (höchstens 8), nur aus dem, was du sehen darfst', 'beim Kompilieren: der Text der neuen Quelle'],
      nie: ['Passwörter und Benutzerliste', 'Dokumente, die du nicht sehen darfst', 'der ganze Ordner auf einmal'],
    };
    if (p.art === 'mock')
      return { art: 'mock', anbieter: 'Testmodus ohne KI', endpunkt: null, region: 'auf diesem Server', lokal: true, ...basis, daten: [], hinweis: 'Es geht nichts nach außen. Antworten bestehen aus wörtlichen Sätzen der Fundstellen.' };
    if (p.art === 'ollama') return { art: 'ollama', anbieter: 'Ollama (lokal)', endpunkt: p.url ?? null, region: 'eigener Rechner', lokal: true, ...basis };
    if (p.art === 'anthropic') return { art: 'anthropic', anbieter: 'Anthropic', endpunkt: 'https://api.anthropic.com', region: 'USA', lokal: false, ...basis, hinweis: 'Fragen und gefundene Abschnitte gehen an Anthropic, Server in den USA (Drittland).' };
    return { art: 'openai', anbieter: 'OpenAI-kompatibler Anbieter', endpunkt: p.url ?? null, region: /ionos|stackit|mistral/i.test(p.url ?? '') ? 'EU' : 'laut Anbieter', lokal: false, ...basis };
  },
  async importieren(e) {
    await warte(900);
    const u = aktuell();
    brauche(istAutor(u), 'Importieren dürfen Autoren, Freigeber und Admins.');
    if (!e.datei && !e.pfad) throw new ApiFehler(400, 'Wähl eine Export-Datei oder gib einen Ordner auf dem Server an.');
    const name = e.datei?.name ?? e.pfad ?? 'import';
    const quelle: Quelle = {
      pfad: `quellen/${heuteIso().slice(0, 4)}/import-${e.art}-${slug(name)}.md`,
      kopf: { titel: `Import aus ${e.art[0].toUpperCase() + e.art.slice(1)}: ${name}`, art: 'datei', herkunft: name, erfasst_am: heuteIso(), erfasst_von: u.id, sichtbarkeit: e.sichtbarkeit, sammlung: e.sammlung, hash: 'sha256:' + '1'.repeat(64), ersetzt: null, beobachtet: false },
      text: `# Import ${name}\n\nDemo: Hier stünden die importierten Seiten.\n`,
    };
    daten.quellen.unshift(quelle);
    const v = vorschlagAusQuelle(quelle, u);
    daten.vorschlaege.unshift(v);
    return { quellen: 1, vorschlaege: 1, hinweise: ['Demo: Im echten Betrieb wird jede Seite eine eigene Quelle.', 'Anhänge über 25 MB wurden übersprungen.'] };
  },
  async einstellungen() {
    await warte();
    const u = aktuell();
    const e = structuredClone(einstellungen);
    if (!u.rollen.includes('admin')) e.provider = { art: e.provider.art, url: null, chatModell: null, embedModell: null };
    return { ...e, managed: MANAGED, voreinstellungen: VOREINSTELLUNGEN.filter((v) => !MANAGED || v.managed_erlaubt), ki: e.ki ?? { status: e.provider.art === 'mock' ? 'ohne_ki' : 'geprueft', voreinstellung: null } };
  },
  async speichereEinstellungen(e) {
    await warte(400);
    const u = aktuell();
    brauche(u.rollen.includes('admin'), 'Einstellungen ändern dürfen nur Admins.');
    if (MANAGED && e.provider.art === 'ollama') throw new ApiFehler(400, 'Im betreuten Betrieb geht nur ein Anbieter aus der Liste.');
    const wechsel = e.provider.art !== einstellungen.provider.art || e.provider.url !== einstellungen.provider.url || e.provider.chatModell !== einstellungen.provider.chatModell;
    const { apiKey, ...rest } = e.provider;
    einstellungen = {
      ...e,
      provider: { ...rest, hatSchluessel: apiKey ? true : einstellungen.provider.hatSchluessel && rest.art === einstellungen.provider.art },
      ki: wechsel ? { status: rest.art === 'mock' ? 'ohne_ki' : 'ungeprueft', voreinstellung: e.ki?.voreinstellung ?? null, vorher: true } : einstellungen.ki,
    };
    return structuredClone(einstellungen);
  },
  async benutzer() {
    await warte();
    const u = aktuell();
    brauche(u.rollen.includes('admin'), 'Die Benutzerliste sehen nur Admins.');
    return nutzer.map(oeffentlich);
  },
  async legeBenutzerAn(b) {
    await warte(400);
    const u = aktuell();
    brauche(u.rollen.includes('admin'), 'Benutzer anlegen dürfen nur Admins.');
    if (!b.name.trim()) throw new ApiFehler(400, 'Bitte gib einen Namen ein.');
    if (b.passwort.length < 10) throw new ApiFehler(400, 'Das Passwort braucht mindestens 10 Zeichen.');
    if (nutzer.some((n) => normal(n.name) === normal(b.name))) throw new ApiFehler(409, 'Diesen Namen gibt es schon.');
    const n: MockNutzer = { id: slug(b.name), name: b.name.trim(), rollen: b.rollen.length ? b.rollen : ['leser'], teams: b.teams, passwort: b.passwort };
    nutzer.push(n);
    return oeffentlich(n);
  },
  async setzePasswortZurueck(id) {
    await warte(300);
    const u = aktuell();
    brauche(u.rollen.includes('admin'), 'Passwörter zurücksetzen dürfen nur Admins.');
    const n = nutzer.find((x) => x.id === id);
    if (!n) throw new ApiFehler(404, 'Diese Person gibt es nicht.');
    const einmal = Array.from(crypto.getRandomValues(new Uint8Array(9)), (b) => 'abcdefghjkmnpqrstuvwxyz23456789'[b % 31]).join('');
    n.passwort = einmal;
    n.mussAendern = true;
    zugaenge[id] = [];
    return { einmalPasswort: einmal };
  },
  async widerrufeTokensVon(id) {
    await warte(200);
    brauche(aktuell().rollen.includes('admin'), 'Nur Admins.');
    zugaenge[id] = [];
  },
  async aenderePasswort(alt, neu) {
    await warte(400);
    const n = aktuell();
    if (n.passwort !== alt) throw new ApiFehler(403, 'Das bisherige Passwort stimmt nicht.');
    if (neu.length < 10) throw new ApiFehler(400, 'Das neue Passwort braucht mindestens 10 Zeichen.');
    if (neu === alt) throw new ApiFehler(400, 'Das neue Passwort muss sich vom alten unterscheiden.');
    n.passwort = neu;
    n.mussAendern = false;
    geraeteListe[n.id] = geraeteVon(n.id).filter((g) => g.aktuell);
    const anzahl = (zugaenge[n.id] ?? []).length;
    zugaenge[n.id] = [];
    void anzahl;
  },
  async abmeldenUeberall() {
    await warte(300);
    const n = aktuell();
    const anzahl = (zugaenge[n.id] ?? []).length;
    zugaenge[n.id] = [];
    delete geraeteListe[n.id];
    try {
      sessionStorage.removeItem(SCHLUESSEL);
    } catch {
      /* egal */
    }
    return { tokensWiderrufen: anzahl };
  },
  async geraete() {
    await warte();
    return structuredClone(geraeteVon(aktuell().id));
  },
  async meldeGeraetAb(id) {
    await warte(200);
    const n = aktuell();
    const g = geraeteVon(n.id).find((x) => x.id === id);
    if (!g) throw new ApiFehler(404, 'Dieses Gerät ist schon abgemeldet.');
    if (g.aktuell) throw new ApiFehler(400, 'Dieses Gerät meldest du oben über „Abmelden“ ab.');
    geraeteListe[n.id] = geraeteVon(n.id).filter((x) => x.id !== id);
  },
  async tokens() {
    await warte();
    return structuredClone(zugaenge[aktuell().id] ?? []);
  },
  async legeTokenAn(e) {
    await warte(300);
    const n = aktuell();
    const scopes: TokenScope[] = e.scopes?.length ? e.scopes : ['kern:lesen', 'kern:fragen'];
    if (scopes.some((x) => !ALLE_SCOPES.includes(x))) throw new ApiFehler(400, 'Unbekannte Berechtigung.');
    if (scopes.includes('kern:verwalten') && !n.rollen.includes('admin')) throw new ApiFehler(403, 'Verwalten dürfen nur Admins freigeben.');
    const tage = e.gueltigTage ?? 90;
    if (tage < 1 || tage > 365) throw new ApiFehler(400, 'Gültig zwischen 1 und 365 Tagen.');
    const zufall = Array.from(crypto.getRandomValues(new Uint8Array(24)), (b) => b.toString(16).padStart(2, '0')).join('');
    const jetzt = new Date();
    const eintrag: ZugangsToken = {
      id: `t${Date.now().toString(36)}`,
      art: 'mcp',
      bezeichnung: e.bezeichnung?.trim() || 'Zugang ohne Namen',
      geraet: e.geraet ?? null,
      scopes: [...scopes],
      erstellt: jetzt.toISOString(),
      laeuftAb: new Date(jetzt.getTime() + tage * 86400000).toISOString(),
      zuletzt: null,
    };
    (zugaenge[n.id] ??= []).unshift(eintrag);
    return { token: `kern_${zufall}`, eintrag, hinweis: 'Der Schlüssel wird nur jetzt angezeigt.' };
  },
  async widerrufeToken(id) {
    await warte(200);
    const n = aktuell();
    const l = zugaenge[n.id] ?? [];
    if (!l.some((t) => t.id === id)) throw new ApiFehler(404, 'Diesen Schlüssel gibt es nicht mehr.');
    zugaenge[n.id] = l.filter((t) => t.id !== id);
  },
  async einrichtung(): Promise<Einrichtung | null> {
    await warte(80);
    const u = aktuell();
    if (!u.rollen.includes('admin')) return null;
    const st = startStand[u.id] ?? { fertig: MODUS !== 'neu', ersteFrage: MODUS !== 'neu' };
    const titel = daten.quellen.slice(0, 3).map((q) => q.kopf.titel);
    return {
      schritt: st.fertig ? 'fertig' : einrichtungWeg ? (daten.quellen.length ? 'erste_frage' : 'unterlagen') : 'ki',
      ki: { weg: einrichtungWeg, voreinstellung: einstellungen.ki?.voreinstellung ?? null, status: einstellungen.ki?.status ?? 'ohne_ki' },
      beispiel_geladen: beispielGeladen,
      vorschlagsfragen: beispielGeladen
        ? ['Ein Kunde ruft an, an seiner neuen Schranktür ist ein Kratzer. Was tun wir?', 'Wie viel Anzahlung nehmen wir bei einer Treppe für 2.400 €?', 'Wer entscheidet über Kulanz?']
        : titel.map((t) => `Was steht in „${t}“?`),
      erste_belegte_antwort: st.ersteFrage ? { am: new Date().toISOString(), sekunden_seit_start: 212 } : null,
      test_ki_verfuegbar: MANAGED,
    };
  },
  async einrichtungKi(e) {
    await warte(900);
    const u = aktuell();
    brauche(u.rollen.includes('admin'), 'Nur Admins.');
    einrichtungWeg = e.weg;
    if (e.weg === 'ohne' || e.weg === 'app') {
      einstellungen = { ...einstellungen, provider: { art: 'mock' }, ki: { status: 'ohne_ki', voreinstellung: null } };
      return { verbindung: 'ok', meldung: e.weg === 'app' ? 'Die App meldet sich selbst an. Antworten in der Weboberfläche laufen ohne KI.' : 'Ohne KI: Antworten sind wörtliche Auszüge mit Fundstelle.' };
    }
    if (e.weg === 'hd_test') {
      einstellungen = { ...einstellungen, provider: { art: 'openai', chatModell: 'mistral-small-latest', anbieter: 'hd_test' }, ki: { status: 'ungeprueft', voreinstellung: 'hd_test' } };
      return { verbindung: 'ok', meldung: 'Test-KI von HD verbunden (Mistral, EU). Antwort in 0,7 Sekunden.' };
    }
    const v = VOREINSTELLUNGEN.find((x) => x.id === e.voreinstellung);
    if (!v) return { verbindung: 'fehler', meldung: 'Diese Voreinstellung gibt es nicht.' };
    if (MANAGED && !v.managed_erlaubt) return { verbindung: 'fehler', meldung: 'Im betreuten Betrieb nicht freigegeben.' };
    if (v.art !== 'ollama' && !e.schluessel) return { verbindung: 'fehler', meldung: 'Ohne Schlüssel antwortet der Anbieter nicht.' };
    if (e.schluessel && e.schluessel.length < 12) return { verbindung: 'fehler', meldung: 'Der Anbieter lehnt den Schlüssel ab (401). Prüf, ob du ihn vollständig kopiert hast.' };
    einstellungen = { ...einstellungen, provider: { art: v.art, url: e.url ?? v.url, chatModell: e.chatModell || v.chatModelle[0], hatSchluessel: !!e.schluessel }, ki: { status: 'ungeprueft', voreinstellung: v.id, vorher: true } };
    return { verbindung: 'ok', meldung: `${v.name} verbunden. Antwort in ${(0.6 + Math.random() * 0.5).toLocaleString('de-DE', { maximumFractionDigits: 1 })} Sekunden.` };
  },
  async einrichtungBeispiel(aktion) {
    await warte(600);
    const u = aktuell();
    brauche(u.rollen.includes('admin'), 'Nur Admins.');
    if (aktion === 'laden') {
      if (beispielVorrat && !beispielGeladen) {
        daten.artikel.push(...beispielVorrat.artikel);
        daten.quellen.push(...beispielVorrat.quellen);
        daten.vorschlaege.push(...beispielVorrat.vorschlaege);
      }
      beispielGeladen = true;
    } else {
      if (beispielVorrat && beispielGeladen) {
        const weg = <T,>(l: T[], vorrat: T[]) => vorrat.forEach((x) => l.includes(x) && l.splice(l.indexOf(x), 1));
        weg(daten.artikel, beispielVorrat.artikel);
        weg(daten.quellen, beispielVorrat.quellen);
        weg(daten.vorschlaege, beispielVorrat.vorschlaege);
      }
      beispielGeladen = false;
    }
  },
  async einrichtungFertig() {
    await warte(80);
    (startStand[aktuell().id] ??= { fertig: false, ersteFrage: false }).fertig = true;
  },
  async speichereKiSchluessel(anbieter, schluessel) {
    await warte(300);
    brauche(aktuell().rollen.includes('admin'), 'Nur Admins.');
    if (schluessel.length < 12) throw new ApiFehler(400, 'Der Schlüssel ist zu kurz.');
    einstellungen = { ...einstellungen, provider: { ...einstellungen.provider, hatSchluessel: true }, ki: { status: 'ungeprueft', voreinstellung: anbieter } };
  },
  async kiZurueck() {
    await warte(300);
    brauche(aktuell().rollen.includes('admin'), 'Nur Admins.');
    einstellungen = { ...einstellungen, provider: { art: 'mock' }, ki: { status: 'ohne_ki', voreinstellung: null } };
    return structuredClone(einstellungen);
  },
  async pruefbankLauf() {
    await warte(1400);
    brauche(aktuell().rollen.includes('admin'), 'Nur Admins.');
    const p = einstellungen.provider;
    const schwach = /small|7b|8b/i.test(p.chatModell ?? '');
    letzterLauf = {
      id: `pb-${Date.now().toString(36)}`,
      am: new Date().toISOString(),
      status: 'fertig',
      anbieter: einstellungen.ki?.voreinstellung ?? p.art,
      modell: p.chatModell ?? (p.art === 'mock' ? 'ohne KI' : null),
      belegtreue: schwach ? 0.91 : 0.97,
      lecks: 0,
      injektion: 1,
      bestanden: !schwach,
    };
    einstellungen = { ...einstellungen, ki: { ...(einstellungen.ki ?? { voreinstellung: null }), status: p.art === 'mock' ? 'ohne_ki' : schwach ? 'unter_schwelle' : 'geprueft' } };
    return structuredClone(letzterLauf);
  },
  async pruefbank() {
    await warte();
    return letzterLauf ? structuredClone(letzterLauf) : null;
  },
  async konto() {
    await warte(60);
    const u = aktuell();
    if (!MANAGED || !u.rollen.includes('admin')) return null;
    return structuredClone(kontoStand);
  },
  async kontoAktion(a) {
    await warte(500);
    brauche(aktuell().rollen.includes('admin'), 'Nur Admins.');
    if (a === 'test-verlaengern') {
      if (kontoStand.test_selbst_verlaengert) throw new ApiFehler(409, 'Die Testphase wurde schon einmal verlängert.');
      kontoStand.test_selbst_verlaengert = true;
      kontoStand.test_ende = new Date(new Date(kontoStand.test_ende ?? Date.now()).getTime() + 14 * 86400000).toISOString().slice(0, 10);
      return { test_ende: kontoStand.test_ende };
    }
    if (a === 'kaufen') return { checkout_url: 'https://example.invalid/checkout' };
    if (a === 'loeschen') return { hinweis: 'Wir haben dir eine Mail mit Bestätigungslink geschickt.' };
    if (a === 'umzug') return { hinweis: 'Das Umzugspaket wird gepackt. Den Link bekommst nur du per Mail.' };
    if (a === 'kuendigen') {
      kontoStand.kuendigung_zum = kontoStand.test_ende;
      return { kuendigung_zum: kontoStand.kuendigung_zum };
    }
    return {};
  },
  async starteExport(art) {
    await warte(200);
    const u = aktuell();
    if (art === 'umzugspaket') brauche(u.rollen.includes('admin'), 'Das Umzugspaket dürfen nur Admins packen.');
    const id = `ex-${Date.now().toString(36)}`;
    exporte[id] = { art, start: Date.now() };
    return { id };
  },
  async exportStand(id) {
    await warte(150);
    const e = exporte[id];
    if (!e) throw new ApiFehler(404, 'Diesen Export gibt es nicht mehr.');
    if (Date.now() - e.start < 1200) return { status: 'laeuft' };
    const inhalt = JSON.stringify({ hinweis: `Demo-Export (${e.art}). Im echten Betrieb eine Datei nach CONTRACT v1.4 7.1.`, wissen: daten.artikel.length, quellen: daten.quellen.length }, null, 2);
    return { status: 'fertig', bytes: inhalt.length, sha256: 'demo', link: blobUrl(inhalt, 'application/json'), bereit_bis: new Date(Date.now() + 7 * 86400000).toISOString() };
  },
  async starteAusstiegsprobe() {
    await warte(300);
    brauche(aktuell().rollen.includes('admin'), 'Nur Admins.');
    probe = {
      am: new Date().toISOString(),
      kernZuKern: { bestanden: true, pruefsummen_ok: true, git_fsck_ok: true, head_gleich: true },
      offen: { bestanden: true, dateien: daten.artikel.length + daten.quellen.length, ohneGueltigenKopf: [], fundstellenKaputt: 0 },
      bestanden: true,
    };
  },
  async ausstiegsprobe() {
    await warte();
    return probe ? structuredClone(probe) : null;
  },
  async apps() {
    await warte();
    return structuredClone(appsVon[aktuell().id] ?? []);
  },
  async trenneApp(clientId) {
    await warte(200);
    const u = aktuell();
    appsVon[u.id] = (appsVon[u.id] ?? []).filter((a) => a.clientId !== clientId);
  },
  async kontextbilanz(): Promise<Kontextbilanz> {
    await warte();
    const u = aktuell();
    brauche(u.rollen.includes('admin') || u.rollen.includes('freigeber'), 'Die Kontextbilanz sehen Freigeber und Admins.');
    const art = daten.artikel;
    const heute = heuteIso();
    const offen = daten.vorschlaege.filter((v) => v.status === 'offen' || v.status === 'konflikt').length;
    return {
      stand: new Date().toISOString(),
      bestand: { artikel: art.length, quellen: daten.quellen.length, fakten: alleFakten(u).length, entscheidungen: art.filter((a) => a.kopf.gruppe === 'entscheidungen').length },
      pflege: {
        mitVerantwortlich: art.filter((a) => !!a.kopf.verantwortlich).length,
        mitPruefdatum: art.filter((a) => !!a.kopf.pruefen_bis).length,
        faellig: art.filter((a) => a.kopf.pruefen_bis && a.kopf.pruefen_bis < heute).length,
        veraltet: art.filter((a) => (a.kopf.status as string) === 'veraltet').length,
        faktenMitGueltigkeit: alleFakten(u).filter((f) => !!f.gilt_bis).length,
      },
      antworten: art.length ? { belegt: 38, stehtNichtDrin: 6, zeitraum: { von: new Date(Date.now() - 13 * 86400000).toISOString().slice(0, 10), bis: heute } } : { belegt: 0, stehtNichtDrin: 0, zeitraum: { von: heute, bis: heute } },
      ersteBelegteAntwort: art.length ? { am: new Date(Date.now() - 12 * 86400000).toISOString(), sekundenSeitStart: 212 } : null,
      bemerkt: { befundeOffen: art.length ? 3 : 0, befundeErledigt: art.length ? 5 : 0, abgelaufeneFristen: art.length ? 1 : 0, vorAblaufGemeldet: art.length ? 2 : 0 },
      eingang: { offen, freigegebenSeit: daten.vorschlaege.filter((v) => v.status === 'freigegeben').length, abgelehntSeit: daten.vorschlaege.filter((v) => v.status === 'abgelehnt').length },
      anbindungen: { verbundeneApps: Object.values(appsVon).flat().length, agentenZugaenge: Object.values(zugaenge).flat().filter((t) => t.scopes.includes('kern:bericht')).length },
      luecken: art.length ? 2 : 0,
      ausstieg: { letzteProbe: probe?.am ?? null, bestanden: probe?.bestanden ?? null },
      pruefbank: { letzterLauf: letzterLauf?.am ?? null, anbieter: letzterLauf?.anbieter ?? null, modell: letzterLauf?.modell ?? null, belegtreue: letzterLauf?.belegtreue ?? null, lecks: letzterLauf?.lecks ?? null, kiStatus: einstellungen.ki?.status ?? 'ohne_ki' },
    };
  },
};

export const _intern = { daten, nameVon };
