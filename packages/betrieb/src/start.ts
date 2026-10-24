/**
 * Startet Leitstand und Konsole. Bindet standardmäßig nur an 127.0.0.1: Die Konsole gehört hinter VPN oder SSH-Tunnel,
 * nicht ins offene Netz. Der Mollie-Webhook braucht eine eigene, öffentlich erreichbare Route (Caddy leitet nur
 * `/v1/webhooks/mollie` weiter).
 */
import crypto from 'node:crypto';
import fsm from 'node:fs';
import { serve } from '@hono/node-server';
import { oeffneDb } from './db.js';
import { Leitstand } from './leitstand.js';
import { Admins } from './auth.js';
import { Passkeys } from './passkey.js';
import { erstelleApp } from './app.js';
import { DummyBereitsteller } from './bereitsteller/dummy.js';
import { LokalBereitsteller } from './bereitsteller/lokal.js';
import type { Bereitsteller } from './bereitsteller/typ.js';
import { MollieFake, MollieHttp, type MollieClient } from './mollie.js';
import { fuelleVorfuehrung } from './vorfuehrung.js';
import { DockerEngine } from './docker/engine.js';
import { EgressVerwaltung } from './docker/egress.js';
import { DockerBereitsteller } from './bereitsteller/docker.js';
import { HetznerBereitsteller } from './bereitsteller/hetzner.js';
import { VerbundBereitsteller } from './bereitsteller/verbund.js';
import { HetznerApi } from './hetzner/api.js';
import { Geheimnisse } from './geheimnisse.js';
import { WgBefehl } from './wireguard.js';
import { SmtpSender, smtpAusUmgebung, versendePostausgang } from './mail/versand.js';
import { McpClient, RechnungsEntwurf } from './rechnung.js';
import type { Host } from './typen.js';

const env = process.env;
const vorfuehrung = env.BETRIEB_VORFUEHRUNG === '1';
const port = Number(env.BETRIEB_PORT ?? env.PORT ?? 7490);
const hostname = env.BETRIEB_HOST ?? '127.0.0.1';
const secret = env.BETRIEB_SECRET ?? (vorfuehrung ? crypto.randomBytes(32).toString('hex') : '');
if (secret.length < 32) { console.error('BETRIEB_SECRET (mind. 32 Zeichen) fehlt'); process.exit(1); }

const db = oeffneDb(vorfuehrung ? ':memory:' : env.BETRIEB_DB ?? './leitstand/leitstand.sqlite');
const dummy = new DummyBereitsteller(env.KERN_MANAGED_DOMAIN ?? 'kern.example.org');
/**
 * BETRIEB_BEREITSTELLER=docker: BETRIEB_DOCKER_HOSTS als JSON-Liste
 *   [{ "host": "geteilt-01", "verbindung": { "art": "socket" } | { "art": "tcp", "host": "10.0.0.2", "port": 2376, "ca": "/pfad/ca.pem", "cert": "…", "key": "…" },
 *      "egress_url": "http://127.0.0.1:3129", "egress_token_datei": "/srv/kern/egress/admin-token" }]
 * dazu BETRIEB_KERN_IMAGE, BETRIEB_GEHEIMNIS_SCHLUESSEL; optional HETZNER_TOKEN, HETZNER_ZONE, HETZNER_SSH_KEYS (Komma).
 */
function dockerVerbund(): VerbundBereitsteller {
  const schl = env.BETRIEB_GEHEIMNIS_SCHLUESSEL;
  if (!schl) { console.error('BETRIEB_GEHEIMNIS_SCHLUESSEL (32 Byte hex) fehlt'); process.exit(1); }
  const g = new Geheimnisse(db, schl);
  const hosts = JSON.parse(env.BETRIEB_DOCKER_HOSTS ?? '[{"host":"geteilt-01","verbindung":{"art":"socket"}}]') as { host: string; verbindung: { art: 'socket'; pfad?: string } | { art: 'tcp'; host: string; port?: number; ca: string; cert: string; key: string }; egress_url?: string; egress_token_datei?: string }[];
  const domain = env.KERN_MANAGED_DOMAIN ?? 'kern.example.org';
  const geteilt = Object.fromEntries(hosts.map((h) => [h.host, new DockerBereitsteller({
    engine: new DockerEngine(h.verbindung.art === 'socket' ? h.verbindung : { art: 'tcp', host: h.verbindung.host, ...(h.verbindung.port ? { port: h.verbindung.port } : {}), tls: { ca: fsm.readFileSync(h.verbindung.ca), cert: fsm.readFileSync(h.verbindung.cert), key: fsm.readFileSync(h.verbindung.key) } }),
    bild: env.BETRIEB_KERN_IMAGE ?? 'kern:latest', domain, geheimnisse: g, hostId: h.host,
    egress: h.egress_url && h.egress_token_datei ? new EgressVerwaltung(h.egress_url, fsm.readFileSync(h.egress_token_datei, 'utf8').trim()) : null,
    caddy: 'kern-caddy', egressContainer: 'kern-egress', leitstandUrl: env.BETRIEB_OEFFENTLICHE_URL ?? '', anbieterDatei: env.BETRIEB_ANBIETER_DATEI ?? null,
  })]));
  // Eigene Maschine: Hetzner-Token, WireGuard-Schnittstelle des Leitstands (BETRIEB_WG_SCHNITTSTELLE, öffentlicher Schlüssel BETRIEB_WG_PUB)
  const eigen = env.HETZNER_TOKEN && env.BETRIEB_WG_PUB && env.BETRIEB_KERN_IMAGE ? new HetznerBereitsteller({ api: new HetznerApi(env.HETZNER_TOKEN), db, domain, zone: env.HETZNER_ZONE ?? domain, geheimnisse: g, leitstandUrl: env.BETRIEB_OEFFENTLICHE_URL ?? '', sshKeys: (env.HETZNER_SSH_KEYS ?? '').split(',').filter(Boolean), kernImage: env.BETRIEB_KERN_IMAGE,
    wg: { oeffentlich: env.BETRIEB_WG_PUB, steuerung: new WgBefehl(env.BETRIEB_WG_SCHNITTSTELLE ?? 'wg0') }, ...(env.BETRIEB_BACKUP_ZIEL ? { backupZiel: env.BETRIEB_BACKUP_ZIEL } : {}), ...(env.KERN_REPO ? { repo: { url: env.KERN_REPO, ref: env.KERN_REF ?? 'main' } } : {}) }) : null;
  return new VerbundBereitsteller(geteilt, eigen);
}
const bereitsteller: Bereitsteller = env.BETRIEB_BEREITSTELLER === 'lokal' ? new LokalBereitsteller(env.BETRIEB_LOKAL_ORDNER ?? './leitstand/instanzen') : env.BETRIEB_BEREITSTELLER === 'docker' ? dockerVerbund() : dummy;
const mollieFake = new MollieFake();
const mollie: MollieClient | undefined = env.MOLLIE_API_KEY ? new MollieHttp(env.MOLLIE_API_KEY) : vorfuehrung ? mollieFake : undefined;
const geteilteHosts: Omit<Host, 'erstellt' | 'stufe'>[] = env.BETRIEB_GETEILTE_HOSTS ? JSON.parse(env.BETRIEB_GETEILTE_HOSTS) : [];

if (vorfuehrung) await fuelleVorfuehrung(db, { t: Date.now() }, { bereitsteller: dummy, mollie: mollieFake });

let leitstandRef: Leitstand | null = null;
const leitstand = new Leitstand({ db, bereitsteller, ...(mollie ? { mollie } : {}), domain: env.KERN_MANAGED_DOMAIN ?? 'kern.example.org', ...(env.BETRIEB_RECHNUNG_LINK ? { rechnungLink: env.BETRIEB_RECHNUNG_LINK } : vorfuehrung ? { rechnungLink: 'https://rechnungen.example.org/kunden/{ref}' } : {}), geteilteHosts,
  ...(env.BETRIEB_OEFFENTLICHE_URL ? { oeffentlicheUrl: env.BETRIEB_OEFFENTLICHE_URL } : {}),
  // Rechnungs-Werkzeug: nur Entwürfe (S-9), MCP-Adresse und Token aus der Umgebung
  ...(env.BETRIEB_RECHNUNG_MCP_URL ? { rechnungen: new RechnungsEntwurf(new McpClient({ url: env.BETRIEB_RECHNUNG_MCP_URL, ...(env.BETRIEB_RECHNUNG_MCP_TOKEN ? { token: env.BETRIEB_RECHNUNG_MCP_TOKEN } : {}) }), { produkt: () => leitstandRef?.schalter().produkt_name ?? 'Kern' }) } : {}) });
leitstandRef = leitstand;
if (bereitsteller instanceof VerbundBereitsteller) {
  bereitsteller.hostVon = (id) => leitstand.instanz(id).host;
  // Hetzner-Kosten nur mit bestätigter Zahlung (Mollie bezahlt oder Rechnung durch Till)
  if (bereitsteller.eigen) bereitsteller.eigen.o.zahlungBestaetigt = (id) => { const i = leitstand.instanz(id); return (i.zahlung === 'mollie' || i.zahlung === 'rechnung') && ['angelegt', 'aktiv', 'wechsel_laeuft'].includes(i.status); };
}
const admins = new Admins(db);
if (vorfuehrung && admins.anzahl() === 0) {
  const r = admins.anlegen('till', env.BETRIEB_VORFUEHRUNG_PASSWORT ?? 'vorfuehrung-nur-lokal');
  console.log(`Vorführung: Admin „till“, Passwort ${env.BETRIEB_VORFUEHRUNG_PASSWORT ? '(aus Env)' : 'vorfuehrung-nur-lokal'}, TOTP-Geheimnis ${r.secret}`);
  if (env.BETRIEB_VORFUEHRUNG_SECRET_DATEI) (await import('node:fs')).writeFileSync(env.BETRIEB_VORFUEHRUNG_SECRET_DATEI, r.secret, { mode: 0o600 });
}

const passkeys = new Passkeys(db, { id: env.BETRIEB_RP_ID ?? 'localhost', name: 'Leitstand', origin: env.BETRIEB_ORIGIN ?? `http://localhost:${port}` });
const { app } = erstelleApp({ leitstand, admins, passkeys, nurPasskey: env.BETRIEB_NUR_PASSKEY === '1', secret, secureCookie: env.BETRIEB_SECURE_COOKIE === '1', websiteUrl: env.KERN_WEBSITE_URL ?? 'https://kern.example.org', trustProxy: env.BETRIEB_TRUST_PROXY === '1' });

// Planer: stündlich prüfen, einmal je Kalendertag laufen
let letzterTag = '';
const planerTick = async () => {
  const tag = new Date().toISOString().slice(0, 10);
  if (tag === letzterTag) return;
  letzterTag = tag;
  try { const r = await leitstand.planer(); console.log(`Planer ${tag}: ${r.automatisch.length} automatisch, ${r.klick.length} Klicks`); } catch (e) { console.error('Planer', (e as Error).message); }
};
if (!vorfuehrung) { void planerTick(); setInterval(() => void planerTick(), 3600_000).unref(); }

// Postausgang alle 60 s über SMTP; ohne Einstellung bleibt alles „vorgemerkt“ (kein Versand an einen Fremddienst)
const smtp = smtpAusUmgebung();
if (smtp && !vorfuehrung) {
  const sender = new SmtpSender(smtp);
  setInterval(() => { versendePostausgang(db, sender).then((r) => { if (r.versendet || r.fehler) console.log(`Post: ${r.versendet} versendet, ${r.fehler} Fehler`); }).catch((e) => console.error('Post', (e as Error).message)); }, 60_000).unref();
}
// Wartung (verwaiste Server) alle 5 Minuten
if (bereitsteller.wartung && !vorfuehrung) setInterval(() => { bereitsteller.wartung!().then((m) => m.forEach((x) => console.log(x))).catch(() => undefined); }, 300_000).unref();

serve({ fetch: app.fetch, port, hostname }, (i) => console.log(`Leitstand auf http://${hostname}:${i.port} (${bereitsteller.name}${vorfuehrung ? ', Vorführung' : ''})`));
