/**
 * WireGuard-Weg vom Leitstand zu jeder eigenen Maschine (O1 6.1: SSH und Verwaltung nur über WireGuard).
 *  - Schlüssel erzeugt der Leitstand (X25519, Format wie `wg genkey`/`wg pubkey`: 32 Byte roh, base64).
 *  - Netz 10.99.0.0/16 (wie D2s cloud-init: sshd ListenAddress im Tunnel), Leitstand 10.99.0.1, Maschinen ab 10.99.1.1.
 *  - Auf der Maschine ist von außen nur 51820/udp offen (Hetzner-Firewall und nftables, deploy/cloud-init/geteilt.yaml).
 *    Über den Tunnel erreicht der Leitstand die Docker Engine (10.99.x.y:2375) und die Egress-Verwaltung (:3129);
 *    beides lauscht nur auf der Tunneladresse. WireGuard sorgt für Verschlüsselung und gegenseitige Authentisierung.
 * Der private Schlüssel der Maschine steht nur im cloud-init der Maschine; der Leitstand behält den öffentlichen.
 */
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { DB } from './db.js';

const exec = promisify(execFile);
export const WG_NETZ = { praefix: '10.99', leitstand: '10.99.0.1', port: 51820 } as const;

export function wgSchluessel(): { privat: string; oeffentlich: string } {
  const k = crypto.generateKeyPairSync('x25519');
  const j = k.privateKey.export({ format: 'jwk' }) as { d: string; x: string };
  return { privat: Buffer.from(j.d, 'base64url').toString('base64'), oeffentlich: Buffer.from(j.x, 'base64url').toString('base64') };
}
const SCHLUESSEL = /^[A-Za-z0-9+/]{42}[AEIMQUYcgkosw048]=$/;
export const istWgSchluessel = (s: string) => SCHLUESSEL.test(s);
export const istTunnelIp = (ip: string) => /^10\.99\.(\d{1,3})\.(\d{1,3})$/.test(ip) && ip.split('.').every((x) => Number(x) <= 255);

/** wg-quick-Datei der Maschine: lauscht auf 51820, einziger Peer ist der Leitstand. */
export function wgQuickMaschine(e: { privat: string; adresse: string; leitstandPub: string; leitstandIp?: string }): string {
  if (!istWgSchluessel(e.privat) || !istWgSchluessel(e.leitstandPub) || !istTunnelIp(e.adresse)) throw new Error('WireGuard-Werte ungültig');
  return `[Interface]\nPrivateKey = ${e.privat}\nAddress = ${e.adresse}/16\nListenPort = ${WG_NETZ.port}\n\n[Peer]\n# Leitstand\nPublicKey = ${e.leitstandPub}\nAllowedIPs = ${e.leitstandIp ?? WG_NETZ.leitstand}/32\n`;
}

/** Steuerung der WireGuard-Schnittstelle auf dem Leitstand. */
export interface WgSteuerung {
  peerSetzen(p: { oeffentlich: string; endpunkt: string; tunnelIp: string }): Promise<void>;
  peerEntfernen(oeffentlich: string): Promise<void>;
}

/** Setzt Peers mit `wg set` (wireguard-tools); ohne Shell, Werte vorher geprüft. */
export class WgBefehl implements WgSteuerung {
  constructor(private schnittstelle: string, private wg = 'wg') { if (!/^[a-z0-9_-]{1,15}$/i.test(schnittstelle)) throw new Error('Schnittstellenname ungültig'); }
  async peerSetzen(p: { oeffentlich: string; endpunkt: string; tunnelIp: string }) {
    if (!istWgSchluessel(p.oeffentlich) || !istTunnelIp(p.tunnelIp) || !/^\d{1,3}(\.\d{1,3}){3}:\d{2,5}$/.test(p.endpunkt)) throw new Error('Peer-Werte ungültig');
    await exec(this.wg, ['set', this.schnittstelle, 'peer', p.oeffentlich, 'endpoint', p.endpunkt, 'allowed-ips', `${p.tunnelIp}/32`, 'persistent-keepalive', '25']);
  }
  async peerEntfernen(oeffentlich: string) {
    if (!istWgSchluessel(oeffentlich)) throw new Error('Schlüssel ungültig');
    await exec(this.wg, ['set', this.schnittstelle, 'peer', oeffentlich, 'remove']);
  }
}

/** Vergibt Tunneladressen je Instanz (nur öffentlicher Schlüssel im Leitstand). */
export class WgNetz {
  constructor(private db: DB) {
    db.exec('CREATE TABLE IF NOT EXISTS wg_peers (instanz_id TEXT PRIMARY KEY, ip TEXT NOT NULL UNIQUE, oeffentlich TEXT NOT NULL, endpunkt TEXT)');
  }
  hole(id: string): { ip: string; oeffentlich: string; endpunkt: string | null } | null {
    return (this.db.prepare('SELECT ip, oeffentlich, endpunkt FROM wg_peers WHERE instanz_id = ?').get(id) as { ip: string; oeffentlich: string; endpunkt: string | null } | undefined) ?? null;
  }
  /** Neue Adresse und neues Schlüsselpaar; der private Schlüssel wird nur zurückgegeben, nicht gespeichert. */
  vergeben(id: string): { ip: string; privat: string; oeffentlich: string } {
    const belegt = new Set((this.db.prepare('SELECT ip FROM wg_peers').all() as { ip: string }[]).map((r) => r.ip));
    let ip = '';
    for (let n = 256; n < 65_000 && !ip; n++) { const k = `${WG_NETZ.praefix}.${Math.floor(n / 254)}.${(n % 254) + 1}`; if (!belegt.has(k)) ip = k; }
    if (!ip) throw new Error('WireGuard-Netz voll');
    const s = wgSchluessel();
    this.db.prepare('INSERT INTO wg_peers (instanz_id, ip, oeffentlich) VALUES (?, ?, ?) ON CONFLICT(instanz_id) DO UPDATE SET oeffentlich = excluded.oeffentlich').run(id, ip, s.oeffentlich);
    return { ip: this.hole(id)!.ip, ...s };
  }
  endpunkt(id: string, endpunkt: string) { this.db.prepare('UPDATE wg_peers SET endpunkt = ? WHERE instanz_id = ?').run(endpunkt, id); }
  freigeben(id: string) { this.db.prepare('DELETE FROM wg_peers WHERE instanz_id = ?').run(id); }
}
