import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Kern } from '../src/kern.js';
import type { User } from '../src/types.js';
import { suchformen, suchNorm, wortformen } from '../src/util.js';
import { aufraeumen, benutzerSatz, oeffne } from './helfer.js';

let kern: Kern;
let u: User;

const TEXTE: [string, string][] = [
  ['Urlaub', 'Urlaubsanträge müssen zwei Wochen vorher im Büro eingereicht werden.'],
  ['Reinigung', 'Die Lackierkabine wird jeden Freitag gründlich gereinigt.'],
  ['Krankheit', 'Krankmeldungen bitte bis 9 Uhr telefonisch an Sabine.'],
  ['Zahlungsziel', 'Rechnungen an Privatkunden haben ein Zahlungsziel von 14 Tagen.'],
  ['Antrag', 'Einen Antrag auf Bildungsurlaub stellt man schriftlich bei der Geschäftsführung.'],
  ['Überstunden', 'Überstunden werden monatlich abgerechnet und im Folgemonat ausgezahlt.'],
  ['Schlüssel', 'Der Schlüssel für das Lager hängt im Büro neben der Tür.'],
  ['Werkzeug', 'Defekte Akkuschrauber gibt man in der Werkzeugausgabe ab.'],
];

beforeAll(async () => {
  kern = await oeffne();
  u = (await benutzerSatz(kern)).admin;
  for (const [titel, inhalt] of TEXTE) await kern.fuegeHinzu(u, { art: 'text', titel, inhalt, sammlung: 'betrieb', sichtbarkeit: 'betrieb', kompilieren: false } as never);
});
afterAll(async () => {
  await kern.schliesse();
  aufraeumen();
});

describe('Deutsche Wortformen in der Suche (5-Minuten-Weg)', () => {
  it('Normalisierung: Umlaute, Plural, Partizip', () => {
    expect(suchNorm('Anträge')).toBe(suchNorm('Antraege'));
    expect(wortformen(suchNorm('eingereicht'))).toContain('einreich');
    expect(suchformen('einreichen')).toContain('einreich');
    expect(wortformen(suchNorm('gereinigt'))).toContain('reinig');
    expect(suchformen('Urlaubsantrag')).toEqual(suchformen('Urlaubsanträge').filter((x) => suchformen('Urlaubsantrag').includes(x)));
  });

  const FRAGEN: [string, string][] = [
    ['Wann muss ich einen Urlaubsantrag einreichen?', 'Urlaub'],
    ['Urlaubsantrag', 'Urlaub'],
    ['urlaubsantraege', 'Urlaub'],
    ['Wer reinigt die Lackierkabine?', 'Reinigung'],
    ['Wie melde ich mich krank?', 'Krankheit'],
    ['Wie lange ist das Zahlungsziel für Privatkunden?', 'Zahlungsziel'],
    ['Bildungsurlaubsantrag', 'Antrag'],
    ['Wie werden Ueberstunden abgerechnet?', 'Überstunden'],
    ['Abrechnung der Überstunde', 'Überstunden'],
    ['Wo ist der Lagerschlüssel?', 'Schlüssel'],
    ['Akkuschrauber kaputt, wohin?', 'Werkzeug'],
  ];
  for (const [frage, titel] of FRAGEN) {
    it(`„${frage}“ findet „${titel}“ unter den ersten drei`, async () => {
      const t = await kern.suche(u, frage, { limit: 5 });
      expect(t.slice(0, 3).map((x) => x.titel)).toContain(titel);
    });
  }

  it('Die erste Frage des 5-Minuten-Wegs wird beantwortet', async () => {
    const a = await kern.frage(u, 'Wann muss ich einen Urlaubsantrag einreichen?');
    expect(a.status).toBe('beantwortet');
    expect(a.belege[0]?.zitat).toContain('eingereicht');
  });
});
