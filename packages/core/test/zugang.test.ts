import { afterAll, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Kern } from '../src/kern.js';
import { aufraeumen, benutzerSatz, oeffne, tmp } from './helfer.js';

afterAll(() => aufraeumen());

describe('Zugangsspeicher (Sitzungen, API/MCP, OAuth 2.1)', () => {
  it('erzeugt nur für sich selbst, prüft Art/Scope/Zielgruppe, speichert nur Hashes', async () => {
    const dir = tmp();
    const kern = await oeffne(dir);
    const b = await benutzerSatz(kern);
    expect(() => kern.zugang.erzeuge(b.leser, { art: 'mcp' }, b.admin)).toThrow(expect.objectContaining({ code: 'keine_rechte' }));
    expect(() => kern.zugang.erzeuge(b.leser, { art: 'mcp', scopes: ['kern:alles' as never] })).toThrow(expect.objectContaining({ code: 'ungueltig' }));
    expect(() => kern.zugang.erzeuge(b.leser, { art: 'mcp', scopes: ['kern:verwalten'] })).toThrow(expect.objectContaining({ code: 'keine_rechte' }));
    expect(() => kern.zugang.erzeuge(b.leser, { art: 'mcp', gueltigSek: null as never })).toThrow(expect.objectContaining({ code: 'ungueltig' }));
    expect(() => kern.zugang.erzeuge(b.leser, { art: 'api', gueltigSek: 366 * 86400 })).toThrow(expect.objectContaining({ code: 'ungueltig' }));
    expect(() => kern.zugang.erzeuge(b.leser, { art: 'mcp', scopes: ['kern:lesen', 'kern:vorschlagen'] })).toThrow(expect.objectContaining({ code: 'keine_rechte' }));
    const ag = kern.zugang.erzeuge(b.autor, { art: 'mcp', agent: 'nachtlauf', reichweite: 'team', scopes: ['kern:lesen', 'kern:vorschlagen'] });
    expect(ag.eintrag).toMatchObject({ agent: 'nachtlauf', reichweite: 'team' });
    expect(() => kern.zugang.erzeuge(b.autor, { art: 'mcp', reichweite: 'welt' as never })).toThrow(expect.objectContaining({ code: 'ungueltig' }));
    const { token, eintrag } = kern.zugang.erzeuge(b.leser, { art: 'mcp', bezeichnung: 'Claude Desktop', geraet: 'Mac', zielgruppe: 'https://x/mcp' });
    expect(token).toMatch(/^kern_[A-Za-z0-9_-]{43}$/);
    expect(eintrag.scopes).toEqual(['kern:lesen', 'kern:fragen']);
    expect(eintrag.laeuftAb).toBe('2027-01-22T10:00:00.000Z'); // 90 Tage
    expect(kern.zugang.pruefe(token)?.user.id).toBe(b.leser.id);
    expect(kern.zugang.pruefe(token, { art: 'sitzung' })).toBeNull();
    expect(kern.zugang.pruefe(token, { scope: 'kern:vorschlagen' })).toBeNull();
    expect(kern.zugang.pruefe(token, { zielgruppe: 'https://anders/mcp' })).toBeNull();
    expect(kern.zugang.pruefe(token + 'x')).toBeNull();
    const roh = await readFile(join(dir, '.kern/zugang.sqlite'));
    expect(roh.includes(Buffer.from(token))).toBe(false);
    // Liste: eigene ja, fremde nur admin; widerrufen fremd nur admin
    expect(kern.zugang.liste(b.leser).map((x) => x.id)).toEqual([eintrag.id]);
    expect(() => kern.zugang.liste(b.autor, b.leser.id)).toThrow(expect.objectContaining({ code: 'keine_rechte' }));
    expect(kern.zugang.widerrufe(b.autor, eintrag.id)).toBe(false);
    expect(kern.zugang.liste(b.admin, b.leser.id)).toHaveLength(1);
    expect(kern.zugang.widerrufe(b.admin, eintrag.id)).toBe(true);
    expect(kern.zugang.pruefe(token)).toBeNull();
    await kern.schliesse();
  });

  it('Passwortwechsel beendet Sitzungen und Tokens, zählt zugangsStand; Löschen widerruft', async () => {
    const kern = await oeffne();
    const b = await benutzerSatz(kern);
    const s = kern.zugang.erzeuge(b.autor, { art: 'sitzung', geraet: 'Firefox' });
    const m = kern.zugang.erzeuge(b.autor, { art: 'mcp' });
    expect(kern.zugang.pruefe(s.token, { art: 'sitzung' })?.eintrag.scopes).toContain('kern:vorschlagen');
    await expect(kern.benutzer.aenderePasswort(b.autor.id, 'falsch-falsch', 'neues-passwort-1')).rejects.toMatchObject({ code: 'keine_rechte' });
    const vor = (await kern.benutzer.hole(b.autor.id))!.zugangsStand!;
    await kern.benutzer.aenderePasswort(b.autor.id, 'passwort-1', 'neues-passwort-1');
    expect((await kern.benutzer.hole(b.autor.id))!.zugangsStand).toBe(vor + 1);
    expect(kern.zugang.pruefe(s.token)).toBeNull();
    expect(kern.zugang.pruefe(m.token)).toBeNull();
    // Admin-Zurücksetzen
    await kern.benutzer.aendere(b.autor.id, { passwort: 'zufall-zufall-1', mussPasswortAendern: true });
    expect((await kern.benutzer.pruefe(b.autor.name, 'zufall-zufall-1'))?.mussPasswortAendern).toBe(true);
    await kern.benutzer.aenderePasswort(b.autor.id, 'zufall-zufall-1', 'eigenes-passwort-2');
    expect((await kern.benutzer.hole(b.autor.id))?.mussPasswortAendern).toBe(false);
    // „überall abmelden außer hier“
    const s1 = kern.zugang.erzeuge(b.autor, { art: 'sitzung' });
    const s2 = kern.zugang.erzeuge(b.autor, { art: 'sitzung' });
    expect(kern.zugang.widerrufeAlle(b.autor, b.autor.id, { ausser: s1.eintrag.id })).toBe(1);
    expect(kern.zugang.pruefe(s1.token)).not.toBeNull();
    expect(kern.zugang.pruefe(s2.token)).toBeNull();
    expect(() => kern.zugang.widerrufeAlle(b.leser, b.autor.id)).toThrow(expect.objectContaining({ code: 'keine_rechte' }));
    await kern.benutzer.loesche(b.autor.id);
    expect(kern.zugang.pruefe(s1.token)).toBeNull();
    await kern.schliesse();
  });

  it('Rollenwechsel wirkt sofort; kern:verwalten verfällt ohne Admin', async () => {
    const kern = await oeffne();
    const b = await benutzerSatz(kern);
    const t = kern.zugang.erzeuge(b.admin, { art: 'api', scopes: ['kern:verwalten'] });
    expect(kern.zugang.pruefe(t.token)?.user.rollen).toContain('admin');
    await kern.benutzer.aendere(b.admin.id, { rollen: ['leser'] });
    expect(kern.zugang.pruefe(t.token)).toBeNull();
    await kern.schliesse();
  });

  it('OAuth 2.1: Registrierung, PKCE S256, einmaliger Code, Rotation mit Familien-Widerruf', async () => {
    const kern = await oeffne();
    const b = await benutzerSatz(kern);
    expect(() => kern.zugang.registriereClient({ name: 'x', redirectUris: ['http://boese.example/cb'] })).toThrow(expect.objectContaining({ code: 'ungueltig' }));
    const c = kern.zugang.registriereClient({ name: 'Claude', redirectUris: ['https://claude.ai/api/mcp/auth_callback', 'http://localhost:6274/cb'] });
    const verifier = 'v'.repeat(50);
    const challenge = createHash('sha256').update(verifier).digest('base64url');
    const code = kern.zugang.erzeugeCode(b.autor, { clientId: c.clientId, redirectUri: 'http://localhost:6274/cb', codeChallenge: challenge, scopes: ['kern:lesen', 'kern:fragen'], zielgruppe: 'https://k/mcp' });
    expect(kern.zugang.loeseCodeEin(code, { clientId: c.clientId, redirectUri: 'http://localhost:6274/cb', codeVerifier: 'w'.repeat(50) })).toBeNull();
    const code2 = kern.zugang.erzeugeCode(b.autor, { clientId: c.clientId, redirectUri: 'http://localhost:6274/cb', codeChallenge: challenge, scopes: ['kern:lesen'], zielgruppe: 'https://k/mcp' });
    const p = kern.zugang.loeseCodeEin(code2, { clientId: c.clientId, redirectUri: 'http://localhost:6274/cb', codeVerifier: verifier })!;
    expect(p).not.toBeNull();
    expect(kern.zugang.loeseCodeEin(code2, { clientId: c.clientId, redirectUri: 'http://localhost:6274/cb', codeVerifier: verifier })).toBeNull(); // einmalig
    expect(kern.zugang.pruefe(p.zugriff.token, { zielgruppe: 'https://k/mcp', scope: 'kern:lesen' })?.user.id).toBe(b.autor.id);
    expect(kern.zugang.pruefe(p.zugriff.token)?.eintrag.agent).toBe('Claude');
    expect(kern.zugang.liste(b.autor, undefined, { clientId: c.clientId }).length).toBe(2);
    expect(() => kern.zugang.erzeugeCode(b.admin, { clientId: c.clientId, redirectUri: 'http://localhost:6274/cb', codeChallenge: challenge, scopes: ['kern:verwalten'], zielgruppe: 'https://k/mcp' })).toThrow(expect.objectContaining({ code: 'ungueltig' }));
    expect(kern.zugang.pruefe(p.erneuerung.token)).toBeNull(); // Erneuerung nie als Zugriff
    const p2 = kern.zugang.erneuere(p.erneuerung.token, { clientId: c.clientId })!;
    expect(p2).not.toBeNull();
    expect(kern.zugang.pruefe(p.zugriff.token)).toBeNull();
    // Wiederverwendung des alten Erneuerungs-Tokens ⇒ ganze Familie widerrufen
    expect(kern.zugang.erneuere(p.erneuerung.token)).toBeNull();
    expect(kern.zugang.pruefe(p2.zugriff.token)).toBeNull();
    expect(kern.zugang.erneuere(p2.erneuerung.token)).toBeNull();
    await kern.schliesse();
  });

  it('übernimmt alte Tokens aus users.json und .kern/tokens.json einmalig', async () => {
    const dir = tmp();
    let kern = await oeffne(dir);
    const b = await benutzerSatz(kern);
    await kern.schliesse();
    const alt1 = 'kern_altes-token-aus-users-json-aaaaaaaaaaaaaaaaaaaaaaaa';
    const alt2 = 'kern_altes-token-aus-tokens-json-bbbbbbbbbbbbbbbbbbbbbbbb';
    const sha = (t: string) => createHash('sha256').update(t).digest('hex');
    const users = JSON.parse(await readFile(join(dir, '.kern/users.json'), 'utf8')) as { id: string; tokens?: unknown[] }[];
    users.find((x) => x.id === b.leser.id)!.tokens = [{ hash: sha(alt1), name: 'alt', erstellt: '2026-10-01T00:00:00.000Z' }];
    await writeFile(join(dir, '.kern/users.json'), JSON.stringify(users));
    await mkdir(join(dir, '.kern'), { recursive: true });
    await writeFile(join(dir, '.kern/tokens.json'), JSON.stringify([{ id: 't_x', userId: b.autor.id, bezeichnung: 'MCP', erstellt: '2026-10-20T00:00:00.000Z', zuletzt: null, hash: sha(alt2) }]));
    kern = await Kern.open({ dataDir: dir, provider: { art: 'mock' }, betrieb: 'T', sprache: 'de', heute: () => new Date('2026-10-24T10:00:00Z') });
    expect(kern.zugang.pruefe(alt1)?.user.id).toBe(b.leser.id);
    const r = kern.zugang.pruefe(alt2)!;
    expect(r.user.id).toBe(b.autor.id);
    expect(r.eintrag.scopes).toEqual(['kern:lesen', 'kern:fragen', 'kern:vorschlagen']);
    expect(r.eintrag.laeuftAb).toBe('2027-01-18T00:00:00.000Z');
    expect(existsSync(join(dir, '.kern/tokens.json'))).toBe(false);
    expect(existsSync(join(dir, '.kern/tokens.json.migriert'))).toBe(true);
    expect(await readFile(join(dir, '.kern/users.json'), 'utf8')).not.toContain('"tokens"');
    // veraltete Wrapper
    const neu = await kern.benutzer.erzeugeToken(b.leser.id);
    expect((await kern.benutzer.pruefeToken(neu))?.id).toBe(b.leser.id);
    await kern.benutzer.widerrufeTokens(b.leser.id);
    expect(await kern.benutzer.pruefeToken(neu)).toBeNull();
    // Kurzform
    const e = await kern.zugangEinfach.erstelle(b.autor.id, { bezeichnung: 'x', scope: ['lesen', 'schreiben'], gueltigTage: 30 });
    expect((await kern.zugangEinfach.pruefe(e.token))?.scope).toEqual(['lesen', 'schreiben']);
    await expect(kern.zugangEinfach.erstelle(b.autor.id, { bezeichnung: 'x', scope: ['alles' as never], gueltigTage: 1 })).rejects.toMatchObject({ code: 'ungueltig' });
    await kern.schliesse();
  });

  it('CIMD-Client merken (upsert), DCR-Clients ohne Nutzung nach 30 Tagen aufräumen', async () => {
    let jetzt = new Date('2026-10-24T10:00:00Z');
    const kern = await oeffne(undefined, { heute: () => jetzt });
    expect(() => kern.zugang.merkeCimdClient({ clientId: 'http://x.example/c.json', name: 'X', redirectUris: ['https://x.example/cb'] })).toThrow(expect.objectContaining({ code: 'ungueltig' }));
    const c = kern.zugang.merkeCimdClient({ clientId: 'https://claude.ai/oauth/client.json', name: 'Claude', redirectUris: ['https://claude.ai/cb'] });
    expect(c).toMatchObject({ art: 'cimd', clientId: 'https://claude.ai/oauth/client.json' });
    expect(kern.zugang.merkeCimdClient({ clientId: c.clientId, name: 'Claude 2', redirectUris: ['https://claude.ai/cb2'] }).redirectUris).toEqual(['https://claude.ai/cb2']);
    const d = kern.zugang.registriereClient({ name: 'Alt', redirectUris: ['https://alt.example/cb'] });
    expect(d.art).toBe('dcr');
    jetzt = new Date('2026-12-01T10:00:00Z');
    kern.zugang.aufraeumen();
    expect(kern.zugang.holeClient(d.clientId)).toBeNull();
    expect(kern.zugang.holeClient(c.clientId)).not.toBeNull();
    await kern.schliesse();
  });

  it('D-L7: scrypt 2^17, alter 2^15-Hash wird beim Login erneuert', async () => {
    const dir = tmp();
    const kern = await oeffne(dir);
    const a = await kern.benutzer.anlegen('Alt Nutzer', 'passwort-alt-1', ['leser']);
    const neuHash = (await readFile(join(dir, '.kern/users.json'), 'utf8')).match(/scrypt\$(\d+)\$/)![1];
    expect(Number(neuHash)).toBe(2 ** 17);
    const { hashPasswort, brauchtRehash } = await import('../src/benutzer.js');
    const users = JSON.parse(await readFile(join(dir, '.kern/users.json'), 'utf8')) as { id: string; passwort: string }[];
    // alten Hash mit 2^15 herstellen
    const { scrypt, randomBytes } = await import('node:crypto');
    const salz = randomBytes(16);
    const h = await new Promise<Buffer>((r, f) => scrypt('passwort-alt-1', salz, 32, { N: 2 ** 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }, (e, k) => (e ? f(e) : r(k))));
    users.find((x) => x.id === a.id)!.passwort = `scrypt$32768$8$1$${salz.toString('base64')}$${h.toString('base64')}`;
    await writeFile(join(dir, '.kern/users.json'), JSON.stringify(users));
    expect(brauchtRehash(users[0]!.passwort)).toBe(true);
    expect(brauchtRehash(await hashPasswort('x'.repeat(8)))).toBe(false);
    expect((await kern.benutzer.pruefe('Alt Nutzer', 'passwort-alt-1'))?.id).toBe(a.id);
    expect(await readFile(join(dir, '.kern/users.json'), 'utf8')).toContain('scrypt$131072$8$1$');
    expect((await kern.benutzer.pruefe('Alt Nutzer', 'passwort-alt-1'))?.id).toBe(a.id);
    await kern.schliesse();
  });
});
