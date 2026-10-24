import { afterAll, describe, expect, it } from 'vitest';
import { proxyDispatcher } from '../src/netz.js';
import { aufraeumen, benutzerSatz, oeffne } from './helfer.js';

afterAll(() => aufraeumen());

describe('v1.4 3.4: Verbrauchszähler und Nutzung ohne Personenbezug', () => {
  it('zählt KI-Aufrufe mit Preis je Tag und Monat, Ereignisse ohne Inhalte', async () => {
    const kern = await oeffne(undefined, { kiPreis: { ein: 100_000, aus: 300_000 } });
    const b = await benutzerSatz(kern);
    expect((await kern.verbrauch()).aufrufe_heute).toBe(0);
    await kern.fuegeHinzu(b.autor, { art: 'text', titel: 'Hobel', inhalt: 'Hobelmesser werden alle 40 Stunden gewechselt.', sammlung: 'w', sichtbarkeit: 'betrieb', kompilieren: false });
    await kern.frage(b.leser, 'Wann werden Hobelmesser gewechselt?');
    const v = await kern.verbrauch();
    expect(v.monat).toBe('2026-10');
    expect(v.aufrufe_heute).toBeGreaterThanOrEqual(1);
    expect(v.tokens_monat.ein).toBeGreaterThan(0);
    expect(v.cent_heute).toBeGreaterThan(0);
    expect(v.cent_monat).toBe(v.cent_heute);
    expect(v.preis_bekannt).toBe(true);
    expect(kern.zaehler.ereignisse('2026-10-01', '2026-10-31')['antwort_belegt']).toBe(1);
    // Schema enthält keine Personen, Fragen oder Pfade
    expect(kern.zaehler.spalten().join(' ')).not.toMatch(/user|nutzer|benutzer|frage|pfad|titel/);
    const n = await kern.nutzung();
    expect(n).toMatchObject({ artikel: 0, quellen: 1, nutzer: 5 });
    expect(n.speicher_bytes).toBeGreaterThan(0);
    expect(JSON.stringify(n)).not.toContain('Hobel');
    await kern.schliesse();
  });

  it('gemeinsamer Proxy-Dispatcher: nur mit Proxy, nie für Loopback, NO_PROXY gilt', () => {
    const p = { httpProxy: 'http://proxy:3128', httpsProxy: 'http://proxy:3128', noProxy: 'intern.example' };
    expect(proxyDispatcher('https://api.mistral.ai/v1', null)).toBeUndefined();
    expect(proxyDispatcher('https://api.mistral.ai/v1', p)).toBeDefined();
    expect(proxyDispatcher('http://127.0.0.1:11434', p)).toBeUndefined();
    expect(proxyDispatcher('http://localhost:11434', p)).toBeUndefined();
    expect(proxyDispatcher('https://ki.intern.example/v1', p)).toBeUndefined();
  });
});
