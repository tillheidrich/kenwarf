/**
 * Bereitsteller „hetzner“ gegen eine Attrappe der Hetzner Cloud API (Antwortformen aus der OpenAPI-Beschreibung).
 * Keine echten Aufrufe. Der Weg durch den Tunnel bis in den Container ist in test/wg-maschine.test.ts mit echtem
 * WireGuard und dockerd geprüft; hier nur Server, cloud-init, V-1, Rückruf, Aufräumen, Wartung.
 */
import fs from 'node:fs';
import YAML from 'yaml';
import { describe, expect, it } from 'vitest';
import { HetznerApi } from '../src/hetzner/api.js';
import { HetznerBereitsteller, cloudInitFuellen, vorlagePfad } from '../src/bereitsteller/hetzner.js';
import { DockerEngine } from '../src/docker/engine.js';
import { Geheimnisse, sha256 } from '../src/geheimnisse.js';
import { oeffneDb } from '../src/db.js';
import { wgSchluessel, type WgSteuerung } from '../src/wireguard.js';
import { HetznerAttrappe } from './attrappen.js';

function aufbau(opt: { rueckruf?: boolean; zahlung?: boolean; engineOk?: boolean } = {}) {
  const h = new HetznerAttrappe();
  const db = oeffneDb(':memory:');
  const g = new Geheimnisse(db, Geheimnisse.zufall());
  let uhr = Date.parse('2026-10-24T10:00:00Z');
  h.jetzt = () => new Date(uhr).toISOString();
  const peers: string[] = [];
  const steuerung: WgSteuerung = { peerSetzen: async (p) => { peers.push(`${p.oeffentlich}@${p.endpunkt}=${p.tunnelIp}`); }, peerEntfernen: async (k) => { const i = peers.findIndex((p) => p.startsWith(k)); if (i >= 0) peers.splice(i, 1); } };
  const lk = wgSchluessel();
  const b: HetznerBereitsteller = new HetznerBereitsteller({
    api: new HetznerApi('test-token', h.fetch), db, domain: 'kunden.kern.example', zone: 'kern.example', geheimnisse: g, leitstandUrl: 'https://leitstand.example', sshKeys: ['hd-betrieb'],
    kernImage: 'ghcr.io/example/kern@sha256:' + 'c'.repeat(64), wg: { oeffentlich: lk.oeffentlich, steuerung },
    zahlungBestaetigt: () => opt.zahlung !== false, jetzt: () => uhr,
    engineFuer: () => ({ ping: async () => { if (opt.engineOk === false) throw new Error('weg'); return 'OK'; } }) as unknown as DockerEngine,
    schlafen: async (ms) => {
      uhr += ms;
      if (opt.rueckruf === false) return;
      for (const s of h.server.values()) { const t = /Bearer ([A-Za-z0-9_-]{20,})/.exec(s.user_data)?.[1]; if (t) b.rueckruf(s.labels['kern-instanz']!, t, { ipv4: s.public_net.ipv4.ip }); }
    },
  });
  const a = { id: 'i_abcdefghij', subdomain: 'ahlers', paket: 'klein' as const, region: 'de-nbg' as const, stufe: 'eigen' as const };
  return { h, g, b, a, peers, lk, vor: (ms: number) => { uhr += ms; } };
}
const bisTunnel = async (b: HetznerBereitsteller, a: Parameters<HetznerBereitsteller['maschineSchritt']>[1]) => { const out: string[] = []; for (const s of ['server_anlegen', 'dns_setzen', 'warten_auf_rueckruf', 'tunnel_aufbauen']) out.push((await b.maschineSchritt(s, a)).meldung ?? ''); return out; };

describe('Hetzner Cloud API Client', () => {
  it('ohne Token keine Aufrufe', () => { expect(() => new HetznerApi('')).toThrow(/Token/); });
  it('user_data über 32 KiB wird vor dem Netz abgelehnt', async () => {
    const h = new HetznerAttrappe();
    await expect(new HetznerApi('test-token', h.fetch).serverAnlegen({ name: 'x', server_type: 'cx23', location: 'nbg1', image: 'ubuntu-24.04', ssh_keys: [], firewalls: [], user_data: 'x'.repeat(33 * 1024), labels: {} })).rejects.toThrow(/32 KiB/);
    expect(h.aufrufe).toHaveLength(0);
  });
  it('Docker ohne TLS nur auf Tunneladressen', () => {
    expect(() => new DockerEngine({ art: 'wg', host: '203.0.113.5' })).toThrow(/Tunneladresse/);
    expect(() => new DockerEngine({ art: 'wg', host: '10.99.1.3' })).not.toThrow();
  });
});

describe('cloud-init aus deploy/cloud-init/geteilt.yaml', () => {
  it('alle Platzhalter gefüllt, gültiges YAML, WireGuard, Firewall nur 51820/udp plus 80/443, Rückruf, unter 32 KiB', async () => {
    const { h, b, a, lk } = aufbau();
    await b.maschineSchritt('server_anlegen', a);
    const ud = [...h.server.values()][0]!.user_data;
    expect(Buffer.byteLength(ud)).toBeLessThan(32 * 1024);
    expect(ud).not.toMatch(/<[a-z0-9-]{2,40}>/);
    const doc = YAML.parse(ud) as { write_files: { path: string; content: string }[]; runcmd: string[]; packages: string[] };
    const f = (p: string) => doc.write_files.find((x) => x.path === p)!.content;
    expect(f('/etc/wireguard/wg0.conf')).toMatch(new RegExp(`PublicKey = ${lk.oeffentlich.replace(/[+/]/g, '\\$&')}\\nAllowedIPs = 10\\.99\\.0\\.1/32`));
    expect(f('/etc/wireguard/wg0.conf')).toMatch(/Address = 10\.99\.\d+\.\d+\/16\nListenPort = 51820/);
    expect(f('/etc/kern/eingang.nft')).toMatch(/policy drop/);
    expect(f('/etc/kern/eingang.nft')).toMatch(/iifname "wg0" ip saddr 10\.99\.0\.1 tcp dport \{ 22, 2375, 3129 \} accept/);
    expect(f('/etc/systemd/system/kern-wg-docker.service')).toMatch(/TCP4-LISTEN:2375,bind=10\.99\.\d+\.\d+,fork,reuseaddr,range=10\.99\.0\.1\/32/);
    expect(f('/etc/ssh/sshd_config.d/10-kern.conf')).toMatch(/ListenAddress 10\.99\./);
    expect(doc.packages).toEqual(expect.arrayContaining(['wireguard', 'socat', 'nftables']));
    expect(doc.runcmd.at(-1)).toBe('/usr/local/sbin/kern-rueckruf');
    // Firewall bei Hetzner: kein Port 22 von außen
    const fw = [...h.firewalls.values()][0]!;
    expect(JSON.stringify(fw.rules)).not.toMatch(/"port":"22"/);
    expect(JSON.stringify(fw.rules)).toMatch(/"protocol":"udp","port":"51820"/);
  });
  it('fehlende Werte oder Zeilenumbrüche: nichts wird verschickt', () => {
    const v = fs.readFileSync(vorlagePfad(), 'utf8');
    expect(() => cloudInitFuellen(v, {})).toThrow(/Platzhalter ohne Wert: .*wg-privat/);
    expect(() => cloudInitFuellen(v, { 'wg-privat': 'a\nb' })).toThrow(/unzulässige Zeichen/);
  });
});

describe('Bereitsteller hetzner (Eigene Maschine)', () => {
  it('Server mit Labels, V-1 Ausweichstandort, DNS, Rückruf mit Einmal-Token, Peer gesetzt, Engine im Tunnel erreicht', async () => {
    const { h, g, b, a, peers } = aufbau();
    h.ausverkauft.add('cx23@nbg1');
    const m = await bisTunnel(b, a);
    expect(m[0]).toMatch(/cx23@nbg1: laut API nicht verfügbar; cx23@hel1: angelegt/);
    const sv = [...h.server.values()][0]!;
    expect(sv.labels).toMatchObject({ 'kern-instanz': a.id, 'kern-status': 'bereitstellung' });
    expect(h.dns.get('ahlers.kunden/A')).toEqual([sv.public_net.ipv4.ip]);
    expect(g.hole(a.id)!.rueckruf_token_sha256).toBeUndefined();
    expect(g.hole(a.id)!.egress_admin).toMatch(/^[a-f0-9]{64}$/);
    expect(peers).toEqual([`${b.netz.hole(a.id)!.oeffentlich}@${sv.public_net.ipv4.ip}:51820=${b.netz.hole(a.id)!.ip}`]);
    expect(m[3]).toMatch(/Tunnel steht \(10\.99\.\d+\.\d+\), Docker Engine erreichbar/);
    expect(h.aufrufe.every((x) => x.auth === 'Bearer test-token')).toBe(true);
  });
  it('Rückruf: falsches oder zweites Token wird abgelehnt', () => {
    const { b, g } = aufbau();
    g.sichere('i_abcdefghij', { rueckruf_token_sha256: sha256('richtig') });
    expect(b.rueckruf('i_abcdefghij', 'falsch', {})).toBe(false);
    expect(b.rueckruf('i_abcdefghij', 'richtig', {})).toBe(true);
    expect(b.rueckruf('i_abcdefghij', 'richtig', {})).toBe(false);
  });
  it('kein Rückruf in 30 Minuten: Server, DNS und Peer gelöscht', async () => {
    const { h, b, a, peers } = aufbau({ rueckruf: false });
    await expect(bisTunnel(b, a)).rejects.toThrow(/Kein Rückruf nach 30 Minuten: Server gelöscht/);
    expect(h.server.size).toBe(0);
    expect(h.dns.size).toBe(0);
    expect(peers).toEqual([]);
    expect(b.netz.hole(a.id)).toBeNull();
  });
  it('Docker Engine im Tunnel nicht erreichbar: Fehler (Rückbau macht der Leitstand)', async () => {
    const { b, a } = aufbau({ engineOk: false });
    await expect(bisTunnel(b, a)).rejects.toThrow(/nicht erreichbar/);
  });
  it('V-1: nichts verfügbar → kein Server, ehrliche Meldung', async () => {
    const { h, b, a } = aufbau();
    for (const t of ['cx23', 'cx33', 'cpx22']) for (const o of ['nbg1', 'hel1', 'fsn1']) h.ausverkauft.add(`${t}@${o}`);
    await expect(b.maschineSchritt('server_anlegen', a)).rejects.toThrow(/Kein Servertyp verfügbar \(V-1\).*nichts wird berechnet/);
    expect(h.aufrufe.filter((x) => x.methode === 'POST' && x.pfad === '/servers')).toHaveLength(0);
  });
  it('ohne bestätigte Zahlung kein Hetzner-Server', async () => {
    const { h, b, a } = aufbau({ zahlung: false });
    await expect(b.maschineSchritt('server_anlegen', a)).rejects.toThrow(/Keine bestätigte Zahlung/);
    expect(h.aufrufe.filter((x) => x.methode === 'POST')).toHaveLength(0);
  });
  it('Wartung löscht verwaiste Server nach 30 Minuten; Löschen räumt Server, DNS und Peer', async () => {
    const { h, b, a, vor, peers } = aufbau();
    await bisTunnel(b, a);
    const r = await new HetznerApi('test-token', h.fetch).serverAnlegen({ name: 'kern-alt', server_type: 'cx23', location: 'nbg1', image: 'ubuntu-24.04', ssh_keys: [], firewalls: [], user_data: '#cloud-config', labels: { 'kern-instanz': 'i_verwaist01', 'kern-status': 'bereitstellung' } });
    expect(await b.wartung()).toEqual([]);
    vor(31 * 60_000);
    expect(await b.wartung()).toEqual([`verwaister Server ${r.server.id} (i_verwaist01) gelöscht, keine Bereitstellung nach 30 Minuten`]);
    expect(h.server.size).toBe(1);
    const weg = await b.aufraeumen(a.id);
    expect(weg).toEqual([expect.stringMatching(/^Server \d+$/), 'DNS-Einträge', 'WireGuard-Peer']);
    expect(h.server.size).toBe(0);
    expect(h.dns.size).toBe(0);
    expect(peers).toEqual([]);
  });
});
