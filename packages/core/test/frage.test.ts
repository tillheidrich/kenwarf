import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Kern } from '../src/kern.js';
import { MockProvider } from '../src/provider.js';
import type { ChatNachricht, User } from '../src/types.js';
import { aufraeumen, oeffne, seedKern } from './helfer.js';

let kern: Kern;
let u: Record<string, User>;
let dir: string;

beforeAll(async () => {
  ({ kern, u, dir } = await seedKern());
});
afterAll(async () => {
  await kern.schliesse();
  aufraeumen();
});

describe('frage mit mock', () => {
  it('belegt: jeder Punkt hat Belege, Zitate stehen wörtlich in den Zeilen', async () => {
    const a = await kern.frage(u.lena!, 'Was muss ich zum Aufmaß mitnehmen?');
    expect(a.status).toBe('beantwortet');
    expect(a.punkte.length).toBeGreaterThan(0);
    for (const p of a.punkte) {
      expect(p.belege.length).toBeGreaterThan(0);
      for (const n of p.belege) expect(a.belege[n - 1]).toBeDefined();
    }
    expect(a.belege[0]!.quelle).toBe('wissen/ablaeufe/aufmass-vor-ort.md');
    for (const b of a.belege) expect(await kern.zitatStehtDrin(b)).toBe(true);
  });

  it('steht nicht drin', async () => {
    const a = await kern.frage(u.lena!, 'Wie hoch ist der Aktienkurs von Tesla?');
    expect(a.status).toBe('steht_nicht_drin');
    expect(a.punkte).toEqual([]);
    expect(a.belege).toEqual([]);
  });

  it('gehört nicht hierher (Regel-Datei, Schlüsselwort)', async () => {
    const a = await kern.frage(u.lena!, 'Wie viel verdient Kai Brandes im Monat?');
    expect(a.status).toBe('gehoert_nicht_hierher');
    expect(a.belege[0]?.quelle).toBe('wissen/_regeln/was-nie-hineinkommt.md');
    expect(await kern.zitatStehtDrin(a.belege[0]!)).toBe(true);
    const b = await kern.frage(u.lena!, 'Wie ist das Passwort fürs WLAN?');
    expect(b.status).toBe('gehoert_nicht_hierher');
    // legitime Frage zum Thema Krankmeldung bleibt erlaubt
    const c = await kern.frage(u.lena!, 'Wie melde ich mich krank?');
    expect(c.status).toBe('beantwortet');
  });

  it('gehört nicht hierher (Muster: IBAN)', async () => {
    const a = await kern.frage(u.lena!, 'Gehört DE44 5001 0517 5407 3249 31 zu Holzhandel Nord?');
    expect(a.status).toBe('gehoert_nicht_hierher');
  });

  it('Faktenschicht zuerst, Beleg aus der Quelle', async () => {
    const a = await kern.frage(u.lena!, 'Wie viel Anzahlung nehmen wir bei Einbauküchen?');
    expect(a.status).toBe('beantwortet');
    expect(a.hinweis).toMatch(/Faktenschicht/);
    expect(a.punkte[0]!.text).toContain('30 %');
    expect(a.belege[0]!.quelle).toBe('quellen/2026/preisblatt-und-fristen-2026.md');
    expect(a.belege[0]!.zitat).toBe('Bei Einbauküchen und Treppen nehmen wir immer 30 % Anzahlung.');
    expect(await kern.zitatStehtDrin(a.belege[0]!)).toBe(true);
  });

  it('abgelaufene Fakten werden nicht als gültig beantwortet', async () => {
    const f = await kern.fakten(u.lena!, { gegenstand: 'Anfahrt' });
    expect(f[0]?.gueltig).toBe(false);
    const g = await kern.fakten(u.lena!, { gueltigAm: '2026-07-01', gegenstand: 'Anfahrt' });
    expect(g[0]?.gueltig).toBe(true);
    expect(g[0]?.beleg?.zitat).toContain('Anfahrt im Umkreis von 20 km kostenlos');
  });
});

/** Anbieter, der absichtlich ein erfundenes Zitat liefert. */
class LuegenProvider extends MockProvider {
  override name = 'luege';
  override async chat(msgs: ChatNachricht[]): Promise<string> {
    const sys = msgs[0]?.content ?? '';
    if (sys.includes('AUFGABE: FRAGE')) return JSON.stringify({ punkte: [{ text: 'Wir nehmen 90 % Anzahlung.', belege: [1], zitat: 'Wir nehmen immer 90 % Anzahlung vorab.' }, { text: 'Ohne Beleg.', belege: [] }, { text: 'Falsche Nummer.', belege: [99] }] });
    if (sys.includes('AUFGABE: REGELPRUEFUNG')) return JSON.stringify({ verstoss: false });
    return super.chat(msgs);
  }
}
class RegelProvider extends MockProvider {
  override name = 'regel';
  override async chat(msgs: ChatNachricht[]): Promise<string> {
    if ((msgs[0]?.content ?? '').includes('AUFGABE: REGELPRUEFUNG')) return JSON.stringify({ verstoss: true, regel: 'Personalakte | Abmahnung: Personalsachen klärt Jörn persönlich.' });
    return super.chat(msgs);
  }
}
class KaputtProvider extends MockProvider {
  override name = 'kaputt';
  override async chat(msgs: ChatNachricht[]): Promise<string> {
    if ((msgs[0]?.content ?? '').includes('AUFGABE: FRAGE')) return 'Das ist kein JSON.';
    return super.chat(msgs);
  }
}

describe('frage mit anderen Anbietern', () => {
  it('erfundenes Zitat ⇒ Beleg verworfen ⇒ steht nicht drin; Punkte ohne Beleg fliegen raus', async () => {
    const k = await oeffne(dir, { providerInstanz: new LuegenProvider() });
    const a = await k.frage(u.lena!, 'Was muss ich zum Aufmaß mitnehmen?');
    expect(a.status).toBe('steht_nicht_drin');
    expect(a.punkte).toEqual([]);
    await k.schliesse();
  });
  it('KI-Regelprüfung erkennt „gehört nicht hierher“', async () => {
    const k = await oeffne(dir, { providerInstanz: new RegelProvider() });
    const a = await k.frage(u.lena!, 'Was ist bei Kai letzte Woche vorgefallen?');
    expect(a.status).toBe('gehoert_nicht_hierher');
    expect(a.belege[0]?.zitat).toContain('Personalakte');
    await k.schliesse();
  });
  it('unlesbare KI-Antwort ⇒ steht nicht drin mit Hinweis', async () => {
    const k = await oeffne(dir, { providerInstanz: new KaputtProvider() });
    const a = await k.frage(u.lena!, 'Was muss ich zum Aufmaß mitnehmen?');
    expect(a.status).toBe('steht_nicht_drin');
    expect(a.hinweis).toMatch(/nicht verwendbar/);
    await k.schliesse();
  });
});
