import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Kern } from '../src/kern.js';
import type { User } from '../src/types.js';
import { aufraeumen, gitLog, seedKern } from './helfer.js';

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

describe('v1.3 / v1.3.1 Lesen, Heute, Ansichten', () => {
  it('Standard: Stil zusammenfassung, Lesebudget aus', async () => {
    const l = await kern.leseEinstellungen(u.lena!);
    expect(l.stil).toBe('zusammenfassung');
    expect(l.lesebudget_an).toBe(false);
    expect(l.lesebudget_hart).toBe(false);
    expect(l.budget_hart).toBe(false);
  });

  it('Admin setzt Standard für neue Nutzer, erzwingt aber nichts', async () => {
    await kern.speichereEinstellungen(u['jörn']!, { standard_lesestil: 'entscheidung' } as never);
    expect((await kern.leseEinstellungen(u.kai!)).stil).toBe('entscheidung');
    await kern.setzeLeseEinstellungen(u.kai!, { stil: 'zusammenfassung' });
    expect((await kern.leseEinstellungen(u.kai!)).stil).toBe('zusammenfassung');
    await expect(kern.speichereEinstellungen(u['jörn']!, { standard_lesestil: 'zwang' } as never)).rejects.toMatchObject({ code: 'ungueltig' });
    await kern.speichereEinstellungen(u['jörn']!, { standard_lesestil: 'zusammenfassung' } as never);
    // eine bereits gewählte Einstellung bleibt, auch wenn der Admin den Standard ändert
    await kern.setzeLeseEinstellungen(u.kai!, { stil: 'fokus' });
    await kern.speichereEinstellungen(u['jörn']!, { standard_lesestil: 'entscheidung' } as never);
    expect((await kern.leseEinstellungen(u.kai!)).stil).toBe('fokus');
    await kern.speichereEinstellungen(u['jörn']!, { standard_lesestil: 'zusammenfassung' } as never);
  });

  it('Leseeinstellungen liegen in git unter nutzer/<id>/lesen.yaml, ungültige werden abgelehnt', async () => {
    const l = await kern.setzeLeseEinstellungen(u.sabine!, { lesebudget_an: true, budget_hart: true, lesebudget_min_tag: 5 });
    expect(l.lesebudget_hart).toBe(true);
    const pfad = join(dir, `nutzer/${u.sabine!.id}/lesen.yaml`);
    expect(existsSync(pfad)).toBe(true);
    expect(await readFile(pfad, 'utf8')).toContain('lesebudget_hart: true');
    expect((await gitLog(dir, `nutzer/${u.sabine!.id}/lesen.yaml`))[0]?.nachricht).toBe('Leseeinstellungen geändert');
    await expect(kern.setzeLeseEinstellungen(u.sabine!, { stil: 'egal' as never })).rejects.toMatchObject({ code: 'ungueltig' });
    await kern.setzeLeseEinstellungen(u.sabine!, { lesebudget_an: false, lesebudget_hart: false, lesebudget_min_tag: 10 });
  });

  it('heute(): feste Blöcke, Unsicher zuerst, Fundstellen wörtlich, Ansicht nie indiziert', async () => {
    const h = await kern.heute(u.malte!);
    expect(h.stil).toBe('zusammenfassung');
    expect(h.andere_stile).toEqual(['entscheidung', 'fokus']);
    expect(h.ansicht.pfad).toMatch(/^ansichten\/2026-10-24\/a-2026-10-24-[0-9a-f]{8}\.md$/);
    expect(h.zusammenfassung.indexOf('## Unsicher oder fehlgeschlagen')).toBeLessThan(h.zusammenfassung.indexOf('## Zu entscheiden'));
    expect(h.zusammenfassung).toContain('## Darfst du ignorieren');
    expect(h.abweichungen).toContain('Nur Abweichungen');
    expect(h.budget.an).toBe(false);
    for (const p of h.punkte) {
      if (p.block !== 'unsicher') expect(p.belege.length).toBeGreaterThan(0);
      for (const f of p.belege) expect(await kern.zitatStehtDrin(f)).toBe(true);
    }
    expect(h.punkte.length).toBeGreaterThan(0);
    // nie in der Suche
    const t = await kern.suche(u.malte!, 'Unsicher oder fehlgeschlagen', { limit: 20 });
    expect(t.some((x) => x.pfad.startsWith('ansichten/'))).toBe(false);
    // gleiche Daten ⇒ gleiche Ansicht, kein zweiter Commit
    const h2 = await kern.heute(u.malte!);
    expect(h2.ansicht.kopf.id).toBe(h.ansicht.kopf.id);
  });

  it('Stil entscheidung: höchstens drei Entscheidungen; fokus: Budget immer hart', async () => {
    const e = await kern.heute(u['jörn']!, { stil: 'entscheidung' });
    expect(e.ansicht.kopf.zweck).toBe('entscheidungsvorlage');
    expect((e.zu_entscheiden ?? []).length).toBeLessThanOrEqual(3);
    expect((e.zu_entscheiden ?? []).length).toBeGreaterThan(0);
    await kern.setzeLeseEinstellungen(u['jörn']!, { lesebudget_min_tag: 1, woerter_pro_minute: 50 });
    const f = await kern.heute(u['jörn']!, { stil: 'fokus' });
    expect(f.budget.an).toBe(true);
    expect(f.budget.hart).toBe(true);
    expect(f.budget.benutzt_woerter).toBeLessThanOrEqual(f.budget.woerter);
    // weiches Budget: alles sichtbar, nur Hinweis
    await kern.setzeLeseEinstellungen(u['jörn']!, { lesebudget_an: true, lesebudget_hart: false });
    const w = await kern.heute(u['jörn']!, { stil: 'zusammenfassung' });
    expect(w.budget.hart).toBe(false);
    expect(w.zurueckgestellt).toBe(0);
    if (w.budget.ueberschritten) expect(w.hinweis).toMatch(/Budget/);
    await kern.setzeLeseEinstellungen(u['jörn']!, { lesebudget_an: false, lesebudget_min_tag: 10, woerter_pro_minute: 200 });
  });

  it('Rückkopplungsschutz: keine Ansicht, kein Artikel und keine Quelle aus Ansichten', async () => {
    const h = await kern.heute(u.malte!);
    await expect(kern.ansicht(u.malte!, { zweck: 'thema', pfade: [h.ansicht.pfad] })).rejects.toMatchObject({ code: 'rueckkopplung' });
    await expect(kern.kompiliere(u.malte!, h.ansicht.pfad)).rejects.toMatchObject({ code: 'rueckkopplung' });
    await expect(kern.fuegeHinzu(u.malte!, { art: 'datei', dateiPfad: join(dir, h.ansicht.pfad), sammlung: 'x', sichtbarkeit: 'betrieb' })).rejects.toMatchObject({ code: 'rueckkopplung' });
  });

  it('Ansichten sind persönlich; Basis-Änderung wird erkannt', async () => {
    const a = await kern.ansicht(u.malte!, { zweck: 'thema', thema: 'Zahlungsziel' });
    expect(a.kopf.fuer).toBe(u.malte!.id);
    expect(a.kopf.punkte[0]?.block).toBe('unsicher');
    expect(a.kopf.basis.every((b) => !b.pfad.startsWith('ansichten/'))).toBe(true);
    await expect(kern.leseAnsicht(u.lena!, a.kopf.id)).rejects.toMatchObject({ code: 'nicht_gefunden' });
    expect((await kern.ansichten(u.lena!)).some((x) => x.id === a.kopf.id)).toBe(false);
    expect((await kern.leseAnsicht(u.malte!, a.kopf.id)).kopf.status).toBe('aktuell');
    const basis = a.kopf.basis[0]!;
    await writeFile(join(dir, basis.pfad), `${await readFile(join(dir, basis.pfad), 'utf8')}\nNachtrag.\n`);
    expect((await kern.leseAnsicht(u.malte!, a.kopf.id)).kopf.status).toBe('basis_geaendert');
    await kern.verwerfeAnsicht(u.malte!, a.kopf.id);
    await expect(kern.leseAnsicht(u.malte!, a.kopf.id)).rejects.toMatchObject({ code: 'nicht_gefunden' });
  });

  it('Lesestand und Lesebilanz nur für den Lesenden; sanfter Hinweis bietet nächsten Stil an', async () => {
    const h = await kern.heute(u.lena!);
    await kern.lesestand(u.lena!, { objekt: h.ansicht.kopf.id, stufe: 1 });
    await expect(kern.lesestand(u.lena!, { objekt: 'x', stufe: 7 as never })).rejects.toMatchObject({ code: 'ungueltig' });
    const b = await kern.lesebilanz(u.lena!);
    expect(b.minutenZusammenfassung).toBeGreaterThanOrEqual(1);
    expect(b.hinweis).toBeNull(); // erst ab 30 Minuten
    // Admin bekommt keine Daten anderer: lesebilanz kennt nur den Aufrufer
    const admin = await kern.lesebilanz(u['jörn']!);
    expect(admin.minutenZusammenfassung).toBe(0);
  });

  it('Ampel ist deterministisch (Frist ≤ 7 Tage rot, Team gelb, Rest grün)', () => {
    expect(kern.ampel(u.lena!, { punkt: { frist: '2026-10-28' } }).farbe).toBe('rot');
    expect(kern.ampel(u.lena!, { punkt: { sichtbarkeit: 'team:werkstatt' } }).farbe).toBe('gelb');
    expect(kern.ampel(u.lena!, { punkt: { sichtbarkeit: 'betrieb' } })).toMatchObject({ farbe: 'gruen', regel: 'rest' });
    expect(kern.ampel(u.lena!, { punkt: { risiko: 'hoch' } }).farbe).toBe('rot');
  });

  it('Eingang zeigt höchstens max_offene_vorschlaege, alle auf Wunsch', async () => {
    const alle = await kern.eingang(u['jörn']!, { alle: true });
    const z = await kern.eingangZahl(u['jörn']!);
    expect(z.gesamt).toBe(alle.length);
    expect(z.gezeigt).toBeLessThanOrEqual(3);
  });
});
