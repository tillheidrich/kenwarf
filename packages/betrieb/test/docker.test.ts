/**
 * Bereitsteller „docker“ gegen den echten lokalen dockerd (Engine API über /var/run/docker.sock).
 * Image: KERN_TEST_BILD (Standard kern:p2, aus deploy/Dockerfile im Arbeitsstand gebaut). Fehlt Docker oder das Image,
 * werden die Tests übersprungen und das steht im Testnamen. Es werden nur Container mit den hier erzeugten IDs
 * angefasst; aufgeräumt wird über die Löschfunktion selbst und am Ende zusätzlich nach ID.
 */
import fs from 'node:fs';
import { afterAll, describe, expect, it } from 'vitest';
import { DockerEngine } from '../src/docker/engine.js';
import { DockerBereitsteller, testId } from '../src/bereitsteller/docker.js';
import { Geheimnisse } from '../src/geheimnisse.js';
import { oeffneDb } from '../src/db.js';
import { Leitstand } from '../src/leitstand.js';

const BILD = process.env.KERN_TEST_BILD ?? 'kern:p2';
const engine = new DockerEngine();
const da = fs.existsSync('/var/run/docker.sock') && (await engine.ping().then(() => engine.bild(BILD)).then(() => true).catch(() => false));
const angelegt: string[] = [];

function bauen(db = oeffneDb(':memory:'), opt: Partial<ConstructorParameters<typeof DockerBereitsteller>[0]> = {}) {
  const g = new Geheimnisse(db, Geheimnisse.zufall());
  return new DockerBereitsteller({ engine, bild: BILD, domain: 'kern.example', geheimnisse: g, egress: null, caddy: null, egressContainer: null, netzPool: '10.239', healthSek: 90, zusatzEnv: { KERN_PROVIDER: 'mock' }, hostId: 'geteilt-test', ...opt });
}

afterAll(async () => {
  if (!da) return;
  for (const id of angelegt) for (const p of ['kern', 'kernz']) {
    await engine.containerEntfernen(`${p}-${id}`).catch(() => undefined);
    await engine.netzEntfernen(`${p === 'kern' ? 'kn' : 'kernzn'}-${id}`).catch(() => undefined);
    for (const v of ['daten', 'export']) await engine.volumeEntfernen(`${p}-${id}-${v}`).catch(() => undefined);
  }
});

describe.skipIf(!da)(`Docker-Bereitsteller gegen lokalen dockerd (${BILD})`, () => {
  it('legt an: Container mit Grenzen, Härtung, internem Netz, Volumes, Health; Einmal-Zugang; Status; Löschen mit Nachweis', async () => {
    const b = bauen();
    const id = testId();
    angelegt.push(id);
    const a = { id, subdomain: `p2-${id.slice(2, 8)}`, paket: 'klein' as const, region: 'de-nbg' as const, ki_vorlage: 'mock' as const, beispiel: null, admin_mail: 'chefin@tischlerei.example', stufe: 'geteilt' as const, host: 'geteilt-test', konto_token: 'kkt_test' };
    const t0 = Date.now();
    for (const s of b.schritte) {
      const r = await b.schritt(s, a);
      if (s === 'admin_einladen') { expect(r.einladung?.mail).toBe(a.admin_mail); expect(r.einladung?.einmalPasswort.length).toBeGreaterThanOrEqual(12); }
      if (s === 'healthz_warten') expect(r.meldung).toMatch(/gesund/);
    }
    const dauer = (Date.now() - t0) / 1000;
    console.log(`[docker] Anlage bis Einladung: ${dauer.toFixed(1)} s`);
    // Wiederholbar: zweiter Lauf legt nichts doppelt an
    expect((await b.schritt('container_starten', a)).meldung).toMatch(/vorhanden/);

    const c = await engine.containerInfo(`kern-${id}`);
    expect(c.HostConfig).toMatchObject({ NanoCpus: 1e9, Memory: 768 * 1024 ** 2, MemorySwap: 768 * 1024 ** 2, MemoryReservation: 256 * 1024 ** 2, PidsLimit: 256, ReadonlyRootfs: true, CapDrop: ['ALL'], SecurityOpt: ['no-new-privileges:true'] });
    expect(c.Config.Labels).toMatchObject({ 'kern.instanz': id, 'kern.paket': 'klein', 'kern.subdomain': a.subdomain });
    const n = await engine.netzInfo(`kn-${id}`);
    expect(n.Internal).toBe(true);
    expect(c.NetworkSettings.Networks[`kn-${id}`]?.IPAddress).toMatch(/^10\.239\.\d+\.\d+$/);
    expect(Object.keys(c.NetworkSettings.Networks)).toEqual([`kn-${id}`]); // nur das interne Netz
    // kein Weg nach draußen aus dem Container
    const raus = await engine.exec(`kern-${id}`, ['node', '-e', "require('net').connect({host:'1.1.1.1',port:443,timeout:3000}).on('connect',()=>{console.log('OFFEN');process.exit(0)}).on('error',()=>process.exit(2)).on('timeout',()=>process.exit(3))"]);
    expect(raus.stdout).not.toContain('OFFEN');

    // Erster Admin: zweite Einladung mit derselben Mail liefert kein neues Passwort
    expect((await b.schritt('admin_einladen', a)).einladung).toBeUndefined();
    const s = await b.status(id);
    expect(s).toMatchObject({ health: 'ok', modus: 'normal', benutzer: 1 });
    expect(s.speicher_bytes).toBeGreaterThan(0);
    expect(Object.keys(s).sort()).toEqual(['backup_letztes', 'backup_ok', 'benutzer', 'health', 'ki_kontingent_cent_monat', 'ki_verbrauch_cent_monat', 'letzte_anmeldung_tag', 'modus', 'speicher_bytes', 'version', 'zugaenge_oauth'].sort());
    await b.modus(id, 'nur_lesen');
    expect((await b.status(id)).modus).toBe('nur_lesen');
    await b.grenzen(id, { nutzer_max: 5, speicher_max_bytes: 5 * 1024 ** 3, upload_max_bytes: 50 * 1024 ** 2, ki_kontingent_cent_monat: null, ki_tagesdeckel_cent: null });
    await b.paketGrenzen(id, 'betrieb');
    expect((await engine.containerInfo(`kern-${id}`)).HostConfig.NanoCpus).toBe(1.5e9);
    // Export (server d80276e): wartet und liefert Größe und Prüfsumme; Passphrase des Umzugspakets nur in dieser Antwort
    const ex = await b.client(id).exportVoll('umzugspaket');
    expect(ex.bytes).toBeGreaterThan(0);
    expect(ex.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(ex.passphrase?.length ?? 0).toBeGreaterThanOrEqual(12);
    // nur der Hash des Betriebs-Tokens steht in der Umgebung des Containers
    const env = (await engine.containerInfo(`kern-${id}`)).Config.Env ?? [];
    expect(env.some((e) => e.startsWith('KERN_BETRIEB_TOKEN='))).toBe(false);
    expect(env.some((e) => /^KERN_BETRIEB_TOKEN_SHA256=[a-f0-9]{64}$/.test(e))).toBe(true);

    const weg = await b.loeschen(id);
    expect(weg).toEqual(['Container', 'Netz', 'Datenvolume', 'Exportvolume', 'Sitzungsschlüssel und Tokens']);
    expect(await engine.containerInfoOpt(`kern-${id}`)).toBeNull();
    expect(await engine.netzInfoOpt(`kn-${id}`)).toBeNull();
    expect(await engine.volumeInfoOpt(`kern-${id}-daten`)).toBeNull();
    expect(await b.loeschen(id)).toEqual(['nichts mehr vorhanden']);
  }, 240_000);

  it('fasst fremde Container nicht an (falsches Label)', async () => {
    const b = bauen();
    const id = testId();
    angelegt.push(id);
    await engine.containerAnlegen(`kern-${id}`, { Image: BILD, Labels: { 'kern.instanz': 'i_fremdfremd' }, Cmd: ['true'] });
    await expect(b.loeschen(id)).rejects.toThrow(/fremdes Label/);
    await engine.containerEntfernen(`kern-${id}`);
  }, 60_000);

  it('Leitstand mit Docker-Bereitsteller: Anlage, Einmal-Zugang per Mail, Stufenwechsel auf zweiten Host mit gleicher Prüfsumme, Löschbeleg', async () => {
    const db = oeffneDb(':memory:');
    const g = new Geheimnisse(db, Geheimnisse.zufall());
    let ziel: DockerBereitsteller | null = null;
    const quelle = bauen(db, { geheimnisse: g, ziel: () => ziel });
    ziel = bauen(db, { geheimnisse: g, praefix: 'kernz', bruecke: 'kz', netzPool: '10.238', hostId: 'geteilt-02' });
    const l = new Leitstand({ db, bereitsteller: quelle, domain: 'kern.example', geteilteHosts: [{ id: 'geteilt-01', name: 'A', region: 'de-nbg', aktiv: true, kapazitaet: { container_max: 10, ram_mb: 16384, speicher_bytes: 500 * 1024 ** 3 } }] });
    const k = l.kundeAnlegen({ firma: 'Tischlerei P2', ansprechpartner: 'Anke', mail: 'anke@tischlerei-p2.example', typ: 'direkt', rechnungsweg: 'rechnung' }, 'till');
    const { instanz, vorgang } = await l.instanzAnlegen({ kunde_id: k.id, herkunft: { art: 'manuell' }, paket: 'klein', zahlung: 'rechnung' }, 'till');
    angelegt.push(instanz.id);
    expect(vorgang.status, JSON.stringify(vorgang.schritte)).toBe('fertig');
    expect(JSON.stringify(vorgang)).not.toMatch(/einmalPasswort/);
    const post = db.prepare("SELECT betreff, text FROM postausgang WHERE schluessel LIKE 'geheim:einladung:%'").all() as { betreff: string; text: string }[];
    expect(post).toHaveLength(1);
    expect(post[0]!.text).toMatch(/Einmal-Passwort: \S{12,}/);
    expect(l.instanz(instanz.id).betrieb.benutzer).toBe(1);

    l.hostAnlegen({ id: 'geteilt-02', name: 'B', region: 'de-nbg', aktiv: true, kapazitaet: { container_max: 10, ram_mb: 16384, speicher_bytes: 500 * 1024 ** 3 } }, 'till');
    l.hostAendern('geteilt-01', { aktiv: false }, 'till'); // damit der Wechsel auf geteilt-02 geht
    // Stufenwechsel geteilt → geteilt gibt es im Leitstand nicht; wir prüfen den Ablauf direkt am Bereitsteller
    const w = { id: instanz.id, subdomain: instanz.subdomain, paket: 'klein' as const, region: 'de-nbg' as const, von: { stufe: 'geteilt' as const, host: 'geteilt-01' }, nach: { stufe: 'geteilt' as const, host: 'geteilt-02' } };
    const erg: Record<string, unknown> = {};
    for (const s of quelle.wechselSchritte) erg[s] = await quelle.wechselSchritt(s, w);
    const pr = (erg.pruefen as { ergebnis: { alt: string; neu: string } }).ergebnis;
    expect(pr.alt).toMatch(/^[a-f0-9]{64}$/);
    expect(pr.neu).toBe(pr.alt);
    expect((await engine.containerInfo(`kern-${instanz.id}`)).State.Running).toBe(false);
    expect((await ziel.status(instanz.id)).benutzer).toBe(1); // Admin zog mit um
    await quelle.altLoeschen(instanz.id, 'geteilt-01');
    expect(await engine.containerInfoOpt(`kern-${instanz.id}`)).toBeNull();
    expect(g.hole(instanz.id)).not.toBeNull(); // Geheimnisse gehören der laufenden Instanz
    expect((await ziel.loeschen(instanz.id))).toContain('Datenvolume');
  }, 300_000);
});
