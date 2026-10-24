/** Echter Durchlauf mit @kern/core: Datenordner, Beispieldaten, Export, Stufenwechsel mit Prüfsumme, Löschung. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { LokalBereitsteller } from '../src/bereitsteller/lokal.js';
import { aufbau, konto } from './hilfe.js';

const coreDa = fs.existsSync(path.join(import.meta.dirname, '../../core/dist/index.js'));
const basis = fs.mkdtempSync(path.join(os.tmpdir(), 'kern-betrieb-'));
afterAll(() => fs.rmSync(basis, { recursive: true, force: true }));

describe.skipIf(!coreDa)('LokalBereitsteller mit echter Engine', () => {
  it('Pitch Kanzlei Behrens: echte Artikel, Status nur als Zahlen, Löschung räumt alles weg', async () => {
    const { l } = aufbau({ bereitsteller: new LokalBereitsteller(basis) });
    const r = await l.pitchAnlegen({ beispiel: 'kanzlei-behrens', tage: 1 }, 'till');
    expect(r.vorgang.status).toBe('fertig');
    const daten = path.join(basis, r.instanz.id, 'daten');
    expect(fs.existsSync(path.join(daten, 'wissen', 'kanzlei', 'fristenkontrolle.md'))).toBe(true);
    const i = await l.aktualisiereBetrieb(r.instanz.id);
    expect(i.betrieb.speicher_bytes).toBeGreaterThan(1000);
    expect(i.betrieb.benutzer).toBe(3);
    expect(JSON.stringify(i)).not.toMatch(/Fristenkontrolle|Behrens.*Wiebke|Vorfrist/);
    await l.loeschungPlanen(r.instanz.id, { bestaetigung: r.instanz.subdomain, grund: 'Pitch vorbei' }, 'till');
    expect(fs.existsSync(path.join(basis, r.instanz.id))).toBe(false);
  }, 60_000);

  it('Pitch Tischlerei Wendt über die Seed-Funktion von core', async () => {
    const { l } = aufbau({ bereitsteller: new LokalBereitsteller(basis) });
    const r = await l.pitchAnlegen({ beispiel: 'tischlerei-wendt' }, 'till');
    expect(r.vorgang.status).toBe('fertig');
    expect((await l.aktualisiereBetrieb(r.instanz.id)).betrieb.benutzer).toBe(5);
  }, 60_000);

  it('Hochstufen mit echter Prüfsumme über alle Dateien; Export liefert sha256', async () => {
    const { l } = aufbau({ bereitsteller: new LokalBereitsteller(basis) });
    const k = konto(l);
    const { instanz } = await l.instanzAnlegen({ kunde_id: k.id, herkunft: { art: 'manuell' }, paket: 'klein', zahlung: 'rechnung', beispiel: 'kanzlei-behrens' }, 'till');
    const w = await l.stufeWechseln(instanz.id, 'eigen', 'till');
    expect(w.vorgang.status).toBe('fertig');
    expect(String(w.vorgang.ergebnis?.pruefsumme)).toMatch(/^[a-f0-9]{64}$/);
    expect(fs.existsSync(path.join(basis, `${instanz.id}.alt`))).toBe(true);
    expect(fs.readFileSync(path.join(basis, instanz.id, 'host'), 'utf8')).toBe(w.instanz.host);
    const e = await l.exportieren(instanz.id, 'okf', 'till');
    expect(e.status).toBe('fertig');
    expect(String(e.ergebnis?.sha256)).toMatch(/^[a-f0-9]{64}$/);
  }, 60_000);

  it('Baum-Prüfsumme erkennt eine veränderte Datei', async () => {
    const a = fs.mkdtempSync(path.join(basis, 'h-'));
    fs.writeFileSync(path.join(a, 'x.md'), 'eins');
    const h1 = await LokalBereitsteller.baumHash(a);
    fs.writeFileSync(path.join(a, 'x.md'), 'zwei');
    expect(await LokalBereitsteller.baumHash(a)).not.toBe(h1);
  });
});
