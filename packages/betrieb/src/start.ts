/**
 * Startet Leitstand und Konsole. Bindet standardmäßig nur an 127.0.0.1: Die Konsole gehört hinter VPN oder SSH-Tunnel,
 * nicht ins offene Netz. Der Mollie-Webhook braucht eine eigene, öffentlich erreichbare Route (Caddy leitet nur
 * `/v1/webhooks/mollie` weiter).
 */
import crypto from 'node:crypto';
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
import type { Host } from './typen.js';

const env = process.env;
const vorfuehrung = env.BETRIEB_VORFUEHRUNG === '1';
const port = Number(env.BETRIEB_PORT ?? env.PORT ?? 7490);
const hostname = env.BETRIEB_HOST ?? '127.0.0.1';
const secret = env.BETRIEB_SECRET ?? (vorfuehrung ? crypto.randomBytes(32).toString('hex') : '');
if (secret.length < 32) { console.error('BETRIEB_SECRET (mind. 32 Zeichen) fehlt'); process.exit(1); }

const db = oeffneDb(vorfuehrung ? ':memory:' : env.BETRIEB_DB ?? './leitstand/leitstand.sqlite');
const dummy = new DummyBereitsteller(env.KERN_MANAGED_DOMAIN ?? 'kenwarf.example.org');
const bereitsteller: Bereitsteller = env.BETRIEB_BEREITSTELLER === 'lokal' ? new LokalBereitsteller(env.BETRIEB_LOKAL_ORDNER ?? './leitstand/instanzen') : dummy;
const mollieFake = new MollieFake();
const mollie: MollieClient | undefined = env.MOLLIE_API_KEY ? new MollieHttp(env.MOLLIE_API_KEY) : vorfuehrung ? mollieFake : undefined;
const geteilteHosts: Omit<Host, 'erstellt' | 'stufe'>[] = env.BETRIEB_GETEILTE_HOSTS ? JSON.parse(env.BETRIEB_GETEILTE_HOSTS) : [];

if (vorfuehrung) await fuelleVorfuehrung(db, { t: Date.now() }, { bereitsteller: dummy, mollie: mollieFake });

const leitstand = new Leitstand({ db, bereitsteller, ...(mollie ? { mollie } : {}), domain: env.KERN_MANAGED_DOMAIN ?? 'kenwarf.example.org', ...(env.BETRIEB_RECHNUNG_LINK ? { rechnungLink: env.BETRIEB_RECHNUNG_LINK } : vorfuehrung ? { rechnungLink: 'https://rechnungen.example.org/kunden/{ref}' } : {}), geteilteHosts });
const admins = new Admins(db);
if (vorfuehrung && admins.anzahl() === 0) {
  const r = admins.anlegen('till', env.BETRIEB_VORFUEHRUNG_PASSWORT ?? 'vorfuehrung-nur-lokal');
  console.log(`Vorführung: Admin „till“, Passwort ${env.BETRIEB_VORFUEHRUNG_PASSWORT ? '(aus Env)' : 'vorfuehrung-nur-lokal'}, TOTP-Geheimnis ${r.secret}`);
  if (env.BETRIEB_VORFUEHRUNG_SECRET_DATEI) (await import('node:fs')).writeFileSync(env.BETRIEB_VORFUEHRUNG_SECRET_DATEI, r.secret, { mode: 0o600 });
}

const passkeys = new Passkeys(db, { id: env.BETRIEB_RP_ID ?? 'localhost', name: 'Leitstand', origin: env.BETRIEB_ORIGIN ?? `http://localhost:${port}` });
const { app } = erstelleApp({ leitstand, admins, passkeys, nurPasskey: env.BETRIEB_NUR_PASSKEY === '1', secret, secureCookie: env.BETRIEB_SECURE_COOKIE === '1', websiteUrl: env.KERN_WEBSITE_URL ?? 'https://kenwarf.example.org', trustProxy: env.BETRIEB_TRUST_PROXY === '1' });

// Planer: stündlich prüfen, einmal je Kalendertag laufen
let letzterTag = '';
const planerTick = async () => {
  const tag = new Date().toISOString().slice(0, 10);
  if (tag === letzterTag) return;
  letzterTag = tag;
  try { const r = await leitstand.planer(); console.log(`Planer ${tag}: ${r.automatisch.length} automatisch, ${r.klick.length} Klicks`); } catch (e) { console.error('Planer', (e as Error).message); }
};
if (!vorfuehrung) { void planerTick(); setInterval(() => void planerTick(), 3600_000).unref(); }

serve({ fetch: app.fetch, port, hostname }, (i) => console.log(`Leitstand auf http://${hostname}:${i.port} (${bereitsteller.name}${vorfuehrung ? ', Vorführung' : ''})`));
