import { afterAll, describe, expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import JSZip from 'jszip';
import { simpleGit } from 'simple-git';
import { umzugAuspacken } from '../src/export.js';
import { packeTar, lieseTar } from '../src/tar.js';
import { aufraeumen, benutzerSatz, oeffne, seedKern, tmp } from './helfer.js';

afterAll(() => aufraeumen());

describe('v1.4 7: Export, Umzugspaket, Ausstiegsprobe', () => {
  it('tar: Rundlauf mit langen Pfaden; Ausbruch abgelehnt', () => {
    const lang = `daten/${'a'.repeat(120)}/datei.md`;
    const t = packeTar([{ pfad: 'x.txt', daten: Buffer.from('hallo') }, { pfad: lang, daten: Buffer.from('lang') }]);
    expect(lieseTar(t).map((e) => [e.pfad, e.daten.toString()])).toEqual([['x.txt', 'hallo'], [lang, 'lang']]);
    expect(() => lieseTar(packeTar([{ pfad: '../boese', daten: Buffer.from('x') }]))).toThrow(/Unzulässiger Pfad/);
  });

  it('Umzugspaket: verschlüsselt, vollständig, Zugänge und Verlauf ziehen mit, Prüfbericht bestanden', async () => {
    const { kern, u, dir } = await seedKern();
    const admin = u['jörn']!;
    const tok = kern.zugang.erzeuge(u.kai!, { art: 'mcp', bezeichnung: 'Claude', agent: 'claude' });
    kern.zugang.erzeuge(u.kai!, { art: 'sitzung' });
    await kern.fuegeHinzu(u.kai!, { art: 'text', titel: 'Privat Kai', inhalt: 'Nur für Kai.', sammlung: 'x', sichtbarkeit: 'ich', kompilieren: false });
    const ziel = join(tmp('paket-'), 'umzug.tar.age');
    await expect(kern.exportiere(u.kai!, { art: 'umzugspaket', ziel, passphrase: 'lang-genug-123' })).rejects.toMatchObject({ code: 'keine_rechte' });
    await expect(kern.exportiere(admin, { art: 'umzugspaket', ziel, passphrase: 'kurz' })).rejects.toMatchObject({ code: 'ungueltig' });
    const r = await kern.exportiere(admin, { art: 'umzugspaket', ziel, passphrase: 'lang-genug-123', instanz: 'test' });
    expect(r.bytes).toBeGreaterThan(1000);
    const roh = await readFile(ziel);
    expect(roh.subarray(0, 21).toString()).toBe('age-encryption.org/v1');
    expect(roh.includes(Buffer.from('Nur für Kai'))).toBe(false);
    const head = await simpleGit(dir).revparse(['HEAD']);
    await kern.schliesse();

    const neu = tmp('ziel-');
    await expect(umzugAuspacken(ziel, neu, 'falsch-falsch-123')).rejects.toMatchObject({ code: 'ungueltig' });
    const m = await umzugAuspacken(ziel, neu, 'lang-genug-123');
    expect(m.head).toBe(head.trim());
    expect(m.ausgelassen).toContain('sitzungen');
    expect(existsSync(join(neu, '.kern/index.sqlite'))).toBe(false);
    expect(existsSync(join(neu, '.kern/zugang.sqlite'))).toBe(false);
    const k2 = await oeffne(neu);
    const b = await k2.umzugPruefen(admin);
    expect(b).toMatchObject({ pruefsummen_ok: true, git_fsck_ok: true, head_gleich: true, index_neu: true, pruefen_befunde_neu: 0, bestanden: true });
    // MCP-Token gilt weiter, Sitzungen nicht
    expect(k2.zugang.pruefe(tok.token)?.user.id).toBe(u.kai!.id);
    expect(k2.zugang.liste(u.kai!, undefined, { art: ['sitzung'] })).toHaveLength(0);
    expect((await k2.benutzer.pruefe('Kai Brandes', 'demo-passwort'))?.id).toBe(u.kai!.id);
    expect((await k2.listeQuellen(u.kai!)).some((q) => q.kopf.titel === 'Privat Kai')).toBe(true);
    await k2.schliesse();
  });

  it('ZIP: Admin ohne fremde ich-Dateien (dann ohne .git), mit nutzer.json ohne Hashes; Nutzer nur eigene; Import kern-zip', async () => {
    const kern = await oeffne();
    const b = await benutzerSatz(kern);
    await kern.fuegeHinzu(b.autor, { art: 'text', titel: 'Annas Geheimnis', inhalt: 'Privat.', sammlung: 'x', sichtbarkeit: 'ich', kompilieren: false });
    await kern.fuegeHinzu(b.admin, { art: 'text', titel: 'Hobelmesser', inhalt: 'Alle 40 Stunden.', sammlung: 'x', sichtbarkeit: 'betrieb', kompilieren: false });
    const z = join(tmp('zip-'), 'a.zip');
    const r = await kern.exportiere(b.admin, { art: 'zip', ziel: z });
    expect(r.ausgelassen).toBe(1);
    const zip = await JSZip.loadAsync(await readFile(z));
    const namen = Object.keys(zip.files);
    expect(namen.some((n) => n.startsWith('.git/'))).toBe(false);
    expect(namen.some((n) => n.startsWith('.kern/'))).toBe(false);
    expect(namen).toContain('kern.yaml');
    const nutzer = await zip.file('nutzer.json')!.async('string');
    expect(nutzer).toContain('Anna Autor');
    expect(nutzer).not.toContain('scrypt');
    for (const n of namen) if (!zip.files[n]!.dir) expect(await zip.file(n)!.async('string')).not.toContain('Annas Geheimnis');
    const z2 = join(tmp('zip-'), 'b.zip');
    await kern.exportiere(b.autor, { art: 'zip', ziel: z2 });
    const eigene = Object.keys((await JSZip.loadAsync(await readFile(z2))).files).filter((n) => n.endsWith('.md'));
    expect(eigene).toHaveLength(1);
    // OKF als ZIP
    const z3 = join(tmp('zip-'), 'c.zip');
    const o = await kern.exportiere(b.leser, { art: 'okf', ziel: z3 });
    expect(o.sha256).toMatch(/^[0-9a-f]{64}$/);
    // Import in eine leere Instanz: Quellen plus Vorschläge
    const k2 = await oeffne();
    const a2 = await k2.benutzer.anlegen('Neu Admin', 'passwort-1', ['admin']);
    const imp = await k2.importiere(a2, { art: 'kern-zip', pfad: z });
    expect(imp.quellen.map((q) => q.kopf.titel)).toContain('Hobelmesser');
    expect(await k2.listeWissen(a2)).toHaveLength(0);
    await k2.schliesse();
    await kern.schliesse();
  });

  it('Ausstiegsprobe besteht und liegt unter pruefung/ausstieg/', async () => {
    const { kern, u, dir } = await seedKern();
    await expect(kern.ausstiegsprobe(u.kai!)).rejects.toMatchObject({ code: 'keine_rechte' });
    const p = await kern.ausstiegsprobe(u['jörn']!);
    expect(p.kernZuKern.bestanden).toBe(true);
    expect(p.offen).toMatchObject({ bestanden: true, fundstellenKaputt: 0, ohneGueltigenKopf: [] });
    expect(p.bestanden).toBe(true);
    expect(existsSync(join(dir, `pruefung/ausstieg/${p.am.slice(0, 10)}.json`))).toBe(true);
    expect((await kern.letzteAusstiegsprobe())?.bestanden).toBe(true);
    expect((await kern.suche(u['jörn']!, 'kernZuKern')).length).toBe(0);
    await kern.schliesse();
  });
});

describe('v1.4 4: Beispielsammlung, Vorschlagsfragen, Anbieterwechsel', () => {
  it('Beispiel laden und ohne Rest entfernen; Fragen aus den Unterlagen', async () => {
    const dir = tmp();
    const kern = await oeffne(dir);
    const b = await benutzerSatz(kern);
    expect(await kern.vorschlagsfragen(b.leser)).toEqual([]);
    await expect(kern.beispielLaden(b.autor)).rejects.toMatchObject({ code: 'keine_rechte' });
    const r = await kern.beispielLaden(b.admin);
    expect(kern.beispielGeladen()).toBe(true);
    expect(r.quellen).toHaveLength(4);
    expect(r.vorschlaege.length).toBeGreaterThan(0);
    expect(await kern.benutzer.liste()).toHaveLength(5); // keine Demo-Benutzer
    expect((await kern.frage(b.leser, r.fragen[0]!)).status).toBe('beantwortet');
    expect((await kern.frage(b.leser, r.fangfrage)).status).toBe('steht_nicht_drin');
    const f = await kern.vorschlagsfragen(b.leser);
    expect(f.length).toBeGreaterThan(0);
    expect(f.length).toBeLessThanOrEqual(3);
    expect(await kern.vorschlagsfragen(b.leser)).toEqual(f);
    // ein Beispielartikel wird freigegeben, dann alles entfernen
    await kern.entscheide(b.admin, r.vorschlaege[0]!.id, { aktion: 'freigeben' });
    await kern.beispielEntfernen(b.admin);
    expect(kern.beispielGeladen()).toBe(false);
    expect(await kern.listeWissen(b.admin)).toHaveLength(0);
    expect(await kern.eingang(b.admin, { alle: true })).toHaveLength(0);
    expect(await simpleGit(dir).raw(['log', '--all', '-p'])).not.toContain('Hobelmesser');
    await kern.schliesse();
  });

  it('setzeProvider wechselt ohne Neustart; pruefeVerbindung meldet Fehler ohne Schlüssel', async () => {
    const kern = await oeffne();
    const v = await kern.pruefeVerbindung({ art: 'mock' });
    expect(v.ok).toBe(true);
    const f = await kern.pruefeVerbindung({ art: 'openai', url: 'http://127.0.0.1:9/v1', apiKey: 'sk-geheimgeheimgeheim', chatModell: 'x', embedModell: 'y' });
    expect(f.ok).toBe(false);
    expect(f.meldung).not.toContain('geheimgeheim');
    await kern.setzeProvider({ art: 'mock' });
    expect(kern.modellInfo()).toEqual({ anbieter: 'mock', name: 'mock' });
    await kern.schliesse();
  });
});
