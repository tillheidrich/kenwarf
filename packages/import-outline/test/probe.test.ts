import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import type { Antwort } from '@kern/core';
import { bestandsaufnahme, berichtAlsMarkdown, importiereOutline, leseMcpAbzug } from '../src/index.js';
import { aufraeumen, neuerKern, tmp } from './helfer.js';

/**
 * Probeimport über einen MCP-Abzug (Ordner mit `sammlungen.json` und `dokumente/*.md`, wie ihn das Outline-MCP liefert).
 * Der Abzug ist erfunden (Malerei Sonnberg, alle Kennungen ausgedacht) und entsteht im Test; er bildet die Form eines
 * echten Abzugs nach: drei Sammlungen, eine davon privat, Baum mit Unterseiten, ein Link auf eine Seite außerhalb
 * des Abzugs, Kommentare. Geprüft wird derselbe Ablauf wie beim Probeimport aus einem echten Wiki.
 */
const BASIS = 'https://wiki.example.org';
const AUTOR = { id: '00000000-0000-4000-8000-00000000a001', name: 'Erika Muster' };

type Dok = { id: string; urlId: string; titel: string; sammlung: string; eltern?: string; text: string };
const SAMMLUNGEN = [
  { id: '00000000-0000-4000-8000-0000000000c1', urlId: 'Hb10000001', name: 'Handbuch', permission: 'read_write' as const },
  { id: '00000000-0000-4000-8000-0000000000c2', urlId: 'An20000002', name: 'Angebote', permission: 'read_write' as const },
  { id: '00000000-0000-4000-8000-0000000000c3', urlId: 'Lg30000003', name: 'Projekt Lager (intern)', permission: null },
];
const DOKS: Dok[] = [
  { id: '00000000-0000-4000-8000-0000000000d1', urlId: 'Hs11111111', titel: 'Handbuch – Start hier', sammlung: 'Handbuch',
    text: 'Einstieg ins Handbuch der Malerei Sonnberg.\n\n* [Hausfarbe und Farbregeln](/doc/hausfarbe-und-farbregeln-Hf22222222)\n* [Schriften](/doc/schriften-Sc33333333)\n* [Webseite live](/doc/webseite-live-Zz99999999) (nicht im Abzug)\n' },
  { id: '00000000-0000-4000-8000-0000000000d2', urlId: 'Hf22222222', titel: 'Hausfarbe und Farbregeln', sammlung: 'Handbuch', eltern: '00000000-0000-4000-8000-0000000000d1',
    text: '## Hausfarbe\n\nDie Hausfarbe der Malerei Sonnberg ist Ocker (#c8892e).\n\n## Glanzlack-Regel\n\nDie Glanzlack-Regel verbietet Hochglanzlack in Innenräumen mit Fenstern nach Süden.\n' },
  { id: '00000000-0000-4000-8000-0000000000d3', urlId: 'Sc33333333', titel: 'Schriften', sammlung: 'Handbuch', eltern: '00000000-0000-4000-8000-0000000000d1',
    text: '## Überschriften\n\nFür Überschriften nutzt Sonnberg die Schrift Fira Sans.\n\n## Fließtext\n\nFließtext steht in Source Serif.\n' },
  { id: '00000000-0000-4000-8000-0000000000d4', urlId: 'Fc44444444', titel: 'Fassaden-Check', sammlung: 'Angebote',
    text: '## Leistung\n\nDer Fassaden-Check kostet 480 € pauschal und dauert einen halben Tag.\n\n## Ablauf\n\nSichtprüfung, Feuchtemessung, Bericht mit Fotos.\n' },
  { id: '00000000-0000-4000-8000-0000000000d5', urlId: 'Wv55555555', titel: 'Wartungsvertrag Holzfenster', sammlung: 'Angebote',
    text: '## Umfang\n\nEinmal im Jahr schleifen, lasieren und Beschläge ölen.\n' },
  { id: '00000000-0000-4000-8000-0000000000d6', urlId: 'At66666666', titel: 'Anfahrt und Termine', sammlung: 'Angebote',
    text: '## Termine\n\nBesichtigungen von Montag bis Freitag zwischen 8 und 16 Uhr.\n' },
  { id: '00000000-0000-4000-8000-0000000000d7', urlId: 'Lu77777777', titel: 'Lagerumzug – Planung', sammlung: 'Projekt Lager (intern)',
    text: '## Termin\n\nDas Lager zieht im März 2027 von der Werkstraße in die Halle am Bahnhof um.\n' },
  { id: '00000000-0000-4000-8000-0000000000d8', urlId: 'Lc88888888', titel: 'Lagerumzug – Checkliste', sammlung: 'Projekt Lager (intern)', eltern: '00000000-0000-4000-8000-0000000000d7',
    text: '## Vorher\n\nRegale abbauen, Farbreste entsorgen, Leitern zählen.\n' },
];

function slug(t: string): string {
  return t.toLowerCase().replace(/[äöüß]/g, (c) => ({ ä: 'ae', ö: 'oe', ü: 'ue', ß: 'ss' })[c]!).replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

/** Schreibt den erfundenen Abzug im Format des Outline-MCP (`fetch` je Dokument, Baum je Sammlung). */
function schreibeAbzug(): string {
  const ordner = tmp('kern-io-probe-');
  mkdirSync(join(ordner, 'dokumente'));
  const sid = (name: string) => SAMMLUNGEN.find((s) => s.name === name)!.id;
  const knoten = (d: Dok): unknown => ({ id: d.id, title: d.titel, url: `/doc/${slug(d.titel)}-${d.urlId}`, children: DOKS.filter((k) => k.eltern === d.id).map(knoten) });
  writeFileSync(
    join(ordner, 'sammlungen.json'),
    JSON.stringify({
      abzug: { art: 'mcp-abzug', quelle: BASIS, am: '2026-10-24T06:10:00Z', von: 'Test (erfunden)' },
      sammlungen: SAMMLUNGEN.map((s) => ({ ...s, url: `${BASIS}/collection/${slug(s.name)}-${s.urlId}`, description: null, documentStructure: DOKS.filter((d) => d.sammlung === s.name && !d.eltern).map(knoten) })),
      kommentare: [
        { id: '00000000-0000-4000-8000-0000000000e1', documentId: DOKS[0]!.id, parentCommentId: null, createdBy: AUTOR, createdAt: '2026-10-01T08:00:00Z', resolvedAt: null, text: 'Bitte die Schriftseite ergänzen.' },
        { id: '00000000-0000-4000-8000-0000000000e2', documentId: DOKS[6]!.id, parentCommentId: null, createdBy: AUTOR, createdAt: '2026-10-02T08:00:00Z', resolvedAt: '2026-10-03T08:00:00Z', text: 'Halle ist bestätigt.' },
      ],
    }),
  );
  for (const d of DOKS) {
    const meta = {
      document: {
        id: d.id, url: `${BASIS}/doc/${slug(d.titel)}-${d.urlId}`, urlId: d.urlId, title: d.titel, icon: null,
        createdAt: '2026-09-01T08:00:00.000Z', createdBy: AUTOR, updatedAt: '2026-10-01T08:00:00.000Z', updatedBy: AUTOR,
        publishedAt: '2026-09-01T08:00:00.000Z', archivedAt: null, revision: 2, collectionId: sid(d.sammlung), parentDocumentId: d.eltern ?? null, commentCount: 0,
      },
      breadcrumb: d.sammlung,
    };
    writeFileSync(join(ordner, 'dokumente', `${d.urlId}.md`), `${JSON.stringify(meta)}\n${d.text}`);
  }
  return ordner;
}

afterAll(aufraeumen);

describe('Probeimport aus einem MCP-Abzug (erfundene Daten)', () => {
  it('importiert, gibt frei, beantwortet fünf Testfragen mit Belegen, enthält sich bei Fangfrage, hält Rechte', async () => {
    const b = await leseMcpAbzug(schreibeAbzug());
    const bestand = bestandsaufnahme(b);
    const { kern, dir, till, leser } = await neuerKern();
    const r = await importiereOutline(kern, till, b, { datenOrdner: dir, freigeben: true });
    await kern.reindex();

    expect(r.summe.dokumente).toBe(8);
    expect(r.summe.freigegeben).toBe(8);
    // Lager-Sammlung ist in Outline privat → „ich“
    expect(r.sammlungen.find((s) => s.name.startsWith('Projekt Lager'))!.sichtbarkeit).toBe('ich');
    // Interne Links auf Seiten, die nicht im Abzug sind, bleiben auf Outline und sind gemeldet
    const start = r.dokumente.find((d) => d.titel.startsWith('Handbuch'))!;
    expect(start.links.offen.some((o) => o.ziel.includes('/doc/webseite-live-'))).toBe(true);

    // erwartet: Dokument, aus dem der Beleg kommen soll, und Text, den eine gute Antwort enthält
    const fragen: { frage: string; dok: RegExp | null; text: RegExp | null; als?: 'leser' }[] = [
      { frage: 'Welche Hausfarbe hat die Malerei Sonnberg?', dok: /hausfarbe|farbregeln/, text: /Ocker|#c8892e/ },
      { frage: 'Was kostet der Fassaden-Check?', dok: /fassaden/, text: /480/ },
      { frage: 'Welche Schrift nutzt Sonnberg für Überschriften?', dok: /schriften/, text: /Fira Sans/ },
      { frage: 'Was verbietet die Glanzlack-Regel?', dok: /farbregeln/, text: /Hochglanz|Innenräumen/ },
      { frage: 'Wann zieht das Lager um?', dok: /lagerumzug/, text: /März 2027/ },
      { frage: 'Wie hoch ist die Miete im Hafenweg?', dok: null, text: null },
      { frage: 'Wann zieht das Lager um?', dok: null, text: null, als: 'leser' },
    ];
    const protokoll: string[] = [];
    const antworten: Antwort[] = [];
    for (const f of fragen) {
      const a: Antwort = await kern.frage(f.als === 'leser' ? leser : till, f.frage);
      antworten.push(a);
      protokoll.push(`### ${f.frage}${f.als ? ' (als Leser ohne Rechte)' : ''}\n\nStatus: ${a.status}\n\n${a.punkte.map((p) => `* ${p.text} [${p.belege.join(', ')}]`).join('\n')}\n\n${a.belege.map((x, i) => `${i + 1}. ${x.quelle} › ${x.abschnitt} (Zeilen ${x.zeilen.join('–')}): „${x.zitat}“`).join('\n')}\n`);
    }
    // Wiederholungslauf: alles unverändert
    const zweiter = await importiereOutline(kern, till, b, { datenOrdner: dir });
    if (process.env['U1_BERICHT']) {
      writeFileSync(
        process.env['U1_BERICHT'],
        `# Probeimport (automatisch erzeugt vom Test probe.test.ts)\n\n## Bestand des Abzugs\n\n\`\`\`json\n${JSON.stringify(bestand, null, 2)}\n\`\`\`\n\n${berichtAlsMarkdown(r).replace(/^# /, '## ')}\n## Testfragen\n\n${protokoll.join('\n')}\n## Wiederholungslauf\n\n${JSON.stringify(zweiter.summe)}\n`,
      );
    }
    const norm = (x: string) => x.replace(/[*_`]/g, '').replace(/\s+/g, ' ').trim();
    let dokTreffer = 0;
    let textTreffer = 0;
    for (const [i, f] of fragen.entries()) {
      const a = antworten[i]!;
      // Jeder Beleg steht wörtlich in der Datei im angegebenen Zeilenbereich (Zitatprüfung, auch bei Fehlgriffen)
      for (const x of a.belege) {
        const zeilen = readFileSync(join(dir, x.quelle), 'utf8').split('\n').slice(x.zeilen[0] - 1, x.zeilen[1]).join(' ');
        expect(norm(zeilen), `${f.frage}: ${x.quelle}`).toContain(norm(x.zitat));
      }
      if (f.als === 'leser') {
        // Rechte: die private Lager-Sammlung taucht für den Leser in keinem Beleg auf
        expect(a.belege.every((x) => !/lagerumzug|projekt-lager/.test(x.quelle))).toBe(true);
        continue;
      }
      if (!f.dok) {
        expect(a.status, f.frage).toBe('steht_nicht_drin');
        continue;
      }
      expect(a.status, f.frage).toBe('beantwortet');
      if (a.belege.some((x) => f.dok!.test(x.quelle))) dokTreffer++;
      if (f.text && f.text.test(a.punkte.map((p) => p.text).join(' '))) textTreffer++;
    }
    // Mock-Anbieter (Wortüberdeckung, keine KI); Untergrenzen wie beim Probeimport aus dem echten Wiki (Dokument 4/5, Text 2/5).
    expect(dokTreffer).toBeGreaterThanOrEqual(4);
    expect(textTreffer).toBeGreaterThanOrEqual(2);
    if (process.env['U1_BERICHT']) writeFileSync(process.env['U1_BERICHT'], readFileSync(process.env['U1_BERICHT'], 'utf8') + `\n## Auswertung\n\nRichtiges Dokument belegt: ${dokTreffer} von 5. Antworttext trifft: ${textTreffer} von 5 (Mock-Anbieter).\n`);
    expect(zweiter.summe).toMatchObject({ neu: 0, aktualisiert: 0, unveraendert: 8, vorschlaege: 0 });
    await kern.schliesse();
  });
});
