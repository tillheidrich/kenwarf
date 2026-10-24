import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { agentenScopes, alsAgent, pruefePfad } from '../src/gedaechtnis.js';
import { schaetzeTokens } from '../src/kontextpaket.js';
import { aufraeumen, gitLog, seedKern } from './helfer.js';

afterAll(() => aufraeumen());

describe('v1.4 9 Kontextbilanz', () => {
  it('zählt aus Dateien, git, Eingang und Zählern, ohne Personen oder Inhalte; Stufe 4 ist Fahrplan', async () => {
    const { kern, u } = await seedKern();
    await expect(kern.kontextbilanz(u['kai']!)).rejects.toThrow();
    expect((await kern.kontextbilanz(u['jörn']!)).ersteBelegteAntwort).toBeNull();
    await kern.frage(u['lena']!, 'Was muss ich zum Aufmaß mitnehmen?');
    await kern.frage(u['lena']!, 'Wie hoch ist der Aktienkurs von Tesla?');
    kern.zugang.erzeuge(u['kai']!, { art: 'mcp', agent: 'Claude Code', scopes: agentenScopes('autor'), gueltigSek: 3600 });
    const b = await kern.kontextbilanz(u['jörn']!);
    expect(b.stand).toBe('2026-10-24');
    expect(b.bestand.artikel).toBeGreaterThan(20);
    expect(b.bestand.fakten).toBe(8);
    expect(b.antworten).toMatchObject({ belegt: 1, stehtNichtDrin: 1 });
    expect(b.ersteBelegteAntwort!.sekundenSeitStart).toBeGreaterThanOrEqual(0);
    expect(b.pflege.faktenMitGueltigkeit).toBe(2);
    expect(b.bemerkt.abgelaufeneFristen).toBe(1);
    expect(b.bemerkt.vorAblaufGemeldet).toBe(1);
    expect(b.eingang.offen).toBe(2);
    expect(b.anbindungen.agentenZugaenge).toBe(1);
    expect(b.stufen.map((s) => s.status)).toEqual(['gemessen', 'gemessen', 'teilweise', 'fahrplan', 'gemessen', 'teilweise']);
    expect(b.pruefbank).toMatchObject({ letzterLauf: null, kiStatus: 'geprueft' });
    const json = JSON.stringify(b);
    for (const verboten of ['Aufmaß', 'Tesla', 'lena', 'joern', 'Jörn', 'kai-brandes', 'Claude Code']) expect(json).not.toContain(verboten);
    // Freigeberin aus dem Büro sieht die Merkliste von Malte (ich) nicht
    const s = await kern.kontextbilanz(u['sabine']!);
    expect(s.bestand.artikel).toBeLessThan(b.bestand.artikel);
    expect(s.anbindungen.agentenZugaenge).toBe(0);
    await kern.schliesse();
  });
});

describe('v1.4 8.3 Kontextpaket', () => {
  it('Budget nie überschritten, Zitate wörtlich mit Herkunft, Fakten mit Gültigkeit, keine Datei ohne Recht', async () => {
    const { kern, u } = await seedKern();
    for (const budget of [200, 600, 1500, 4000]) {
      const p = await kern.kontextpaket(u['lena']!, { frage: 'Wie viel Anzahlung nehmen wir bei Einbauküchen?', budgetTokens: budget });
      expect(p.tokens).toBeLessThanOrEqual(budget);
      expect(schaetzeTokens(p)).toBe(p.tokens);
      expect(p.ki_erzeugt).toBe(false);
      for (const a of p.abschnitte) {
        expect(await kern.zitatStehtDrin({ quelle: a.pfad, abschnitt: a.abschnitt, zeilen: a.zeilen, zitat: a.zitat })).toBe(true);
        expect(a.herkunft.commit).toMatch(/^[0-9a-f]{40}$/);
      }
    }
    const gross = await kern.kontextpaket(u['lena']!, { frage: 'Wie viel Anzahlung nehmen wir bei Einbauküchen?', budgetTokens: 4000 });
    expect(gross.fakten.some((f) => f.id === 'anzahlung-einbaukueche-treppe' && f.herkunft.pfad.startsWith('quellen/'))).toBe(true);
    expect(gross.abschnitte.length).toBeGreaterThan(0);
    expect(gross.wegweiser).toMatch(/kern_lese/);
    // Rechte: Merkliste von Malte (ich) taucht für Kai nicht auf, für Malte schon
    const kai = await kern.kontextpaket(u['kai']!, { thema: 'Bitsätze Akkuschrauber bestellen', budgetTokens: 4000 });
    expect(kai.abschnitte.some((a) => a.pfad === 'wissen/notizen/merkliste-malte.md')).toBe(false);
    const malte = await kern.kontextpaket(u['malte']!, { thema: 'Bitsätze Akkuschrauber bestellen', budgetTokens: 4000 });
    expect(malte.abschnitte.some((a) => a.pfad === 'wissen/notizen/merkliste-malte.md')).toBe(true);
    await expect(kern.kontextpaket(u['lena']!, { budgetTokens: 1000 })).rejects.toThrow();
    await kern.schliesse();
  });
});

describe('v1.4 8.4/8.5 Agentenprofile und Gedächtnis-Adapter', () => {
  it('Profile: leser ohne Schreib-Scope, nie verwalten; alsAgent senkt Rollen', async () => {
    expect(agentenScopes('leser')).toEqual(['kern:lesen', 'kern:fragen']);
    expect(agentenScopes('autor')).not.toContain('kern:verwalten');
    const admin = { id: 'a', name: 'A', rollen: ['admin' as const], teams: [] };
    expect(alsAgent(admin, { agent: 'x', scopes: ['kern:lesen'], reichweite: 'team' }).rollen).toEqual(['leser']);
    expect(alsAgent(admin, { agent: 'x', scopes: ['kern:vorschlagen'], reichweite: null }).rollen).toEqual(['autor']);
    const lena = { id: 'l', name: 'L', rollen: ['leser' as const], teams: [] };
    expect(alsAgent(lena, { agent: 'x', scopes: ['kern:vorschlagen'], reichweite: null }).rollen).toEqual(['leser']);
  });

  it('Pfadausbruch abgewiesen (auch kodiert), Wurzel geschützt', async () => {
    const u = { id: 'kai-brandes', name: 'Kai', rollen: ['autor' as const], teams: [] };
    for (const p of ['/memories/../../secrets.env', '/memories/notizen/../../.kern/users.json', '/memories/%2e%2e/%2e%2e/x', '/memories/notizen/%252e%252e/x', '/etc/passwd', '/memories\\..\\x', '/memories/notizen/.git/config']) {
      expect(() => pruefePfad(p, u), p).toThrow();
    }
    expect(pruefePfad('/memories/notizen/a/b.md', u)).toEqual({ bereich: 'notizen', rel: 'a/b.md', daten: 'nutzer/kai-brandes/notizen/a/b.md' });
    expect(pruefePfad('/memories/wissen/ablaeufe/x.md', u)).toMatchObject({ bereich: 'wissen', daten: 'wissen/ablaeufe/x.md' });
    const { kern, u: us } = await seedKern();
    expect(await kern.gedaechtnis(us['kai']!, { command: 'delete', path: '/memories' })).toMatchObject({ ok: false });
    expect(await kern.gedaechtnis(us['kai']!, { command: 'rename', old_path: '/memories', new_path: '/memories/x' })).toMatchObject({ ok: false });
    expect((await kern.gedaechtnis(us['kai']!, { command: 'view', path: '/memories/../x' })).ok).toBe(false);
    await kern.schliesse();
  });

  it('Notizen: direkt, in git mit generated, nie in der Suche; wissen: nur Vorschläge, Datei unverändert; leser liest nur', async () => {
    const { kern, dir, u } = await seedKern();
    const kai = u['kai']!;
    const r1 = await kern.gedaechtnis(kai, { command: 'create', path: '/memories/notizen/stand.md', file_text: '# Arbeitsstand\n\nZwischenschliff-Zauberwort Quarkbrot 4711.\n' }, { agent: 'Claude Code' });
    expect(r1).toEqual({ ok: true, text: 'File created successfully at: /memories/notizen/stand.md' });
    expect(existsSync(join(dir, 'nutzer/kai-brandes/notizen/stand.md'))).toBe(true);
    const log = await gitLog(dir, 'nutzer/kai-brandes/notizen/stand.md');
    expect(log[0]).toMatchObject({ autor: 'agent/Claude Code@kai-brandes' });
    expect(log[0]!.text).toContain('generated');
    expect(await kern.suche(kai, 'Quarkbrot 4711')).toEqual([]);
    expect((await kern.frage(kai, 'Was ist das Zauberwort Quarkbrot?')).status).toBe('steht_nicht_drin');
    const sr = await kern.gedaechtnis(kai, { command: 'str_replace', path: '/memories/notizen/stand.md', old_str: 'Quarkbrot 4711', new_str: 'Butterbrot' });
    expect(sr.text).toMatch(/^The memory file has been edited\./);
    expect((await kern.gedaechtnis(kai, { command: 'str_replace', path: '/memories/notizen/stand.md', old_str: 'gibtsnicht', new_str: 'x' })).text).toMatch(/did not appear verbatim/);
    expect((await kern.gedaechtnis(kai, { command: 'insert', path: '/memories/notizen/stand.md', insert_line: 99, insert_text: 'x' })).text).toMatch(/Invalid `insert_line`/);
    expect((await kern.gedaechtnis(kai, { command: 'insert', path: '/memories/notizen/stand.md', insert_line: 1, insert_text: 'Zeile zwei' })).ok).toBe(true);
    const v = await kern.gedaechtnis(kai, { command: 'view', path: '/memories/notizen/stand.md' });
    expect(v.text).toBe('Here\'s the content of /memories/notizen/stand.md with line numbers:\n     1\t# Arbeitsstand\n     2\tZeile zwei\n     3\t\n     4\tZwischenschliff-Zauberwort Butterbrot.\n     5\t');
    expect((await kern.gedaechtnis(kai, { command: 'rename', old_path: '/memories/notizen/stand.md', new_path: '/memories/notizen/alt/stand.md' })).text).toBe('Successfully renamed /memories/notizen/stand.md to /memories/notizen/alt/stand.md');
    const wurzel = await kern.gedaechtnis(kai, { command: 'view', path: '/memories' });
    expect(wurzel.text).toMatch(/^Here're the files and directories up to 2 levels deep in \/memories/);
    expect(wurzel.text).toMatch(/\t\/memories\/notizen\/alt$/m);
    expect(wurzel.text).not.toContain('/memories/notizen/alt/stand.md');
    expect(wurzel.text).toContain('\t/memories/wissen/ablaeufe');
    expect(wurzel.text).not.toContain('merkliste-malte');
    // Malte sieht Kais Notizen nicht
    expect((await kern.gedaechtnis(u['malte']!, { command: 'view', path: '/memories/notizen/alt/stand.md' })).ok).toBe(false);

    // wissen: Vorschlag statt Änderung
    const ziel = join(dir, 'wissen/ablaeufe/reklamation.md');
    const vorher = readFileSync(ziel, 'utf8');
    const mt = statSync(ziel).mtimeMs;
    const w = await kern.gedaechtnis(kai, { command: 'str_replace', path: '/memories/wissen/ablaeufe/reklamation.md', old_str: 'Am Telefon nichts zu Ursache', new_str: 'Am Telefon bitte nichts zu Ursache' }, { agent: 'Claude Code' });
    expect(w.ok).toBe(true);
    expect(w.vorschlaege?.[0]).toMatchObject({ art: 'aenderung', ziel: 'wissen/ablaeufe/reklamation.md', status: 'offen', von: 'agent/Claude Code@kai-brandes' });
    expect(readFileSync(ziel, 'utf8')).toBe(vorher);
    expect(statSync(ziel).mtimeMs).toBe(mt);
    expect((await kern.eingang(kai, { alle: true })).some((x) => x.id === w.vorschlaege![0]!.id)).toBe(true);
    const del = await kern.gedaechtnis(kai, { command: 'delete', path: '/memories/wissen/ablaeufe/reklamation.md' });
    expect(del.vorschlaege?.[0]?.art).toBe('loeschung');
    expect(existsSync(ziel)).toBe(true);
    const neu = await kern.gedaechtnis(kai, { command: 'create', path: '/memories/wissen/werkstatt/leimzeiten.md', file_text: '# Leimzeiten\n\nWeißleim braucht 30 Minuten Presszeit.\n' });
    expect(neu.vorschlaege?.[0]).toMatchObject({ art: 'neu', ziel: 'wissen/werkstatt/leimzeiten.md' });
    expect(existsSync(join(dir, 'wissen/werkstatt/leimzeiten.md'))).toBe(false);
    // fremde private Datei: existiert für Kai nicht
    expect((await kern.gedaechtnis(kai, { command: 'view', path: '/memories/wissen/notizen/merkliste-malte.md' })).text).toMatch(/does not exist/);
    // Leser: nur lesen
    const lena = u['lena']!;
    expect((await kern.gedaechtnis(lena, { command: 'view', path: '/memories/wissen/ablaeufe/reklamation.md' })).ok).toBe(true);
    expect((await kern.gedaechtnis(lena, { command: 'create', path: '/memories/notizen/a.md', file_text: 'x' })).text).toMatch(/read-only/);
    // Ablauf: nach 90 Tagen erscheinen Notizen in notizenAblauf
    expect(await kern.notizenAblauf(kai)).toEqual([]);
    await kern.schliesse();
  });
});
