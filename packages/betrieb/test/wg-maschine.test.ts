/**
 * Stufenwechsel Geteilt → Eigene Maschine von Anfang bis Ende, mit echtem dockerd, echtem WireGuard (wireguard-go,
 * Userspace) und einer Attrappe der Hetzner Cloud API.
 *
 * Aufbau: Der Testprozess ist der Leitstand (Schnittstelle p2wgl, 10.99.0.1). Die „Maschine“ ist ein Netz-Namensraum
 * p2masch, verbunden über ein veth-Paar (198.51.100.1 ↔ 198.51.100.2, steht für das Internet). Wenn die Attrappe den
 * Server anlegt, liest der Test das erzeugte cloud-init (deploy/cloud-init/geteilt.yaml mit eingesetzten Werten) und
 * richtet die Maschine genau damit ein: wg0.conf, eingang.nft (nur 51820/udp von außen) und den socat-Dienst, der die
 * Docker Engine nur auf der Tunneladresse für den Leitstand anbietet. Die Docker Engine dahinter ist derselbe lokale
 * dockerd (anderes Namenspräfix „kernm“); der Weg dorthin geht aber nur durch den Tunnel.
 *
 * Es werden nur eigene Namensräume, Schnittstellen (p2…), Prozesse (eigene PIDs) und Container mit den hier erzeugten
 * IDs angelegt und wieder entfernt.
 */
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import YAML from 'yaml';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DockerEngine } from '../src/docker/engine.js';
import { DockerBereitsteller } from '../src/bereitsteller/docker.js';
import { HetznerBereitsteller } from '../src/bereitsteller/hetzner.js';
import { VerbundBereitsteller } from '../src/bereitsteller/verbund.js';
import { HetznerApi } from '../src/hetzner/api.js';
import { Geheimnisse } from '../src/geheimnisse.js';
import { oeffneDb } from '../src/db.js';
import { Leitstand } from '../src/leitstand.js';
import { WgBefehl, wgSchluessel } from '../src/wireguard.js';
import { HetznerAttrappe } from './attrappen.js';

const BILD = process.env.KERN_TEST_BILD ?? 'kern:p2';
const hat = (b: string) => { try { execFileSync('sh', ['-c', `command -v ${b}`], { stdio: 'ignore' }); return true; } catch { return false; } };
const engine = new DockerEngine();
const da = process.getuid?.() === 0 && ['wg', 'wireguard-go', 'socat', 'nft', 'ip'].every(hat) && fs.existsSync('/dev/net/tun')
  && (await engine.ping().then(() => engine.bild(BILD)).then(() => true).catch(() => false));

const NS = 'p2masch', WGL = 'p2wgl', WGM = 'p2wgm', V0 = 'p2veth0', V1 = 'p2veth1';
const prozesse: ChildProcess[] = [];
const ids: string[] = [];
const sh = (args: string[]) => execFileSync(args[0]!, args.slice(1), { stdio: ['ignore', 'pipe', 'pipe'] }).toString();
const imNs = (args: string[]) => sh(['ip', 'netns', 'exec', NS, ...args]);
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'p2wg-'));
const warte = (ms: number) => new Promise((r) => setTimeout(r, ms));

function aufraeumen() {
  for (const p of prozesse) if (p.pid && p.exitCode === null) { try { process.kill(p.pid, 'SIGTERM'); } catch { /* weg */ } }
  for (const c of [['ip', 'link', 'del', V0], ['ip', 'link', 'del', WGL], ['ip', 'netns', 'del', NS]]) { try { sh(c); } catch { /* nicht da */ } }
}

/** Richtet die Maschine aus dem cloud-init ein, wie es cloud-init und systemd auf dem Server täten. */
function maschineAusCloudInit(userData: string) {
  const doc = YAML.parse(userData) as { write_files: { path: string; content: string }[]; runcmd: string[] };
  const datei = (p: string) => { const f = doc.write_files.find((x) => x.path === p); if (!f) throw new Error(`cloud-init ohne ${p}`); return f.content; };
  const wg0 = datei('/etc/wireguard/wg0.conf');
  const adresse = /Address = (\S+)/.exec(wg0)![1]!;
  fs.writeFileSync(path.join(tmp, 'wg0.conf'), wg0.replace(/^Address.*$/m, ''), { mode: 0o600 }); // wie `wg-quick strip`
  const p = spawn('ip', ['netns', 'exec', NS, 'wireguard-go', WGM], { env: { ...process.env, WG_PROCESS_FOREGROUND: '1' }, stdio: 'ignore' });
  prozesse.push(p);
  for (let i = 0; i < 50; i++) { try { imNs(['ip', 'link', 'show', WGM]); break; } catch { execFileSync('sleep', ['0.1']); } }
  imNs(['wg', 'setconf', WGM, path.join(tmp, 'wg0.conf')]);
  imNs(['ip', 'addr', 'add', adresse, 'dev', WGM]);
  imNs(['ip', 'link', 'set', WGM, 'up']);
  // Firewall der Maschine genau aus dem cloud-init (Schnittstellenname wg0 → p2wgm)
  fs.writeFileSync(path.join(tmp, 'eingang.nft'), datei('/etc/kern/eingang.nft').replace(/"wg0"/g, `"${WGM}"`));
  imNs(['nft', '-f', path.join(tmp, 'eingang.nft')]);
  expect(doc.runcmd).toContain('systemctl enable --now kern-eingang.service');
  expect(doc.runcmd).toContain('systemctl enable --now wg-quick@wg0');
  // Docker Engine nur auf der Tunneladresse: ExecStart der Unit unverändert ausführen
  const exec = /ExecStart=(.*)/.exec(datei('/etc/systemd/system/kern-wg-docker.service'))![1]!.split(' ');
  prozesse.push(spawn('ip', ['netns', 'exec', NS, ...exec], { stdio: 'ignore' }));
  return { adresse: adresse.split('/')[0]!, doc };
}

beforeAll(() => {
  if (!da) return;
  aufraeumen();
  sh(['ip', 'netns', 'add', NS]);
  sh(['ip', 'link', 'add', V0, 'type', 'veth', 'peer', 'name', V1]);
  sh(['ip', 'link', 'set', V1, 'netns', NS]);
  sh(['ip', 'addr', 'add', '198.51.100.1/30', 'dev', V0]); sh(['ip', 'link', 'set', V0, 'up']);
  imNs(['ip', 'addr', 'add', '198.51.100.2/30', 'dev', V1]); imNs(['ip', 'link', 'set', V1, 'up']); imNs(['ip', 'link', 'set', 'lo', 'up']);
});
afterAll(async () => {
  if (!da) return;
  for (const id of ids) for (const pr of ['kern', 'kernm']) {
    await engine.containerEntfernen(`${pr}-${id}`).catch(() => undefined);
    await engine.containerEntfernen(`${pr}-${id}-ablage`).catch(() => undefined);
    await engine.netzEntfernen(`${pr === 'kern' ? 'kn' : 'kernmn'}-${id}`).catch(() => undefined);
    for (const v of ['daten', 'export']) await engine.volumeEntfernen(`${pr}-${id}-${v}`).catch(() => undefined);
  }
  aufraeumen();
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe.skipIf(!da)(`Geteilt → Eigene Maschine über WireGuard (${BILD}, wireguard-go, Hetzner-Attrappe)`, () => {
  it('ein Klick: Server, Tunnel, Paket verschlüsselt mit Prüfsumme an beiden Seiten, Import, Prüfbericht, Umschalten, alte Instanz 7 Tage', async () => {
    // Leitstand-Seite des Tunnels
    const lk = wgSchluessel();
    fs.writeFileSync(path.join(tmp, 'leitstand.key'), lk.privat, { mode: 0o600 });
    prozesse.push(spawn('wireguard-go', [WGL], { env: { ...process.env, WG_PROCESS_FOREGROUND: '1' }, stdio: 'ignore' }));
    for (let i = 0; i < 50; i++) { try { sh(['ip', 'link', 'show', WGL]); break; } catch { await warte(100); } }
    sh(['wg', 'set', WGL, 'private-key', path.join(tmp, 'leitstand.key')]);
    sh(['ip', 'addr', 'add', '10.99.0.1/16', 'dev', WGL]); sh(['ip', 'link', 'set', WGL, 'up']);

    const db = oeffneDb(':memory:');
    const g = new Geheimnisse(db, Geheimnisse.zufall());
    const h = new HetznerAttrappe();
    h.naechsteIp = () => '198.51.100.2';
    let maschine: { adresse: string } | null = null;
    h.nachAnlegen = (s) => { maschine = maschineAusCloudInit(s.user_data); };
    const geteilt = new DockerBereitsteller({ engine, bild: BILD, domain: 'kunden.kern.example', geheimnisse: g, egress: null, caddy: null, egressContainer: null, netzPool: '10.239', healthSek: 90, zusatzEnv: { KERN_PROVIDER: 'mock' }, hostId: 'geteilt-01' });
    const hz: HetznerBereitsteller = new HetznerBereitsteller({
      api: new HetznerApi('test-token', h.fetch), db, domain: 'kunden.kern.example', zone: 'kern.example', geheimnisse: g, leitstandUrl: 'https://leitstand.example', sshKeys: ['hd-betrieb'], kernImage: BILD, repo: { url: 'https://git.example/kern.git', ref: 'main' },
      wg: { oeffentlich: lk.oeffentlich, steuerung: new WgBefehl(WGL) },
      schlafen: async (ms) => {
        await warte(Math.min(ms, 300));
        for (const s of h.server.values()) { const t = /Bearer ([A-Za-z0-9_-]{20,})/.exec(s.user_data)?.[1]; if (t) hz.rueckruf(s.labels['kern-instanz']!, t, { ipv4: s.public_net.ipv4.ip, einrichtung: 'ok' }); }
      },
      rueckrufMinuten: 2, engineMinuten: 1,
      maschineOptionen: { praefix: 'kernm', bruecke: 'km', netzPool: '10.238', egress: null, caddy: null, egressContainer: null, zusatzEnv: { KERN_PROVIDER: 'mock' }, healthSek: 90 },
    });
    const v = new VerbundBereitsteller({ 'geteilt-01': geteilt }, hz);
    const uhr = { t: Date.now() };
    const l = new Leitstand({ db, bereitsteller: v, jetzt: () => new Date(uhr.t), domain: 'kunden.kern.example', geteilteHosts: [{ id: 'geteilt-01', name: 'A', region: 'de-nbg', aktiv: true, kapazitaet: { container_max: 10, ram_mb: 16384, speicher_bytes: 500 * 1024 ** 3 } }] });
    v.hostVon = (id) => l.instanz(id).host;
    hz.o.zahlungBestaetigt = (id) => ['rechnung', 'mollie'].includes(l.instanz(id).zahlung);

    const k = l.kundeAnlegen({ firma: 'Zimmerei Wechsel', ansprechpartner: 'Jördis', mail: 'j@zimmerei-wechsel.example', typ: 'direkt', rechnungsweg: 'rechnung' }, 'till');
    const { instanz, vorgang } = await l.instanzAnlegen({ kunde_id: k.id, herkunft: { art: 'manuell' }, paket: 'klein', zahlung: 'rechnung' }, 'till');
    ids.push(instanz.id);
    expect(vorgang.status, JSON.stringify(vorgang.schritte)).toBe('fertig');
    await geteilt.beispiel(instanz.id, 'laden', null); // echte Inhalte, damit das Paket etwas trägt
    const vorher = await geteilt.status(instanz.id);

    const t0 = Date.now();
    const r = await l.stufeWechseln(instanz.id, 'eigen', 'till');
    const dauer = (Date.now() - t0) / 1000;
    console.log(`[wg] Stufenwechsel Geteilt → Eigene Maschine: ${dauer.toFixed(1)} s`);
    if (r.vorgang.status !== 'fertig' && process.env.P2_DIAG) { for (const c of [['wg', 'show', WGL], ['ip', 'netns', 'exec', NS, 'wg', 'show', WGM], ['ip', 'netns', 'exec', NS, 'ip', '-br', 'addr'], ['ip', 'netns', 'exec', NS, 'ss', '-ltnp'], ['ip', 'netns', 'exec', NS, 'nft', 'list', 'ruleset']]) { try { console.log(c.join(' '), '\n', sh(c)); } catch (e) { console.log(c.join(' '), String(e)); } } }
    expect(r.vorgang.status, JSON.stringify(r.vorgang.schritte, null, 1)).toBe('fertig');
    const s = (n: string) => r.vorgang.schritte.find((x) => x.name === n)!;
    expect(s('ziel_bereitstellen').meldung).toMatch(/Tunnel steht \(10\.99\.\d+\.\d+\), Docker Engine erreichbar/);
    expect(s('uebertragen').meldung).toMatch(/Prüfsumme am Ziel gleich/);
    expect(s('einspielen').meldung).toMatch(/gesund.*Passphrase am Ziel gelöscht/);
    expect(s('pruefen').meldung).toMatch(/Prüfbericht bestanden|Prüfsumme gleich/);
    expect(r.instanz).toMatchObject({ stufe: 'eigen', host: `m-${instanz.id.slice(2)}`, status: 'aktiv' });

    // Tunnel: Peer gesetzt, Handshake erfolgt, Docker der Maschine nur über die Tunneladresse
    expect(sh(['wg', 'show', WGL, 'peers']).trim()).toHaveLength(44);
    expect(sh(['wg', 'show', WGL, 'latest-handshakes'])).toMatch(/\t[1-9]\d+\n?$/);
    const offen = (host: string, port: number) => new Promise<boolean>((ok) => { const c = net.connect({ host, port, timeout: 1500 }); c.on('connect', () => { c.destroy(); ok(true); }).on('error', () => ok(false)).on('timeout', () => { c.destroy(); ok(false); }); });
    expect(await offen(maschine!.adresse, 2375)).toBe(true);
    expect(await offen('198.51.100.2', 2375)).toBe(false); // öffentlich nichts außer 51820/udp
    expect(await offen('198.51.100.2', 22)).toBe(false);

    // Daten sind am Ziel: gleiche Benutzerzahl, Instanz antwortet über den Tunnel
    const nachher = await l.aktualisiereBetrieb(instanz.id);
    expect(nachher.betrieb.benutzer).toBe(vorher.benutzer);
    expect(nachher.betrieb.health).toBe('ok');
    expect((await engine.containerInfo(`kernm-${instanz.id}`)).Config.Env?.some((e) => e.startsWith('KERN_IMPORT_PAKET=/daten-export/'))).toBe(true);
    // Passphrase und Paket am Ziel gelöscht
    const ls = await engine.exec(`kernm-${instanz.id}`, ['ls', '-A', '/daten-export']);
    expect(ls.stdout).not.toMatch(/import-passphrase|umzug-/);

    // DNS zeigt auf die Maschine; alte Instanz angehalten, nach 7 Tagen gelöscht
    expect(h.dns.get(`${instanz.subdomain}.kunden/A`)).toEqual(['198.51.100.2']);
    expect((await engine.containerInfo(`kern-${instanz.id}`)).State.Running).toBe(false);
    expect(l.rueckfaelle()).toEqual([{ instanz_id: instanz.id, host: 'geteilt-01', loeschen_am: expect.any(String) }]);
    const tage = (Date.parse(l.rueckfaelle()[0]!.loeschen_am) - Date.now()) / 86_400_000;
    expect(Math.round(tage)).toBe(7);
    // Nach 8 Tagen löscht der Planer die alte Instanz auf dem geteilten Host; die neue läuft weiter
    uhr.t += 8 * 86_400_000;
    await l.planer();
    expect(await engine.containerInfoOpt(`kern-${instanz.id}`)).toBeNull();
    expect(await engine.volumeInfoOpt(`kern-${instanz.id}-daten`)).toBeNull();
    expect((await engine.containerInfo(`kernm-${instanz.id}`)).State.Running).toBe(true);
    expect(l.rueckfaelle()).toEqual([]);
    expect(l.ereignisse({ instanz_id: instanz.id }).some((e) => e.was === 'rueckfall_geloescht')).toBe(true);
    // Kein Klartext-Geheimnis im Vorgang
    expect(JSON.stringify(r.vorgang)).not.toMatch(/PrivateKey|passphrase":"|BEGIN/);
  }, 600_000);
});
