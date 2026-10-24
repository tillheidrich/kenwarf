/**
 * Bereitsteller „hetzner“ für die Stufe „Eigene Maschine“ (O1 1.8.3, CONTRACT v1.4 3.1; G1 V-1, W-1 bis W-8).
 *
 * Ablauf je Instanz:
 *  1. Server über die Hetzner Cloud API, cloud-init aus deploy/cloud-init/geteilt.yaml (gleiche Härtung wie ein
 *     geteilter Host, nur ein Mandant) mit eingesetzten Werten: WireGuard-Schlüssel der Maschine (vom Leitstand erzeugt),
 *     Tunneladresse, Egress-Verwaltungstoken, LUKS-Schlüssel, Rückruf mit Einmal-Token. Firewall: nur 80/443, 443/udp
 *     und 51820/udp.
 *  2. DNS, Rückruf abwarten (spätestens 30 Minuten, sonst Server und DNS löschen), Peer auf dem Leitstand setzen,
 *     auf die Docker Engine der Maschine über den Tunnel warten.
 *  3. Ab dann ist die Maschine ein Docker-Host wie jeder geteilte: der innere Docker-Bereitsteller legt Volume, Netz
 *     und Container an (gleiche Grenzen, gleiche Härtung) und spricht /_betrieb/* per exec.
 *
 * Kosten entstehen erst in `server_anlegen`, nur für `stufe = eigen` und nur mit bestätigter Zahlung.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { HetznerApi, HetznerFehler, NICHT_VERFUEGBAR, type HServer } from '../hetzner/api.js';
import type { Geheimnisse } from '../geheimnisse.js';
import { sha256 } from '../geheimnisse.js';
import { DockerEngine } from '../docker/engine.js';
import { EgressVerwaltung } from '../docker/egress.js';
import { DockerBereitsteller, type DockerOptionen } from './docker.js';
import type { Auftrag, Bereitsteller, Grenzen, Modus, SchrittErgebnis, StatusAntwort, Wechselauftrag } from './typ.js';
import { WECHSEL_SCHRITTE, nurBetriebsdaten } from './typ.js';
import { WG_NETZ, WgNetz, type WgSteuerung } from '../wireguard.js';
import type { DB } from '../db.js';
import type { Beispiel, Paket, Region, Stufe } from '../typen.js';

export const HETZNER_SCHRITTE = ['subdomain_pruefen', 'schluessel_erzeugen', 'server_anlegen', 'dns_setzen', 'warten_auf_rueckruf', 'tunnel_aufbauen',
  'volume_anlegen', 'container_starten', 'healthz_warten', 'tls_pruefen', 'admin_einladen', 'beispiel_laden'] as const;
/** Schritte, die einen Server bis zur erreichbaren Docker Engine bringen (auch für den Stufenwechsel). */
export const MASCHINE_SCHRITTE = ['server_anlegen', 'dns_setzen', 'warten_auf_rueckruf', 'tunnel_aufbauen'] as const;

/** G1 V-1: andere Standorte (NBG1, HEL1, FSN1), dann nächstgrößerer Typ. Typen [Schätzung], im Leitstand änderbar. */
export const STANDORTE: Record<Region, string[]> = { 'de-nbg': ['nbg1', 'hel1', 'fsn1'], 'de-fsn': ['fsn1', 'nbg1', 'hel1'], 'fi-hel': ['hel1', 'nbg1', 'fsn1'] };
export const TYPEN: Record<Paket, string[]> = { klein: ['cx23', 'cx33', 'cpx22'], betrieb: ['cx33', 'cx43', 'cpx32'], team: ['cx43', 'cx53', 'cpx42'] };

export interface HetznerOptionen {
  api: HetznerApi;
  db: DB;
  domain: string;
  /** DNS-Zone in der Hetzner Cloud API; Eintragsname ist die Subdomain relativ dazu. */
  zone: string;
  geheimnisse: Geheimnisse;
  leitstandUrl: string;
  sshKeys: (string | number)[];
  /** WireGuard auf dem Leitstand: öffentlicher Schlüssel und Steuerung der Schnittstelle. */
  wg: { oeffentlich: string; steuerung: WgSteuerung; leitstandIp?: string };
  bild?: string;
  /** Kern-Image nach Digest (gleiches Image wie auf den geteilten Hosts). */
  kernImage: string;
  repo?: { url: string; ref: string };
  backupZiel?: string;
  typen?: Record<Paket, string[]>;
  standorte?: Record<Region, string[]>;
  zahlungBestaetigt?: (instanzId: string) => boolean;
  cloudInitVorlage?: string;
  rueckrufMinuten?: number;
  aufraeumenMinuten?: number;
  engineMinuten?: number;
  jetzt?: () => number;
  schlafen?: (ms: number) => Promise<void>;
  /** Öffentliche Prüfung von TLS und /healthz (Tests: Stub). */
  f?: typeof fetch;
  /** Wie der Leitstand die Docker Engine der Maschine erreicht (Standard: über den Tunnel, Port 2375). */
  engineFuer?: (tunnelIp: string) => DockerEngine;
  /** Zusatzoptionen des inneren Docker-Bereitstellers (Tests: anderes Präfix, kein Caddy/Egress). */
  maschineOptionen?: Partial<DockerOptionen>;
}

interface Stand { server_id?: number; ipv4?: string; ipv6?: string; angelegt?: number; rueckruf?: { am: number }; subdomain?: string }

export function vorlagePfad(name = 'geteilt.yaml'): string {
  return fileURLToPath(new URL(`../../../../deploy/cloud-init/${name}`, import.meta.url));
}

/**
 * Platzhalter `<…>` der Vorlage ersetzen. Bleibt einer übrig oder enthält ein Wert Zeilenumbrüche oder spitze Klammern,
 * wird nichts verschickt (ein halb gefülltes cloud-init wäre ein Server mit Beispielwerten).
 */
export function cloudInitFuellen(vorlage: string, werte: Record<string, string>): string {
  for (const [k, v] of Object.entries(werte)) if (/[\r\n<>'"\\]/.test(v)) throw new Error(`cloud-init-Wert ${k} enthält unzulässige Zeichen`);
  let t = vorlage;
  for (const [k, v] of Object.entries(werte)) t = t.split(`<${k}>`).join(v);
  const offen = [...new Set([...t.matchAll(/<([a-z0-9-]{2,40})>/g)].map((m) => m[1]))];
  if (offen.length) throw new Error(`cloud-init: Platzhalter ohne Wert: ${offen.join(', ')}`);
  return t;
}

export class HetznerBereitsteller implements Bereitsteller {
  readonly name = 'hetzner';
  readonly schritte = HETZNER_SCHRITTE;
  readonly wechselSchritte = WECHSEL_SCHRITTE;
  readonly stand = new Map<string, Stand>();
  readonly netz: WgNetz;
  private maschinen = new Map<string, DockerBereitsteller>();
  private uhr: () => number;
  private schlafen: (ms: number) => Promise<void>;
  constructor(readonly o: HetznerOptionen) {
    this.uhr = o.jetzt ?? Date.now;
    this.schlafen = o.schlafen ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.netz = new WgNetz(o.db);
  }
  schritteFuer(_s: Stufe) { return this.schritte; }

  private st(id: string): Stand { let s = this.stand.get(id); if (!s) { s = {}; this.stand.set(id, s); } return s; }

  /** Docker-Bereitsteller für die Maschine dieser Instanz, über den Tunnel. */
  maschine(id: string): DockerBereitsteller {
    const da = this.maschinen.get(id);
    if (da) return da;
    const p = this.netz.hole(id);
    if (!p) throw new Error('Kein Tunnel zu dieser Maschine');
    const g = this.o.geheimnisse.hole(id);
    const engine = this.o.engineFuer ? this.o.engineFuer(p.ip) : new DockerEngine({ art: 'wg', host: p.ip });
    const egressToken = g?.egress_admin;
    const d = new DockerBereitsteller({
      engine, bild: this.o.kernImage, domain: this.o.domain, geheimnisse: this.o.geheimnisse, hostId: `m-${id.slice(2)}`,
      egress: egressToken ? new EgressVerwaltung(`http://${p.ip}:3129`, egressToken) : null, caddy: 'kern-caddy', egressContainer: 'kern-egress', leitstandUrl: this.o.leitstandUrl,
      ...this.o.maschineOptionen,
    });
    this.maschinen.set(id, d);
    return d;
  }

  /** Rückruf aus cloud-init (POST /v1/rueckruf/:id). Token einmalig, nur als Hash gespeichert. */
  rueckruf(id: string, token: string, body: { ipv4?: string }): boolean {
    const g = this.o.geheimnisse.hole(id);
    if (!g?.rueckruf_token_sha256 || !token) return false;
    const a = Buffer.from(sha256(token)), b = Buffer.from(g.rueckruf_token_sha256);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return false;
    const { rueckruf_token_sha256: _weg, ...rest } = g;
    this.o.geheimnisse.setze(id, rest);
    const s = this.st(id);
    s.rueckruf = { am: this.uhr() };
    if (body.ipv4 && /^\d{1,3}(\.\d{1,3}){3}$/.test(body.ipv4) && !s.ipv4) s.ipv4 = body.ipv4;
    return true;
  }

  async serverAnlegen(a: Pick<Auftrag, 'id' | 'subdomain' | 'paket' | 'region'>, userData: string): Promise<{ server: HServer; versuche: string[] }> {
    const versuche: string[] = [];
    const typen = (this.o.typen ?? TYPEN)[a.paket], orte = (this.o.standorte ?? STANDORTE)[a.region];
    const fw = await this.o.api.firewallSichern('kern-eigene-maschine', { kern: 'eigene-maschine' });
    for (const typ of typen) for (const ort of orte) {
      const frei = await this.o.api.serverTypVerfuegbar(typ, ort).catch(() => null);
      if (frei === false) { versuche.push(`${typ}@${ort}: laut API nicht verfügbar`); continue; }
      try {
        const r = await this.o.api.serverAnlegen({ name: `kern-${a.subdomain}`, server_type: typ, location: ort, image: this.o.bild ?? 'ubuntu-24.04', ssh_keys: this.o.sshKeys, firewalls: [{ firewall: fw }], user_data: userData,
          labels: { 'kern-instanz': a.id, 'kern-status': 'bereitstellung', 'kern-paket': a.paket } });
        versuche.push(`${typ}@${ort}: angelegt`);
        return { server: r.server, versuche };
      } catch (e) {
        if (e instanceof HetznerFehler && NICHT_VERFUEGBAR.has(e.code)) { versuche.push(`${typ}@${ort}: ${e.code}`); continue; }
        if (e instanceof HetznerFehler && e.code === 'uniqueness_error') {
          const da = (await this.o.api.serverListe(`kern-instanz=${a.id}`))[0];
          if (da) { versuche.push(`${typ}@${ort}: schon vorhanden`); return { server: da, versuche }; }
        }
        throw e;
      }
    }
    throw new Error(`Kein Servertyp verfügbar (V-1), Kunde bleibt in „Geteilt“, nichts wird berechnet. Versucht: ${versuche.join('; ')}`);
  }

  /** Schritte bis zur erreichbaren Docker Engine; auch vom Verbund beim Stufenwechsel genutzt. */
  async maschineSchritt(name: string, a: Pick<Auftrag, 'id' | 'subdomain' | 'paket' | 'region' | 'stufe'>): Promise<SchrittErgebnis> {
    const api = this.o.api, s = this.st(a.id);
    s.subdomain = a.subdomain;
    switch (name) {
      case 'server_anlegen': {
        if (a.stufe !== 'eigen') throw new Error('Hetzner nur für „Eigene Maschine“');
        if (this.o.zahlungBestaetigt && !this.o.zahlungBestaetigt(a.id)) throw new Error('Keine bestätigte Zahlung: keine Hetzner-Kosten');
        const da = (await api.serverListe(`kern-instanz=${a.id}`))[0];
        if (da) { Object.assign(s, { server_id: da.id, ipv4: da.public_net.ipv4?.ip, ipv6: da.public_net.ipv6?.ip, angelegt: s.angelegt ?? Date.parse(da.created) }); return { meldung: `Server ${da.id} vorhanden` }; }
        const rueckrufToken = crypto.randomBytes(32).toString('base64url');
        const egressAdmin = crypto.randomBytes(32).toString('hex');
        this.o.geheimnisse.sichere(a.id, { rueckruf_token_sha256: sha256(rueckrufToken), egress_admin: egressAdmin });
        const wg = this.netz.vergeben(a.id);
        const userData = cloudInitFuellen(this.o.cloudInitVorlage ?? fs.readFileSync(vorlagePfad(), 'utf8'), {
          'managed-domain': this.o.domain, 'betriebs-mail': `betrieb@${this.o.domain}`, 'kern-image': this.o.kernImage,
          'leitstand-host': new URL(this.o.leitstandUrl).host, 'backup-ziel': this.o.backupZiel ?? '', 'host-id': `m-${a.id.slice(2)}`, token: crypto.randomBytes(24).toString('hex'),
          ref: this.o.repo?.ref ?? 'main', repo: this.o.repo?.url ?? 'https://example.invalid/kern.git',
          'wg-privat': wg.privat, 'wg-adresse': wg.ip, 'leitstand-wg-pub': this.o.wg.oeffentlich, 'leitstand-wg-ip': this.o.wg.leitstandIp ?? WG_NETZ.leitstand,
          'egress-admin-token': egressAdmin, 'luks-schluessel': crypto.randomBytes(48).toString('base64url'),
          'rueckruf-token': rueckrufToken, 'rueckruf-url': `${this.o.leitstandUrl}/v1/rueckruf/${a.id}`,
        });
        const { server, versuche } = await this.serverAnlegen(a, userData);
        Object.assign(s, { server_id: server.id, ipv4: server.public_net.ipv4?.ip, ipv6: server.public_net.ipv6?.ip, angelegt: this.uhr() });
        return { meldung: `Server ${server.id} (${server.server_type.name}) angelegt, Tunnel ${wg.ip}. ${versuche.join('; ')}` };
      }
      case 'dns_setzen': return { meldung: await this.dnsSetzen(a.id, a.subdomain) };
      case 'warten_auf_rueckruf': {
        const frist = (this.o.rueckrufMinuten ?? 30) * 60_000;
        while (!s.rueckruf) {
          if (this.uhr() - (s.angelegt ?? this.uhr()) > frist) {
            await this.aufraeumen(a.id, a.subdomain);
            throw new Error(`Kein Rückruf nach ${this.o.rueckrufMinuten ?? 30} Minuten: Server gelöscht`);
          }
          await this.schlafen(5000);
        }
        return { meldung: 'Rückruf erhalten' };
      }
      case 'tunnel_aufbauen': {
        const p = this.netz.hole(a.id);
        if (!p || !s.ipv4) throw new Error('Tunnel oder IPv4 fehlt');
        await this.o.wg.steuerung.peerSetzen({ oeffentlich: p.oeffentlich, endpunkt: `${s.ipv4}:${WG_NETZ.port}`, tunnelIp: p.ip });
        this.netz.endpunkt(a.id, `${s.ipv4}:${WG_NETZ.port}`);
        const bis = this.uhr() + (this.o.engineMinuten ?? 10) * 60_000;
        const eng = this.maschine(a.id).o.engine;
        for (;;) {
          const ok = await eng.ping().then(() => true).catch(() => false);
          if (ok) break;
          if (this.uhr() > bis) throw new Error('Docker Engine über den Tunnel nicht erreichbar');
          await this.schlafen(2000);
        }
        return { meldung: `Tunnel steht (${p.ip}), Docker Engine erreichbar` };
      }
      default: return {};
    }
  }

  async dnsSetzen(id: string, subdomain: string): Promise<string> {
    const s = this.st(id);
    if (!s.ipv4 && s.server_id) { const sv = await this.o.api.server(s.server_id); s.ipv4 = sv.public_net.ipv4?.ip; s.ipv6 = sv.public_net.ipv6?.ip; }
    if (!s.ipv4) throw new Error('Server hat noch keine IPv4');
    const rel = this.relativ(subdomain);
    await this.o.api.dnsSetzen(this.o.zone, rel, 'A', s.ipv4);
    if (s.ipv6) await this.o.api.dnsSetzen(this.o.zone, rel, 'AAAA', s.ipv6.replace(/\/\d+$/, '').replace(/::$/, '::1'));
    return `A${s.ipv6 ? '/AAAA' : ''} ${rel}.${this.o.zone} → ${s.ipv4}`;
  }

  async schritt(name: string, a: Auftrag): Promise<SchrittErgebnis> {
    switch (name) {
      case 'subdomain_pruefen': {
        const fremd = (await this.o.api.serverListe('kern-instanz')).filter((x) => x.name === `kern-${a.subdomain}` && x.labels['kern-instanz'] !== a.id);
        if (fremd.length) throw new Error('Servername schon vergeben');
        return {};
      }
      case 'schluessel_erzeugen':
        this.o.geheimnisse.sichere(a.id, { konto_token: a.konto_token });
        return { meldung: 'Schlüssel und Tokens erzeugt (verschlüsselt im Leitstand)' };
      case 'tls_pruefen': {
        const r = await (this.o.f ?? fetch)(`https://${a.subdomain}.${this.o.domain}/healthz`, { signal: AbortSignal.timeout(10_000) }).catch(() => null);
        if (!r?.ok) throw new Error('TLS oder healthz über die öffentliche Adresse noch nicht erreichbar');
        return { meldung: 'Zertifikat und healthz ok' };
      }
      case 'volume_anlegen': case 'container_starten': case 'healthz_warten': case 'admin_einladen': case 'beispiel_laden':
        return this.maschine(a.id).schritt(name, a);
      default:
        return this.maschineSchritt(name, a);
    }
  }

  private relativ(sub: string) { return this.o.domain === this.o.zone ? sub : `${sub}.${this.o.domain.slice(0, -(this.o.zone.length + 1))}`; }

  /** Server, DNS und Tunnel-Peer der Instanz löschen. Liefert die Nachweisliste. */
  async aufraeumen(id: string, subdomain?: string): Promise<string[]> {
    const weg: string[] = [];
    subdomain ??= this.stand.get(id)?.subdomain;
    for (const sv of await this.o.api.serverListe(`kern-instanz=${id}`)) {
      subdomain ??= sv.name.startsWith('kern-') ? sv.name.slice(5) : undefined;
      await this.o.api.serverLoeschen(sv.id);
      weg.push(`Server ${sv.id}`);
    }
    if (subdomain) { const rel = this.relativ(subdomain); await this.o.api.dnsLoeschen(this.o.zone, rel, 'A'); await this.o.api.dnsLoeschen(this.o.zone, rel, 'AAAA'); weg.push('DNS-Einträge'); }
    const p = this.netz.hole(id);
    if (p) { await this.o.wg.steuerung.peerEntfernen(p.oeffentlich).catch(() => undefined); this.netz.freigeben(id); weg.push('WireGuard-Peer'); }
    this.stand.delete(id);
    this.maschinen.delete(id);
    return weg;
  }

  /** Verwaiste Server (in Bereitstellung, ohne Rückruf, älter als 30 Minuten) löschen, auch nach Neustart des Leitstands. */
  async wartung(): Promise<string[]> {
    const out: string[] = [];
    const grenze = this.uhr() - (this.o.aufraeumenMinuten ?? 30) * 60_000;
    for (const sv of await this.o.api.serverListe('kern-status=bereitstellung')) {
      const id = sv.labels['kern-instanz'];
      if (!id || this.stand.get(id)?.rueckruf) continue;
      if (Date.parse(sv.created) > grenze) continue;
      await this.o.api.serverLoeschen(sv.id);
      out.push(`verwaister Server ${sv.id} (${id}) gelöscht, keine Bereitstellung nach 30 Minuten`);
    }
    return out;
  }

  async status(id: string): Promise<StatusAntwort> {
    const s = this.st(id);
    if (s.server_id) { const sv = await this.o.api.server(s.server_id).catch(() => null); if (sv && sv.status !== 'running') return nurBetriebsdaten({ health: 'aus', modus: 'pausiert' } as never); }
    return this.maschine(id).status(id);
  }
  async modus(id: string, m: Modus) { await this.maschine(id).modus(id, m); }
  async grenzen(id: string, g: Grenzen) { await this.maschine(id).grenzen(id, g); }
  async egress(id: string, hosts: string[]) { await this.maschine(id).egress(id, hosts); }
  async export(id: string, art: 'umzugspaket' | 'okf') { return this.maschine(id).export(id, art); }
  async beispiel(id: string, aktion: 'laden' | 'entfernen', s: Beispiel | null) { await this.maschine(id).beispiel(id, aktion, s); }
  async einladung(id: string, mail: string) { await this.maschine(id).einladung(id, mail); }
  async loeschen(id: string): Promise<string[]> {
    const g = this.o.geheimnisse.hole(id);
    const weg = await this.aufraeumen(id);
    if (g) { this.o.geheimnisse.loesche(id); weg.push('Schlüssel und Tokens'); }
    return weg.length ? weg : ['nichts mehr vorhanden'];
  }
  async wechselSchritt(name: string, _w: Wechselauftrag): Promise<{ meldung?: string }> {
    throw new Error(`Stufenwechsel-Schritt ${name}: über den Verbund-Bereitsteller`);
  }
  /** Rückbau eines gescheiterten Wechsels: Server, DNS und Peer weg; Geheimnisse gehören der laufenden Quelle. */
  async wechselRueckbau(w: Wechselauftrag) {
    const g = this.o.geheimnisse.hole(w.id);
    if (this.netz.hole(w.id)) await this.maschine(w.id).loeschenNurZiel(w.id).catch(() => undefined);
    await this.aufraeumen(w.id, w.subdomain);
    if (g) this.o.geheimnisse.setze(w.id, g);
  }
  async altLoeschen(id: string, _host: string) {
    const g = this.o.geheimnisse.hole(id);
    const vorher = this.netz.hole(id) ? await this.maschine(id).loeschenNurZiel(id).catch(() => [] as string[]) : [];
    const weg = await this.aufraeumen(id);
    if (g) this.o.geheimnisse.setze(id, g);
    return [...vorher, ...weg];
  }
}
