// Demo-Daten: Tischlerei Wendt GmbH im erfundenen Ort Musterhude. Alle Namen, Zahlen und
// Lieferanten sind ausgedacht. Inhalte stammen aus dem App-Mockup K1 und sind in die
// Kern-Formen aus CONTRACT.md umgesetzt (wendt.json, erzeugt).
import roh from './wendt.json';
import type { Artikel, Fakt, Quelle, Rolle, User, Vorschlag, VerlaufEintrag } from '../api/types';

export interface MockNutzer extends User {
  passwort: string;
  mussAendern?: boolean;
}

export const NUTZER: MockNutzer[] = [
  { id: 'joern', name: 'Jörn Wendt', rollen: ['admin', 'freigeber', 'autor'], teams: ['buero', 'werkstatt'], passwort: 'demo' },
  { id: 'sabine', name: 'Sabine Kröger', rollen: ['freigeber', 'autor'], teams: ['buero'], passwort: 'demo' },
  { id: 'malte', name: 'Malte Ohlsen', rollen: ['autor'], teams: ['werkstatt'], passwort: 'demo' },
  { id: 'kai', name: 'Kai Brandes', rollen: ['autor'], teams: ['werkstatt'], passwort: 'demo' },
  { id: 'lena', name: 'Lena Voß', rollen: ['leser' as Rolle], teams: ['werkstatt'], passwort: 'demo' },
];

export function nameVon(id: string): string {
  return NUTZER.find((n) => n.id === id)?.name ?? id;
}

type RohVorschlag = {
  id: string;
  nr: string;
  title: string;
  created: string;
  state: string;
  target: string;
  note: { text: string; from: string; date: string };
  changes: { where: string; old: string; new: string }[];
  done?: { by: string; date: string; comment: string };
};

export type RohFrage = {
  id: string;
  kind: 'ok' | 'missing' | 'offtopic';
  q: string;
  bullets: [string, number[]][];
  sources: { file: string; heading: string | null; quote: string; unreleased?: string }[];
};

function deIso(d: string): string {
  const [t, m, j] = d.split('.');
  return `${j}-${m}-${t}`;
}

/** Nachtrag v1.1: Fundstellen-IDs mit Fußnoten im Text, geprüft-Vermerke, Fakten, ein veralteter Artikel. */
function ergaenzeV11(artikel: Artikel[], finde: (slug: string) => Artikel | undefined) {
  for (const a of artikel) {
    a.kopf.type = 'Artikel';
    a.kopf.fundstellen.forEach((f, i) => (f.id = `q${i + 1}`));
    if (a.kopf.status === 'freigegeben') a.kopf.verified = [{ by: a.kopf.verantwortlich, at: a.kopf.stand, commit: '' }];
    if (a.kopf.fundstellen.length) {
      // Fußnoten hinter den ersten Absatz nach der Beispiel-Notiz setzen
      const absaetze = a.text.split('\n\n');
      const i = absaetze.findIndex((p) => p.trim() && !p.startsWith('>') && !p.startsWith('#') && !p.startsWith('|'));
      if (i >= 0) {
        absaetze[i] = absaetze[i].replace(/\s*$/, '') + a.kopf.fundstellen.map((f) => `[^${f.id}]`).join('');
        a.text = absaetze.join('\n\n');
      }
      a.text = a.text.trimEnd() + '\n\n' + a.kopf.fundstellen.map((f) => `[^${f.id}]: ${f.quelle}, Abschnitt „${f.abschnitt}“`).join('\n') + '\n';
    }
  }
  const fs = (a: Artikel | undefined) => a?.kopf.fundstellen[0]?.id ?? 'q1';
  const setze = (slug: string, fakten: Omit<Fakt, 'fundstelle' | 'artikel'>[]) => {
    const a = finde(slug);
    if (!a) return;
    a.kopf.fakten = fakten.map((f) => ({ ...f, fundstelle: fs(a), artikel: a.pfad }));
  };
  setze('13-auftragsbestaetigung-und-anzahlung', [
    { id: 'anzahlung-quote', art: 'preis', gegenstand: 'Anzahlung', wert: '30', einheit: '%', gilt_ab: '2026-01-01', gilt_bis: null },
    { id: 'anzahlung-grenze', art: 'regel', gegenstand: 'Anzahlung ab Auftragswert', wert: '3.000', einheit: '€', gilt_ab: '2026-01-01', gilt_bis: '2026-12-31' },
    { id: 'anzahlung-nachfassen', art: 'frist', gegenstand: 'Anruf, wenn Anzahlung fehlt', wert: '10', einheit: 'Arbeitstage', gilt_ab: '2026-01-01', gilt_bis: null },
  ]);
  setze('18-reklamation', [
    { id: 'kulanz-malte', art: 'zustaendigkeit', gegenstand: 'Kulanz bis 200 €', wert: 'Malte Ohlsen', gilt_ab: '2026-10-14', gilt_bis: null },
    { id: 'kulanz-joern', art: 'zustaendigkeit', gegenstand: 'Kulanz über 200 €', wert: 'Jörn Wendt', gilt_ab: '2026-10-14', gilt_bis: null },
    { id: 'reklamation-termin', art: 'frist', gegenstand: 'Termin, wenn Nutzung eingeschränkt', wert: '5', einheit: 'Arbeitstage', gilt_ab: '2026-10-14', gilt_bis: null },
  ]);
  setze('12-angebot-schreiben', [
    { id: 'angebot-gueltig', art: 'frist', gegenstand: 'Angebot gültig', wert: '4', einheit: 'Wochen', gilt_ab: '2026-01-01', gilt_bis: null },
    { id: 'lieferzeit-beschlaege', art: 'frist', gegenstand: 'Lieferzeit Beschläge', wert: '2 bis 3', einheit: 'Wochen', gilt_ab: '2026-04-01', gilt_bis: '2026-11-05' },
    { id: 'zwei-ausfuehrungen', art: 'regel', gegenstand: 'Zwei Ausführungen anbieten ab', wert: '5.000', einheit: '€', gilt_ab: '2026-01-01', gilt_bis: null },
  ]);
  setze('41-werkstatt-sicherheit', [
    { id: 'unterweisung', art: 'frist', gegenstand: 'Unterweisung Maschinen', wert: 'jährlich', gilt_ab: '2025-10-15', gilt_bis: '2026-10-15' },
    { id: 'zustaendig-sicherheit', art: 'zustaendigkeit', gegenstand: 'Unfall oder Beinahe-Unfall melden an', wert: 'Malte Ohlsen', gilt_ab: '2026-03-03', gilt_bis: null },
  ]);
  setze('01-wer-macht-was', [
    { id: 'kontakt-buero', art: 'kontakt', gegenstand: 'Büro, Durchwahl', wert: '04100 123 45-10 (erfunden)', gilt_ab: '2026-09-01', gilt_bis: null },
    { id: 'mitarbeitende', art: 'kennzahl', gegenstand: 'Leute im Betrieb', wert: '11', gilt_ab: '2026-09-01', gilt_bis: null },
  ]);
  const alt = finde('19-werkstatt-feierabend-und-maschinenpflege');
  if (alt) alt.kopf.status = 'veraltet';
  const ki = finde('02-regeln-fuer-ki');
  if (ki) ki.kopf.verified = [
    { by: 'Jörn Wendt', at: '2026-10-07', commit: '51d0c2a' },
    { by: 'Sabine Kröger', at: '2026-10-08', commit: '51d0c2a' },
  ];
}

export function erzeugeDaten() {
  const artikel: Artikel[] = structuredClone(roh.artikel) as Artikel[];
  const quellen: Quelle[] = structuredClone(roh.quellen) as Quelle[];
  const finde = (slug: string) => artikel.find((a) => a.pfad.endsWith(`/${slug}.md`));
  ergaenzeV11(artikel, finde);

  const vorschlaege: Vorschlag[] = [];
  for (const p of roh.vorschlaege as RohVorschlag[]) {
    const ziel = finde(p.target);
    if (!ziel) continue;
    const c = p.changes[0];
    const freigegeben = p.state === 'freigegeben';
    let alt = ziel.text;
    let neu = ziel.text;
    if (freigegeben) {
      // im Artikel steht schon die neue Fassung
      if (alt.includes(c.new)) alt = alt.replace(c.new, c.old);
      else alt = alt.replace('zwei Fotos zu schicken: eins aus etwa zwei Metern Abstand, eins aus der Nähe mit einem Zollstock oder einer Münze daneben.', 'Fotos zu schicken.');
    } else if (neu.includes(c.old)) neu = neu.replace(c.old, c.new);
    else neu = neu + `\n${c.new}\n`;
    vorschlaege.push({
      id: `v${p.nr}`,
      art: 'aenderung',
      ziel: ziel.pfad,
      alt,
      neu,
      grund: `${p.title}. ${p.note.text}`,
      von: p.note.from,
      erstellt: deIso(p.created),
      status: freigegeben ? 'freigegeben' : 'offen',
      ...(p.done ? { entscheidung: { von: p.done.by, am: deIso(p.done.date), begruendung: p.done.comment } } : {}),
    });
  }
  // Vorschlag aus einer Sprachnotiz: neuer Artikel
  vorschlaege.splice(1, 0, {
    id: 'v54',
    art: 'neu',
    ziel: 'wissen/ablaeufe/21-transporter-beladen.md',
    alt: null,
    neu: [
      'Kurz gesagt: Schweres nach unten und nach vorn, Glas stehend und gesichert, Werkzeugkiste zuletzt.',
      '',
      '## Reihenfolge',
      '',
      '1. Was beim Kunden zuletzt gebraucht wird, kommt zuerst rein.',
      '2. Türblätter stehend an die Bordwand, mit Decken dazwischen.',
      '3. Glas immer im Glasbock, nie liegend.',
      '4. Spanngurte: zwei je Ladung, vor der Abfahrt nachziehen.',
      '',
      '## Vor der Abfahrt',
      '',
      '- Montage-Checkliste aus dem Transporter abhaken.',
      '- Akkus geladen? Ersatzakku dabei?',
    ].join('\n'),
    grund: 'Aus der Sprachnotiz von Malte vom 23.10.2026 („Wie wir den Transporter packen“). Die KI hat einen neuen Artikel vorgeschlagen.',
    von: 'KI aus Sprachnotiz',
    erstellt: '2026-10-23',
    status: 'offen',
  });
  // abgelehnter Vorschlag aus dem Protokoll
  vorschlaege.push({
    id: 'v47',
    art: 'aenderung',
    ziel: finde('13-auftragsbestaetigung-und-anzahlung')!.pfad,
    alt: 'Anzahlung 30 % bei Aufträgen über 3.000 €',
    neu: 'Anzahlung 30 % bei Aufträgen über 2.000 €',
    grund: 'Anzahlung schon ab 2.000 € verlangen, weil zuletzt zwei kleinere Aufträge geplatzt sind.',
    von: 'Sabine Kröger',
    erstellt: '2026-06-24',
    status: 'abgelehnt',
    entscheidung: { von: 'Jörn Wendt', am: '2026-06-30', begruendung: 'Erst nach dem Jahresabschluss entscheiden.' },
  });

  const verlauf: Record<string, VerlaufEintrag[]> = {};
  let n = 0x3a7f21;
  for (const a of artikel) {
    const liste: VerlaufEintrag[] = [];
    liste.push({ commit: (n++).toString(16).padStart(7, '0'), von: a.kopf.verantwortlich, am: a.kopf.stand, grund: 'Freigegeben nach Prüfung' });
    liste.push({ commit: (n += 977).toString(16).padStart(7, '0'), von: 'Sabine Kröger', am: '2026-01-12', grund: 'Aus dem alten Ordner übernommen' });
    verlauf[a.pfad] = liste;
  }
  const rek = finde('18-reklamation');
  if (rek)
    verlauf[rek.pfad].unshift({ commit: '9c41e07', von: 'Jörn Wendt', am: '2026-10-14', grund: 'Freigegeben: Nr. 52, zwei Fotos mit Maßstab bei Reklamationen' });

  ergaenzeV12(artikel, quellen, vorschlaege, verlauf);
  return { artikel, quellen, vorschlaege, verlauf, fragen: roh.fragen as unknown as RohFrage[], briefing: roh.briefing, beobachtet: roh.watch };
}

/** Einfacher Inhalts-Hash für den Konfliktschutz im Mock (FNV-1a). */
export function hashVon(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

/** Nachtrag v1.2: Regeln-Bereich, Beobachtungs-Status, Konflikt-Beispiel, basis_hash. */
function ergaenzeV12(artikel: Artikel[], quellen: Quelle[], vorschlaege: Vorschlag[], verlauf: Record<string, VerlaufEintrag[]>) {
  const regel = (slug: string, titel: string, kurz: string, text: string, stand: string) => {
    const a: Artikel = {
      pfad: `wissen/_regeln/${slug}.md`,
      kopf: { titel, gruppe: 'Regeln', kurzfassung: kurz, stand, verantwortlich: 'Jörn Wendt', pruefen_bis: '2027-10-07', sichtbarkeit: 'betrieb', besitzer: 'joern', fundstellen: [], status: 'freigegeben', type: 'Artikel', verified: [{ by: 'Jörn Wendt', at: stand }] },
      text,
    };
    artikel.unshift(a);
    verlauf[a.pfad] = [{ commit: '51d0c2a', von: 'Jörn Wendt', am: stand, grund: 'Regeln angelegt' }];
  };
  regel(
    'was-nie-hineinkommt',
    'Was nie hineinkommt',
    'Kundendaten, Personalsachen, Kalkulation, Zugänge und Fotos mit Menschen oder Hausnummern gehören nicht ins Wissen. Kern weist solche Fragen ab.',
    [
      'Diese Liste gilt für alle Dokumente, Notizen und Artikel. Ändern darf sie nur ein Admin.',
      '',
      ...(roh as unknown as { never?: string[] }).never?.map((n) => `- ${n}`) ?? [
        '- Namen, Adressen, Telefonnummern und Mails von Kunden',
        '- Personalakte, Krankmeldungen, Lohn',
        '- Stundensätze, Zuschläge und die Kalkulation',
        '- Passwörter, Bankdaten, Zugänge',
        '- Fotos, auf denen Menschen oder Hausnummern zu erkennen sind',
      ],
      '',
      'Steht so etwas in einem neuen Dokument, schreibt Kern keinen Vorschlag daraus und meldet es im Eingang.',
    ].join('\n'),
    '2026-10-07',
  );
  regel(
    'REGELN',
    'Regeln für Antworten',
    'Kern antwortet nur mit Beleg. Ohne Fundstelle heißt die Antwort „steht nicht drin“. Preise und Termine immer in der Fundstelle nachlesen.',
    [
      '## Antworten',
      '',
      '- Jede Aussage hat eine Fundstelle mit wörtlichem Zitat.',
      '- Ohne Fundstelle: „Dazu steht nichts drin.“ Kern rät nicht.',
      '- Fragen zu Kalkulation, Personal oder Kunden: „Das gehört nicht hierher.“',
      '',
      '## Vorschläge',
      '',
      '- Die KI schreibt nie direkt ins Wissen, nur in den Eingang.',
      '- Vorschläge zu diesem Ordner gibt nur ein Admin frei.',
    ].join('\n'),
    '2026-10-07',
  );

  // Beobachtungs-Status
  const web = quellen.find((q) => q.kopf.art === 'web');
  if (web) web.kopf.beobachtung = { zuletzt_geprueft: '2026-10-24', status: 'ok', meldung: 'Keine Änderung seit 01.10.2026.' };
  quellen.push(
    {
      pfad: 'quellen/2026/bg-unterweisungshilfen.md',
      kopf: { titel: 'Berufsgenossenschaft, Unterweisungshilfen', art: 'web', herkunft: 'https://www.bghm.de/', erfasst_am: '2026-09-01', erfasst_von: 'malte', sichtbarkeit: 'betrieb', sammlung: 'Einarbeitung', hash: 'sha256:' + '7'.repeat(64), ersetzt: null, beobachtet: true, beobachtung: { zuletzt_geprueft: '2026-10-24', status: 'nicht_abrufbar', meldung: 'Die Seite sperrt automatische Abrufe. Kern umgeht das nicht. Bitte von Hand prüfen oder als PDF ablegen.' } },
      text: '# Berufsgenossenschaft, Unterweisungshilfen\n\nZuletzt abgerufen am 01.09.2026.\n',
    },
    {
      pfad: 'quellen/2026/lieferzeiten-beschlagversand-hanse.md',
      kopf: { titel: 'Beschlagversand Hanse, Lieferzeiten (erfunden)', art: 'web', herkunft: 'https://beschlagversand-hanse.example/lieferzeiten', erfasst_am: '2026-10-20', erfasst_von: 'kai', sichtbarkeit: 'team:buero', sammlung: 'Abläufe', hash: 'sha256:' + '9'.repeat(64), ersetzt: 'quellen/2026/lieferzeiten-beschlagversand-hanse-alt.md', beobachtet: true, beobachtung: { zuletzt_geprueft: '2026-10-24', status: 'geaendert', meldung: 'Neue Fassung am 20.10.2026, Vorschlag Nr. 51.' } },
      text: '# Beschlagversand Hanse, Lieferzeiten\n\nBeschläge: derzeit vier Wochen ab Bestellung (Stand Oktober 2026).\n',
    },
  );

  // basis_hash für alle offenen Vorschläge, ein Beispiel mit Konflikt
  for (const v of vorschlaege) {
    const a = artikel.find((x) => x.pfad === v.ziel);
    if (a && v.status === 'offen') v.basis_hash = hashVon(a.text);
  }
  const ziel = artikel.find((a) => a.pfad.endsWith('/16-montage-beim-kunden.md'));
  if (ziel) {
    const alt = ziel.text;
    const neu = alt.replace(/\n*$/, '\n\n## Nach der Montage\n\nFotos vom fertigen Einbau ohne Personen und ohne Hausnummer machen und in den Auftrag legen.\n');
    vorschlaege.splice(2, 0, {
      id: 'v55',
      art: 'aenderung',
      ziel: ziel.pfad,
      alt,
      neu,
      grund: 'Fotos nach der Montage. Für Reklamationen brauchen wir Vergleichsbilder vom Einbau.',
      von: 'Kai Brandes',
      erstellt: '2026-10-22',
      status: 'konflikt',
      basis_hash: hashVon(alt),
    });
    // Datei wurde inzwischen geändert (z. B. in Obsidian)
    ziel.text = alt.replace(/\n*$/, '\n\nWerkzeug nach der Montage zählen, bevor der Transporter losfährt.\n');
    verlauf[ziel.pfad] = [{ commit: 'a81f3c0', von: 'Malte Ohlsen', am: '2026-10-23', grund: 'Im Editor geändert: Werkzeug zählen' }, ...(verlauf[ziel.pfad] ?? [])];
  }
}
