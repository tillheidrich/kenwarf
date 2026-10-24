/**
 * Bereitsteller „docker“ für die Stufe „Geteilt“ (CONTRACT v1.4 3.1, 3.7; O1 1.8.1, 1.8.2): ein Container je Instanz
 * über die Docker Engine API, eigenes Daten- und Export-Volume, eigenes Netz `internal: true`, ausgehend nur über
 * kern-egress, Grenzen je Paket, Labels für Caddy und Zuordnung, Warten auf Health, Einmal-Zugang für den ersten Admin,
 * Löschen mit Nachweisliste.
 *
 * Namen, Labels, Netzaufteilung und Umgebung folgen deploy/host/kern-host (D2), damit beide Wege dieselben Instanzen
 * erzeugen: Container `<praefix>-<id>`, Netz `kn-<id>` (/28: .1 Gateway, .2 Caddy, .3 Egress, .4 Instanz), Bridge
 * `kb-<id ohne i_>`, Labels `kern.instanz`, `kern.paket`, `kern.subdomain`, Alias `inst-<subdomain>`, Port 7480.
 *
 * Ehrliche Grenzen: Ein XFS-Projektkontingent für das Datenvolume lässt sich über die Engine API nicht setzen (das macht
 * kern-host per kern-quota.sh auf dem Host). Hier gilt die Grenze nur in der App (P-5) plus Wächter, bis D2 einen
 * Volume-Treiber mit Größe oder einen Host-Dienst dafür liefert. nftables setzt D2s Dienst `nft-kern.sh beobachten`
 * anhand der Netz-Ereignisse mit Label `kern.instanz`.
 */
import crypto from 'node:crypto';
import type { DockerEngine, ContainerInfo } from '../docker/engine.js';
import type { EgressVerwaltung } from '../docker/egress.js';
import { BetriebClient, ExecTransport, HttpTransport, type Transport } from '../betrieb-client.js';
import type { Geheimnisse } from '../geheimnisse.js';
import { sha256 } from '../geheimnisse.js';
import type { Auftrag, Bereitsteller, Grenzen, Modus, SchrittErgebnis, StatusAntwort, Wechselauftrag } from './typ.js';
import { STANDARD_SCHRITTE, WECHSEL_SCHRITTE, nurBetriebsdaten } from './typ.js';
import type { Beispiel, HostLast, Paket } from '../typen.js';
import { PAKETE_STANDARD, type PaketWerte } from '../schalter.js';

export interface DockerOptionen {
  engine: DockerEngine;
  /** Kern-Image, am besten nach Digest (`kern@sha256:…`). */
  bild: string;
  domain: string;
  geheimnisse: Geheimnisse;
  /** Host-ID im Leitstand, für die dieser Bereitsteller zuständig ist (z. B. „geteilt-01“). */
  hostId?: string;
  /** Verwaltung von kern-egress; `null` nur in der Sandbox ohne Proxy (dann meldet jeder Schritt das). */
  egress: EgressVerwaltung | null;
  /** Containernamen von Caddy und Egress auf dem Host; `null` = nicht anhängen (Sandbox). */
  caddy?: string | null;
  egressContainer?: string | null;
  pakete?: () => Record<Paket | 'test', PaketWerte>;
  /** Pool für Instanznetze, je Instanz ein /28 (Standard wie kern-host: 10.231.0.0/16). */
  netzPool?: string;
  praefix?: string;
  bruecke?: string;
  /** Weg zu /_betrieb/*: per exec im Container (Standard) oder direkt über die Netzadresse. */
  betriebWeg?: 'exec' | 'netz';
  healthSek?: number;
  leitstandUrl?: string;
  /** Datei mit den KI-Anbietern für den Container (Bind, nur lesend), wie kern-host. */
  anbieterDatei?: string | null;
  /** Zusätzliche Umgebung (z. B. KERN_PROVIDER=mock im Test). */
  zusatzEnv?: Record<string, string>;
  /** Nur Sandbox: Instanz-Port auf 127.0.0.1:<port> veröffentlichen. In Betrieb nie (Caddy hängt im Netz). */
  sandboxPort?: (id: string) => number | null;
  /** Ziel-Bereitsteller für einen Stufenwechsel auf einen anderen Host. */
  ziel?: (hostId: string) => DockerBereitsteller | null;
}

const ID = /^i_[a-z0-9]{10}$/;
const GB = 1024 ** 3;

export class DockerBereitsteller implements Bereitsteller {
  readonly name = 'docker';
  readonly schritte = STANDARD_SCHRITTE;
  readonly wechselSchritte = WECHSEL_SCHRITTE;
  private p: string;
  /** Archiv beim Stufenwechsel, nur im Speicher und nur bis `einspielen` (nie auf Platte im Leitstand). */
  private unterwegs = new Map<string, Buffer>();
  constructor(readonly o: DockerOptionen) { this.p = o.praefix ?? 'kern'; }

  name_(id: string) { if (!ID.test(id)) throw new Error('ungültige Instanz-ID'); return `${this.p}-${id}`; }
  netz(id: string) { return `${this.p === 'kern' ? 'kn' : `${this.p}n`}-${id}`; }
  private bruecke(id: string) { return `${this.o.bruecke ?? 'kb'}-${id.slice(2)}`; }
  volumes(id: string) { return { daten: `${this.name_(id)}-daten`, export: `${this.name_(id)}-export` }; }
  private pakete() { return this.o.pakete?.() ?? PAKETE_STANDARD; }

  /** Eigene Container nur über Label und Namen: fremde Container werden nie angefasst. */
  private async eigener(id: string): Promise<ContainerInfo | null> {
    const c = await this.o.engine.containerInfoOpt(this.name_(id));
    if (c && c.Config.Labels['kern.instanz'] !== id) throw new Error(`Container ${this.name_(id)} trägt fremdes Label, wird nicht angefasst`);
    return c;
  }

  client(id: string, info?: ContainerInfo | null): BetriebClient {
    const g = this.o.geheimnisse.hole(id);
    if (!g) throw new Error('Keine Geheimnisse für diese Instanz');
    let t: Transport;
    if ((this.o.betriebWeg ?? 'exec') === 'exec') t = new ExecTransport(this.o.engine, this.name_(id), g.betrieb_token);
    else {
      const ip = info?.NetworkSettings.Networks[this.netz(id)]?.IPAddress;
      if (!ip) throw new Error('Instanz-IP unbekannt');
      t = new HttpTransport(`http://${ip}:7480`, g.betrieb_token);
    }
    return new BetriebClient(t);
  }

  private async freiesNetz(): Promise<{ basis: string; cidr: string }> {
    const pool = this.o.netzPool ?? '10.231';
    const belegt = new Set((await this.o.engine.netzListe('kern.instanz')).flatMap((n) => n.IPAM.Config.map((c) => c.Subnet ?? '')));
    for (let i = 0; i < 4096; i++) {
      const basis = `${pool}.${Math.floor(i / 16)}.${(i % 16) * 16}`;
      if (!belegt.has(`${basis}/28`)) return { basis, cidr: `${basis}/28` };
    }
    throw new Error(`kein freies Instanznetz im Pool ${pool}.0.0/16`);
  }

  private umgebung(a: Pick<Auftrag, 'id' | 'subdomain' | 'admin_mail'>, upload_mb: number, extra: Record<string, string> = {}): string[] {
    const g = this.o.geheimnisse.hole(a.id)!;
    const proxy = `http://${a.id}:${g.egress_token}@kern-egress:3128`;
    const env: Record<string, string> = {
      NODE_ENV: 'production', KERN_MODUS: 'managed', KERN_MANAGED: '1', KERN_BETRIEB: a.subdomain,
      KERN_SECRET: g.secret, KERN_BETRIEB_TOKEN_SHA256: sha256(g.betrieb_token), // nur der Hash in der Instanz (O1 1.7)
      KERN_PUBLIC_URL: `https://${a.subdomain}.${this.o.domain}`,
      KERN_TRUST_PROXY: '1', KERN_TRUST_PROXY_HOPS: '1', KERN_SECURE_COOKIE: '1', KERN_ERSTZUGANG: 'datei', KERN_MAX_UPLOAD_MB: String(upload_mb),
      HTTPS_PROXY: proxy, HTTP_PROXY: proxy, NO_PROXY: 'localhost,127.0.0.1', NODE_USE_ENV_PROXY: '1',
      KERN_KI_PROXY: `http://${a.id}.ki:${g.egress_token}@kern-egress:3128`,
      KERN_LEITSTAND_URL: this.o.leitstandUrl ?? '', KERN_KONTO_TOKEN: g.konto_token ?? '',
      ...(a.admin_mail ? { KERN_ADMIN: a.admin_mail } : {}),
      ...(this.o.anbieterDatei ? { KERN_ANBIETER_DATEI: '/etc/kern/anbieter.json' } : {}),
      ...this.o.zusatzEnv,
      ...extra,
    };
    return Object.entries(env).map(([k, v]) => `${k}=${v}`);
  }

  /** Container-Spezifikation (ContainerCreate). Härtung nach O1 1.8.1 und 3.7. */
  spec(a: Pick<Auftrag, 'id' | 'subdomain' | 'paket' | 'admin_mail'>, netz: { name: string; ip: string }, extraEnv: Record<string, string> = {}) {
    const w = this.pakete()[a.paket];
    const ram = w.ram_mb * 1024 * 1024;
    const v = this.volumes(a.id);
    const port = this.o.sandboxPort?.(a.id) ?? null;
    return {
      Image: this.o.bild,
      Hostname: 'kern',
      Env: this.umgebung(a, Math.round(w.upload_bytes / 1024 / 1024), extraEnv),
      Labels: { 'kern.instanz': a.id, 'kern.paket': a.paket, 'kern.subdomain': a.subdomain, ...(this.o.hostId ? { 'kern.host': this.o.hostId } : {}) },
      ...(port ? { ExposedPorts: { '7480/tcp': {} } } : {}),
      HostConfig: {
        NanoCpus: Math.round(w.cpu * 1e9), Memory: ram, MemorySwap: ram, MemoryReservation: w.ram_reserviert_mb * 1024 * 1024, PidsLimit: w.prozesse,
        ReadonlyRootfs: true, CapDrop: ['ALL'], SecurityOpt: ['no-new-privileges:true'], Tmpfs: { '/tmp': 'rw,nosuid,nodev,size=256m' },
        Ulimits: [{ Name: 'nofile', Soft: 4096, Hard: 4096 }],
        RestartPolicy: { Name: 'unless-stopped' }, LogConfig: { Type: 'json-file', Config: { 'max-size': '10m', 'max-file': '3' } },
        Mounts: [
          { Type: 'volume', Source: v.daten, Target: '/daten' },
          { Type: 'volume', Source: v.export, Target: '/daten-export' },
          ...(this.o.anbieterDatei ? [{ Type: 'bind', Source: this.o.anbieterDatei, Target: '/etc/kern/anbieter.json', ReadOnly: true }] : []),
        ],
        ...(port ? { PortBindings: { '7480/tcp': [{ HostIp: '127.0.0.1', HostPort: String(port) }] } } : {}),
      },
      User: '1000:1000',
      NetworkingConfig: { EndpointsConfig: { [netz.name]: { IPAMConfig: { IPv4Address: netz.ip }, Aliases: [`inst-${a.subdomain}`] } } },
    };
  }

  /** Netz und Container anlegen (ohne Start). Wiederholbar. */
  async anlegen(a: Pick<Auftrag, 'id' | 'subdomain' | 'paket' | 'admin_mail'>, extraEnv: Record<string, string> = {}): Promise<{ meldung: string }> {
    const e = this.o.engine;
    if (await this.eigener(a.id)) return { meldung: 'Container vorhanden' };
    const netzname = this.netz(a.id);
    let n = await e.netzInfoOpt(netzname);
    if (!n) {
      const { basis, cidr } = await this.freiesNetz();
      const [x, y, z, w0] = basis.split('.').map(Number) as [number, number, number, number];
      await e.netzAnlegen({ Name: netzname, Driver: 'bridge', Internal: true, CheckDuplicate: true, IPAM: { Config: [{ Subnet: cidr, Gateway: `${x}.${y}.${z}.${w0 + 1}` }] },
        Options: { 'com.docker.network.bridge.name': this.bruecke(a.id), 'com.docker.network.bridge.enable_icc': 'true' }, Labels: { 'kern.instanz': a.id } });
      n = await e.netzInfo(netzname);
    }
    if (n.Labels['kern.instanz'] !== a.id) throw new Error('Netz trägt fremdes Label');
    const sub = n.IPAM.Config[0]?.Subnet ?? '';
    const [x, y, z, w0] = sub.split('/')[0]!.split('.').map(Number) as [number, number, number, number];
    const ip = (k: number) => `${x}.${y}.${z}.${w0 + k}`;
    const teile: string[] = [];
    if (this.o.caddy) { await e.netzVerbinden(netzname, this.o.caddy, ip(2)); teile.push('Caddy verbunden'); }
    if (this.o.egressContainer) { await e.netzVerbinden(netzname, this.o.egressContainer, ip(3)); teile.push('Egress verbunden'); }
    if (this.o.egress) {
      const g = this.o.geheimnisse.hole(a.id)!;
      await this.o.egress.registrieren(a.id, { subdomain: a.subdomain, token_sha256: sha256(g.egress_token), netz_ip: ip(3), web_offen: true });
      teile.push('beim Egress registriert');
    } else teile.push('OHNE Egress-Dienst (nur Sandbox): kein Weg nach draußen');
    await e.containerAnlegen(this.name_(a.id), this.spec(a, { name: netzname, ip: ip(4) }, extraEnv));
    return { meldung: `${teile.join(', ')}; Netz ${sub}` };
  }

  async schritt(name: string, a: Auftrag): Promise<SchrittErgebnis> {
    const e = this.o.engine;
    switch (name) {
      case 'subdomain_pruefen': {
        const andere = (await e.containerListe(`kern.subdomain=${a.subdomain}`)).filter((c) => c.Labels['kern.instanz'] !== a.id);
        if (andere.length) throw new Error('Subdomain auf diesem Host schon vergeben');
        return {};
      }
      case 'schluessel_erzeugen':
        this.o.geheimnisse.sichere(a.id, { konto_token: a.konto_token });
        return { meldung: 'Sitzungsschlüssel, Betriebs- und Egress-Token erzeugt (verschlüsselt im Leitstand)' };
      case 'volume_anlegen': {
        const v = this.volumes(a.id);
        for (const n of [v.daten, v.export]) {
          const da = await e.volumeInfoOpt(n);
          if (da && da.Labels?.['kern.instanz'] !== a.id) throw new Error(`Volume ${n} trägt fremdes Label`);
          if (!da) await e.volumeAnlegen(n, { 'kern.instanz': a.id });
        }
        return { meldung: 'Daten- und Export-Volume angelegt (Kontingent nur in der App, XFS-Kontingent offen)' };
      }
      case 'container_starten': {
        const r = await this.anlegen(a);
        await e.containerStarten(this.name_(a.id));
        const c = await e.containerInfo(this.name_(a.id));
        return { meldung: r.meldung, url: `https://${a.subdomain}.${this.o.domain}`, version: c.Config.Labels['org.opencontainers.image.version'] ?? '0.1.0' };
      }
      case 'healthz_warten':
        return { meldung: await this.warteGesund(a.id) };
      case 'admin_einladen': {
        if (!a.admin_mail) return { meldung: 'keine Mail angegeben' };
        const c = this.client(a.id, await this.eigener(a.id));
        const ein = await c.einladung(a.admin_mail);
        if (ein) return { meldung: 'Einmal-Zugang erzeugt (nur per Mail an den Admin)', einladung: { mail: a.admin_mail, einmalPasswort: ein.einmalPasswort } };
        // Der Einstieg hat den Admin beim ersten Start angelegt (KERN_ADMIN, KERN_ERSTZUGANG=datei): Datei lesen und löschen.
        if ((this.o.betriebWeg ?? 'exec') !== 'exec') return { meldung: 'Admin vorhanden, Erstzugang liegt in der Instanz (ohne exec nicht lesbar)' };
        const r = await e.exec(this.name_(a.id), ['sh', '-c', 'f=/daten/.kern/erstzugang; [ -s "$f" ] && cat "$f" && rm -f "$f"'], { user: '1000:1000' });
        const pw = r.stdout.trim();
        if (r.code !== 0 || !pw) return { meldung: 'Admin vorhanden, Erstzugang schon abgeholt' };
        return { meldung: 'Erstzugang abgeholt und in der Instanz gelöscht (nur per Mail an den Admin)', einladung: { mail: a.admin_mail, einmalPasswort: pw } };
      }
      case 'beispiel_laden':
        if (!a.beispiel) return { meldung: 'übersprungen' };
        await this.beispiel(a.id, 'laden', a.beispiel);
        return { meldung: `Beispielsammlung der Engine geladen (gewünscht: ${a.beispiel})` };
      default:
        return {};
    }
  }

  async warteGesund(id: string): Promise<string> {
    const bis = Date.now() + (this.o.healthSek ?? 120) * 1000;
    const t0 = Date.now();
    for (;;) {
      const c = await this.eigener(id);
      if (!c) throw new Error('Container fehlt');
      const h = c.State.Health?.Status;
      if (h === 'healthy') return `gesund nach ${((Date.now() - t0) / 1000).toFixed(1)} s`;
      if (h === 'unhealthy') throw new Error('Instanz meldet unhealthy');
      if (!c.State.Running && c.State.Status !== 'created') throw new Error(`Container läuft nicht (${c.State.Status})`);
      if (!c.State.Health) {
        // Image ohne Healthcheck: selbst /healthz prüfen (per exec)
        const r = await this.o.engine.exec(this.name_(id), ['node', '-e', "fetch('http://127.0.0.1:7480/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]).catch(() => ({ code: 1 }));
        if (r.code === 0) return `gesund nach ${((Date.now() - t0) / 1000).toFixed(1)} s (eigene Prüfung)`;
      }
      if (Date.now() > bis) throw new Error(`nicht gesund nach ${this.o.healthSek ?? 120} s (${h ?? c.State.Status})`);
      await new Promise((r) => setTimeout(r, 500));
    }
  }

  async status(id: string): Promise<StatusAntwort> {
    const c = await this.eigener(id);
    if (!c || !c.State.Running) return nurBetriebsdaten({ health: 'aus', modus: 'pausiert' } as never);
    const s = await this.client(id, c).status();
    const health = c.State.Health?.Status === 'unhealthy' ? 'warnung' : 'ok';
    return { ...s, health };
  }
  async modus(id: string, m: Modus) { await this.client(id, await this.eigener(id)).modus(m); }
  async grenzen(id: string, g: Grenzen) { await this.client(id, await this.eigener(id)).grenzen(g); }
  /** Paketwechsel: CPU, RAM, Prozesse im laufenden Betrieb ändern (ContainerUpdate). */
  async paketGrenzen(id: string, paket: Paket) {
    const w = this.pakete()[paket];
    const ram = w.ram_mb * 1024 * 1024;
    await this.o.engine.containerAendern(this.name_(id), { NanoCpus: Math.round(w.cpu * 1e9), Memory: ram, MemorySwap: ram, MemoryReservation: w.ram_reserviert_mb * 1024 * 1024, PidsLimit: w.prozesse });
  }
  async egress(id: string, hosts: string[]) {
    if (!this.o.egress) throw new Error('Kein Egress-Dienst eingerichtet');
    await this.o.egress.freigabenSetzen(id, hosts);
  }
  async export(id: string, art: 'umzugspaket' | 'okf') { return this.client(id, await this.eigener(id)).export(art); }
  async beispiel(id: string, aktion: 'laden' | 'entfernen', _satz: Beispiel | null) { await this.client(id, await this.eigener(id)).beispiel(aktion); }
  async einladung(id: string, mail: string) { await this.client(id, await this.eigener(id)).einladung(mail); }

  /** Löscht nur, was Name und Label dieser Instanz trägt. Liefert die Nachweisliste für den Löschbeleg. */
  async loeschen(id: string): Promise<string[]> {
    const e = this.o.engine;
    const weg: string[] = [];
    const c = await this.eigener(id);
    if (c) { await e.containerEntfernen(c.Id); weg.push('Container'); }
    for (const n of [this.netz(id)]) {
      const info = await e.netzInfoOpt(n);
      if (info && info.Labels['kern.instanz'] === id) {
        if (this.o.caddy) await e.netzTrennen(n, this.o.caddy);
        if (this.o.egressContainer) await e.netzTrennen(n, this.o.egressContainer);
        await e.netzEntfernen(n);
        weg.push('Netz');
      }
    }
    if (this.o.egress) { await this.o.egress.abmelden(id); weg.push('Egress-Registrierung und Freigaben'); }
    for (const v of Object.values(this.volumes(id))) {
      const info = await e.volumeInfoOpt(v);
      if (info && info.Labels?.['kern.instanz'] === id) { await e.volumeEntfernen(v); weg.push(v.endsWith('-daten') ? 'Datenvolume' : 'Exportvolume'); }
    }
    this.o.geheimnisse.loesche(id);
    weg.push('Sitzungsschlüssel und Tokens');
    return weg.length > 1 ? weg : ['nichts mehr vorhanden'];
  }

  async hostLast(_host: string): Promise<Partial<HostLast> | null> {
    const liste = await this.o.engine.containerListe('kern.instanz');
    const eigene = this.o.hostId ? liste.filter((c) => !c.Labels['kern.host'] || c.Labels['kern.host'] === this.o.hostId) : liste;
    return { container: eigene.length, quelle: 'gemessen' };
  }

  // ---------- Umzugspaket zwischen Hosts (Engine API, über den Tunnel) ----------
  /** Holt eine Datei aus dem Container (GET /archive) und gibt Tar plus SHA-256 des Dateiinhalts zurück. */
  async dateiHolen(id: string, pfad: string): Promise<{ tar: Buffer; sha256: string; bytes: number }> {
    // Exporte der Instanz liegen unter /daten/.kern/export/<id>/ (server), abgelegte Pakete unter /daten-export
    if (!/^\/(daten-export|daten\/\.kern\/export\/[A-Za-z0-9_-]{1,64})\/[A-Za-z0-9._-]{1,200}$/.test(pfad)) throw new Error('nur Exportdateien');
    const tar = await this.o.engine.archivHolen(this.name_(id), pfad);
    const d = tarDatei(tar);
    return { tar, sha256: crypto.createHash('sha256').update(d.inhalt).digest('hex'), bytes: d.inhalt.length };
  }
  /**
   * Legt Dateien im Export-Volume der Instanz ab (Helfer-Container ohne Netz, nur das Volume) und liest sie zur Prüfung
   * zurück. Liefert die SHA-256 je Datei, gemessen am Ziel.
   */
  async dateienAblegen(id: string, dateien: { name: string; inhalt: Buffer; modus?: number }[]): Promise<Record<string, string>> {
    const e = this.o.engine, helfer = `${this.name_(id)}-ablage`;
    await e.containerEntfernen(helfer).catch(() => undefined);
    await e.containerAnlegen(helfer, { Image: this.o.bild, Entrypoint: ['true'], Cmd: [], User: '1000:1000', Labels: { 'kern.instanz': id, 'kern.rolle': 'ablage' },
      HostConfig: { NetworkMode: 'none', CapDrop: ['ALL'], SecurityOpt: ['no-new-privileges:true'], Mounts: [{ Type: 'volume', Source: this.volumes(id).export, Target: '/daten-export' }] } });
    const pruef: Record<string, string> = {};
    try {
      await e.archivEinspielen(helfer, '/daten-export', tarBauen(dateien));
      for (const d of dateien) pruef[d.name] = crypto.createHash('sha256').update(tarDatei(await e.archivHolen(helfer, `/daten-export/${d.name}`)).inhalt).digest('hex');
    } finally { await e.containerEntfernen(helfer); }
    return pruef;
  }
  /** Entfernt eine Datei im laufenden Container (z. B. die Passphrase nach dem Import). */
  async dateiEntfernen(id: string, pfad: string) {
    if (!/^\/daten-export\/[A-Za-z0-9._-]{1,200}$/.test(pfad)) throw new Error('nur Dateien aus /daten-export');
    const r = await this.o.engine.exec(this.name_(id), ['rm', '-f', pfad], { user: '1000:1000' });
    if (r.code !== 0) throw new Error(`Datei nicht entfernt: ${r.stderr.slice(0, 120)}`);
  }

  // ---------- Stufenwechsel auf einen anderen Docker-Host (Archiv über die Engine API) ----------
  private zielVon(w: Wechselauftrag): DockerBereitsteller {
    const z = this.o.ziel?.(w.nach.host);
    if (!z) throw new Error(`Kein Docker-Ziel für Host ${w.nach.host}`);
    return z;
  }
  /** Prüfsumme über /daten ohne den wegwerfbaren Index und ohne Laufzeitdateien unter .kern/ (außer users.json). */
  async baumHash(id: string): Promise<string> {
    const skript = "const fs=require('fs'),p=require('path'),c=require('crypto');const h=c.createHash('sha256');const L=[];(function w(d,r){for(const e of fs.readdirSync(d,{withFileTypes:true})){const rr=r?r+'/'+e.name:e.name;if(rr.startsWith('.kern/')&&rr!=='.kern/users.json')continue;if(e.isDirectory())w(p.join(d,e.name),rr);else if(e.isFile())L.push(rr)}})('/daten','');for(const f of L.sort()){h.update(f+'\\0');h.update(fs.readFileSync('/daten/'+f));h.update('\\0')}process.stdout.write(h.digest('hex'))";
    const r = await this.o.engine.exec(this.name_(id), ['node', '-e', skript], { user: '1000:1000' });
    if (r.code !== 0 || !/^[a-f0-9]{64}$/.test(r.stdout.trim())) throw new Error(`Prüfsumme nicht berechenbar: ${r.stderr.slice(0, 120)}`);
    return r.stdout.trim();
  }

  async wechselSchritt(name: string, w: Wechselauftrag): Promise<{ meldung?: string; ergebnis?: Record<string, string | number> }> {
    const z = this.zielVon(w);
    const e = this.o.engine;
    switch (name) {
      case 'ziel_bereitstellen': {
        // Ziel bekommt dieselben Geheimnisse (Sitzungen enden trotzdem nicht, Tokens ziehen mit), aber noch keinen Start
        const g = this.o.geheimnisse.hole(w.id);
        if (!g) throw new Error('Geheimnisse fehlen');
        if (z.o.geheimnisse !== this.o.geheimnisse) z.o.geheimnisse.setze(w.id, g);
        await z.schritt('volume_anlegen', { id: w.id, subdomain: w.subdomain, paket: w.paket } as Auftrag);
        const r = await z.anlegen({ id: w.id, subdomain: w.subdomain, paket: w.paket, admin_mail: null });
        return { meldung: `Ziel angelegt auf ${w.nach.host} (${r.meldung})` };
      }
      case 'alt_nur_lesen': await this.modus(w.id, 'nur_lesen'); return {};
      case 'paket_bauen': {
        const tar = await e.archivHolen(this.name_(w.id), '/daten');
        this.unterwegs.set(w.id, tar);
        return { ergebnis: { bytes: tar.length } };
      }
      case 'uebertragen': {
        const tar = this.unterwegs.get(w.id);
        if (!tar) throw new Error('kein Paket unterwegs');
        // Archiv enthält „daten/…“. Der Zielcontainer hat ein schreibgeschütztes Wurzeldateisystem; die Engine lehnt
        // PUT /archive dann ab. Deshalb ein kurzlebiger Helfer ohne Netz, der nur das Datenvolume einhängt.
        const helfer = `${z.name_(w.id)}-umzug`;
        await z.o.engine.containerEntfernen(helfer).catch(() => undefined);
        await z.o.engine.containerAnlegen(helfer, { Image: z.o.bild, Entrypoint: ['true'], Cmd: [], User: '1000:1000', Labels: { 'kern.instanz': w.id, 'kern.rolle': 'umzug' },
          HostConfig: { NetworkMode: 'none', CapDrop: ['ALL'], SecurityOpt: ['no-new-privileges:true'], Mounts: [{ Type: 'volume', Source: z.volumes(w.id).daten, Target: '/daten' }] } });
        try { await z.o.engine.archivEinspielen(helfer, '/', tar); } finally { await z.o.engine.containerEntfernen(helfer); }
        this.unterwegs.delete(w.id);
        return { meldung: `${tar.length} Bytes übertragen` };
      }
      case 'einspielen':
        await z.o.engine.containerStarten(z.name_(w.id));
        return { meldung: await z.warteGesund(w.id) };
      case 'pruefen':
        return { ergebnis: { alt: await this.baumHash(w.id), neu: await z.baumHash(w.id) } };
      case 'umschalten':
        // Gleicher Host: Caddy findet das Ziel über den Alias. Anderer Host: DNS-Eintrag (Hetzner) oder Caddy-Ziel.
        return { meldung: `Route ${w.subdomain} → ${w.nach.host}` };
      case 'alt_anhalten':
        await e.containerStoppen(this.name_(w.id));
        return { meldung: 'alter Container angehalten (Rückfallebene)' };
      default: return {};
    }
  }
  async wechselRueckbau(w: Wechselauftrag) {
    this.unterwegs.delete(w.id);
    const z = this.o.ziel?.(w.nach.host);
    if (z) { const g = this.o.geheimnisse.hole(w.id); await z.loeschenNurZiel(w.id); if (g && z.o.geheimnisse === this.o.geheimnisse) this.o.geheimnisse.setze(w.id, g); }
    if (await this.eigener(w.id)) await this.modus(w.id, 'normal').catch(() => undefined);
  }
  /** Rückbau am Ziel: alles der Instanz weg, Geheimnisse bleiben (gehören der laufenden Quelle). */
  async loeschenNurZiel(id: string) {
    const g = this.o.geheimnisse.hole(id);
    const weg = await this.loeschen(id);
    if (g) this.o.geheimnisse.setze(id, g);
    return weg;
  }
  async altLoeschen(id: string, _host: string) { return this.loeschenNurZiel(id); }
}

/** Zufällige, gültige Instanz-ID (für Tests). */
export function testId(): string { return 'i_' + Array.from(crypto.randomBytes(10), (b) => 'abcdefghijklmnopqrstuvwxyz0123456789'[b % 36]).join(''); }
export const _GB = GB;

/** Erste reguläre Datei aus einem Tar (ustar, wie es die Engine liefert). */
export function tarDatei(tar: Buffer): { name: string; inhalt: Buffer } {
  let i = 0;
  while (i + 512 <= tar.length) {
    const kopf = tar.subarray(i, i + 512);
    if (kopf.every((b) => b === 0)) break;
    const name = kopf.subarray(0, 100).toString('utf8').replace(/\0.*$/s, '');
    const groesse = parseInt(kopf.subarray(124, 136).toString('utf8').replace(/\0.*$/s, '').trim() || '0', 8);
    const typ = String.fromCharCode(kopf[156] ?? 48);
    if (typ === '0' || typ === '\0') return { name, inhalt: Buffer.from(tar.subarray(i + 512, i + 512 + groesse)) };
    i += 512 + Math.ceil(groesse / 512) * 512;
  }
  throw new Error('Tar ohne Datei');
}
/** Kleines ustar mit regulären Dateien (Besitzer 1000:1000), für PUT /archive. */
export function tarBauen(dateien: { name: string; inhalt: Buffer; modus?: number }[]): Buffer {
  const teile: Buffer[] = [];
  for (const d of dateien) {
    if (!/^[A-Za-z0-9._-]{1,100}$/.test(d.name)) throw new Error('Dateiname ungültig');
    const k = Buffer.alloc(512, 0);
    const okt = (n: number, l: number) => n.toString(8).padStart(l - 1, '0') + '\0';
    k.write(d.name, 0, 'utf8'); k.write(okt(d.modus ?? 0o600, 8), 100); k.write(okt(1000, 8), 108); k.write(okt(1000, 8), 116);
    k.write(okt(d.inhalt.length, 12), 124); k.write(okt(Math.floor(Date.now() / 1000), 12), 136); k.write('        ', 148); k.write('0', 156); k.write('ustar\x0000', 257);
    let summe = 0; for (const b of k) summe += b;
    k.write(summe.toString(8).padStart(6, '0') + '\0 ', 148);
    teile.push(k, d.inhalt, Buffer.alloc((512 - (d.inhalt.length % 512)) % 512, 0));
  }
  teile.push(Buffer.alloc(1024, 0));
  return Buffer.concat(teile);
}
