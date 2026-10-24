import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import type { Context, Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { z } from 'zod';
import type { ExportArt, ImportArt, KernLike, ProviderConfig, PruefbankLauf, Sichtbarkeit, User } from './types.js';
import { IMPORT_ARTEN } from './types.js';
import type { ServerConfig } from './config.js';
import { leseKernYaml } from './config.js';
import { KernFehler, keineRechte, nichtGefunden, statusAusFehler, ungueltig } from './fehler.js';
import type { Aktion } from './rechte.js';
import type { Betriebszustand } from './betrieb.js';
import type { Geheimnisse } from './geheimnisse.js';
import type { Abruf } from './egress.js';
import type { Exporte } from './export.js';
import type { SicherheitsEreignis } from './protokoll.js';
import { KiVerwaltung, ohneGeheimnis, testeVerbindung, type KiBlock, type KiStatus } from './ki.js';
import { voreinstellungenFuer } from './voreinstellungen.js';
import { Einrichtungszustand, fragenAusQuellen } from './einrichtung.js';
import { bauDatenweg } from './datenweg.js';

/**
 * v1.4 Ergänzungen der REST-API (Abschnitte 4.1, 7, 8, 9 und v1.3-Lesen), getrennt von app.ts, damit dort die
 * Sicherheitsschicht übersichtlich bleibt. Registriert vor dem 404-Auffang von /api/*.
 */
export interface V14Kontext {
  app: Hono;
  kern: KernLike;
  config: ServerConfig;
  betrieb: Betriebszustand;
  geheimnisse: Geheimnisse;
  abruf: Abruf;
  exporte: Exporte;
  ki: KiVerwaltung;
  einrichtung: Einrichtungszustand;
  json<T>(c: Context, s: z.ZodType<T>): Promise<T>;
  pruefeRecht(c: Context, a: Aktion): void;
  prot(c: Context, e: SicherheitsEreignis, b: string | null, er?: 'ok' | 'abgelehnt' | 'fehler', z?: string): void;
  /** Raten-, Tages- und Kontingentprüfung vor KI-Arbeit. Wirft 429. */
  kiFreigabe(u: User, art: 'frage' | 'ki'): Promise<void>;
  basisUrl(c: Context): string;
  einstellungenAnsicht(u: User): Record<string, unknown>;
}

const user = (c: Context): User => c.get('user' as never) as User;
const nichtDa = (was: string) => new KernFehler(501, was, 'nicht_verfuegbar');
const zufall = (p: string) => `${p}_${crypto.randomBytes(9).toString('hex')}`;

export function v14Routen(k: V14Kontext): void {
  const { app, kern, config } = k;

  // ================= 4.1 Einrichtung =================
  const nurAdmin = (c: Context) => k.pruefeRecht(c, 'verwalten');
  const zaehleQuellen = () => k.betrieb.zaehleMd('quellen');

  const voreinstellungen = () => voreinstellungenFuer({ managed: config.modus === 'managed', anbieter: config.anbieter, testKi: config.testKi, berufsgeheimnis: config.berufsgeheimnis });
  const testKiVerfuegbar = () => config.modus === 'managed' && config.testKi && !config.berufsgeheimnis;

  const beispielGeladen = async (): Promise<boolean> => {
    if (typeof kern.beispielGeladen === 'function') return !!(await kern.beispielGeladen());
    return fs.existsSync(path.join(config.dataDir, 'quellen', 'beispiel'));
  };

  const vorschlagsfragen = async (u: User): Promise<string[]> => {
    if (typeof kern.vorschlagsfragen === 'function') return (await kern.vorschlagsfragen(u)).slice(0, 3);
    return fragenAusQuellen(await kern.listeQuellen(u));
  };

  const einrichtungAnsicht = async (u: User) => {
    const s = k.einrichtung.stand;
    const weg = k.ki.weg();
    const kiAnsicht = k.ki.ansicht();
    const schritt = s.fertig ? 'fertig' : weg === null ? 'ki' : zaehleQuellen() === 0 ? 'unterlagen' : !s.erste_belegte_antwort ? 'erste_frage' : 'fertig';
    return {
      schritt,
      ki: { weg, voreinstellung: kiAnsicht.voreinstellung, status: kiAnsicht.status },
      beispiel_geladen: await beispielGeladen(),
      vorschlagsfragen: await vorschlagsfragen(u),
      erste_belegte_antwort: s.erste_belegte_antwort,
      test_ki_verfuegbar: testKiVerfuegbar(),
      // Zusätzlich (additiv): MCP-Adresse für den Weg „app“ und Hinweis für Berufsgeheimnisträger.
      mcp_adresse: null as string | null,
      berufsgeheimnis: config.berufsgeheimnis,
    };
  };

  app.get('/api/einrichtung', async (c) => {
    nurAdmin(c);
    const a = await einrichtungAnsicht(user(c));
    a.mcp_adresse = `${k.basisUrl(c)}/mcp`;
    return c.json(a);
  });

  const kiSchema = z.object({
    weg: z.enum(['hd_test', 'eigener_schluessel', 'app', 'ohne']),
    voreinstellung: z.string().regex(/^[a-z0-9_-]{1,40}$/).optional(),
    url: z.string().url().max(500).refine((u) => /^https?:\/\//i.test(u), 'Nur http(s)-Adressen.').optional(),
    chatModell: z.string().trim().min(1).max(200).optional(),
    embedModell: z.string().trim().min(1).max(200).optional(),
    schluessel: z.string().min(8).max(500).optional(),
  }).strict();

  /** Baut aus der Eingabe den KI-Block für kern.yaml und den Anbieter für den Test (mit Schlüssel nur im Speicher). */
  const baueKi = (b: z.infer<typeof kiSchema>): { block: KiBlock; test: ProviderConfig; schluesselName: string | null } => {
    const vorher = ohneGeheimnis(k.ki.lies());
    if (b.weg === 'ohne' || b.weg === 'app') {
      if (b.url || b.schluessel) throw ungueltig(`Beim Weg „${b.weg}“ gibt es keine Adresse und keinen Schlüssel.`);
      return { block: { art: 'mock', weg: b.weg, voreinstellung: null, status: 'ohne_ki', vorher }, test: { art: 'mock' }, schluesselName: null };
    }
    const managed = config.modus === 'managed';
    // H2: im Managed-Betrieb nie eine freie Adresse; die Test-KI von HD nie mit einer Kunden-Adresse.
    if (b.url && (managed || b.weg === 'hd_test')) throw ungueltig(b.weg === 'hd_test' ? 'Die Test-KI läuft nur mit ihrer festen Adresse.' : 'Managed-Betrieb: nur Anbieter aus der Liste, keine eigene Adresse. Eigene Endpunkte gibt es über eine Egress-Anfrage (Einstellungen › Konto).');
    if (b.weg === 'hd_test') {
      if (!testKiVerfuegbar()) throw new KernFehler(409, config.berufsgeheimnis ? 'Für Berufsgeheimnisträger stellt HD keinen Modellzugang. Bitte einen eigenen Schlüssel eines EU-Anbieters oder ein lokales Modell nutzen.' : 'Die Test-KI ist hier nicht verfügbar.', 'nicht_verfuegbar');
      if (b.schluessel) throw ungueltig('Die Test-KI braucht keinen Schlüssel.');
      const block: KiBlock = { art: config.anbieter.find((a) => a.id === 'hd_test')!.art, anbieter: 'hd_test', voreinstellung: 'hd_test', weg: 'hd_test', status: 'ungeprueft', vorher };
      return { block, test: k.ki.provider(block), schluesselName: null };
    }
    // eigener Schlüssel
    const liste = voreinstellungen();
    const v = b.voreinstellung ? liste.find((x) => x.id === b.voreinstellung) : undefined;
    if (b.voreinstellung && !v) throw ungueltig('Unbekannte Voreinstellung.');
    if (b.voreinstellung === 'hd_test') throw ungueltig('Die Test-KI ist ein eigener Weg (weg: hd_test).');
    if (managed && !v) throw ungueltig('Managed-Betrieb: bitte eine Voreinstellung aus der Liste wählen.');
    if (!v && !b.url) throw ungueltig('Bitte eine Voreinstellung oder eine Adresse angeben.');
    const art = v?.art ?? 'openai';
    const chatModell = b.chatModell ?? v?.chatModelle[0];
    const embedModell = b.embedModell ?? v?.embedModelle[0];
    if (art !== 'anthropic' && (!chatModell || !embedModell)) throw ungueltig('Bitte Chat- und Einbettungsmodell angeben (bei diesem Anbieter gibt es keine Vorgabe).');
    const name = v?.id ?? 'eigen';
    const block: KiBlock = managed
      ? { art, anbieter: v!.id, voreinstellung: v!.id, weg: 'eigener_schluessel', status: 'ungeprueft', vorher, ...(b.chatModell ? { chatModell } : {}), ...(b.embedModell ? { embedModell } : {}) }
      : { art, url: b.url ?? v!.url, chatModell, embedModell, anbieter: name, voreinstellung: v?.id ?? null, weg: 'eigener_schluessel', status: 'ungeprueft', vorher, ...(art === 'anthropic' ? { embed: { art: 'mock' } } : {}) };
    let test = k.ki.provider(block);
    if (b.schluessel) {
      if (test.art === 'openai') test = { ...test, apiKey: b.schluessel };
      else if (test.art === 'anthropic') test = { ...test, apiKey: b.schluessel };
      else if (test.art === 'mock' && art === 'anthropic') test = { art: 'anthropic', apiKey: b.schluessel, chatModell: chatModell ?? 'claude-sonnet-4-5', embed: { art: 'mock' } };
    }
    if (art === 'anthropic' && test.art !== 'anthropic') throw ungueltig('Für Anthropic ist ein Schlüssel nötig.');
    return { block, test, schluesselName: b.schluessel ? name : null };
  };

  app.put('/api/einrichtung/ki', async (c) => {
    nurAdmin(c);
    const u = user(c);
    if (k.ki.festDurchUmgebung) throw new KernFehler(409, 'Der KI-Anbieter ist vom Betreiber fest eingestellt (Umgebung KERN_PROVIDER).', 'fest');
    const b = await k.json(c, kiSchema);
    const { block, test, schluesselName } = baueKi(b);
    if (schluesselName && !k.geheimnisse.verfuegbar) {
      throw new KernFehler(409, 'Schlüssel lassen sich hier nur über die Umgebung setzen (KERN_PROVIDER_KEY…), weil KERN_GEHEIMNIS_SCHLUESSEL fehlt.', 'nicht_eingerichtet');
    }
    const t = typeof kern.pruefeVerbindung === 'function' ? await kern.pruefeVerbindung(test) : await testeVerbindung(test, k.abruf);
    if (!t.ok) return c.json({ verbindung: 'fehler', meldung: t.meldung, datenweg: null });
    if (schluesselName) { k.geheimnisse.setze(schluesselName, b.schluessel!); k.prot(c, 'ki_schluessel', u.id, 'ok', schluesselName); }
    const { sofort } = await k.ki.speichere(u, block);
    k.prot(c, 'einstellungen', u.id, 'ok', 'einrichtung:ki');
    const datenweg = typeof kern.datenweg === 'function' && sofort ? await kern.datenweg(u) : bauDatenweg(k.ki.provider(block));
    const app_ = b.weg === 'app' ? `Trage in deiner App diese MCP-Adresse ein: ${k.basisUrl(c)}/mcp. Die App meldet sich dann per OAuth selbst an. ` : '';
    return c.json({
      verbindung: 'ok',
      meldung: `${app_}${t.meldung}${sofort ? '' : ' Wirksam nach einem Neustart des Servers.'}`,
      datenweg,
      ki: k.ki.ansicht(),
      // F12/Drittland: sachlicher Satz zur gewählten Voreinstellung, kein Warndialog (Till 07:12).
      datenfluss: voreinstellungen().find((x) => x.id === block.voreinstellung)?.datenfluss ?? null,
      sofort,
      ...(b.weg === 'app' ? { mcp_adresse: `${k.basisUrl(c)}/mcp` } : {}),
    });
  });

  app.post('/api/einrichtung/beispiel', async (c) => {
    nurAdmin(c);
    const b = await k.json(c, z.object({ aktion: z.enum(['laden', 'entfernen']) }).strict());
    const fn = b.aktion === 'laden' ? kern.beispielLaden : kern.beispielEntfernen;
    if (typeof fn !== 'function') throw nichtDa('Diese core-Version hat noch keine Beispielsammlung (v1.4 4.3).');
    await fn.call(kern, user(c));
    return c.json(await einrichtungAnsicht(user(c)));
  });

  app.post('/api/einrichtung/fertig', async (c) => {
    nurAdmin(c);
    k.einrichtung.fertig();
    return c.json(await einrichtungAnsicht(user(c)));
  });

  // ================= 8.2 Rückweg =================
  app.post('/api/einstellungen/ki/zurueck', async (c) => {
    nurAdmin(c);
    if (k.ki.festDurchUmgebung) throw new KernFehler(409, 'Der KI-Anbieter ist vom Betreiber fest eingestellt.', 'fest');
    const jetzt = k.ki.lies();
    if (!jetzt.vorher) throw new KernFehler(409, 'Es gibt keinen gespeicherten vorherigen Anbieter.', 'kein_rueckweg');
    const neu: KiBlock = { ...jetzt.vorher, status: jetzt.vorher.art === 'mock' ? 'ohne_ki' : 'ungeprueft', vorher: ohneGeheimnis(jetzt) };
    const { sofort } = await k.ki.speichere(user(c), neu);
    k.prot(c, 'einstellungen', user(c).id, 'ok', 'ki:zurueck');
    return c.json({ ...k.einstellungenAnsicht(user(c)), hinweis: sofort ? 'Vorheriger Anbieter ist wieder aktiv. Bitte die Prüfbank laufen lassen.' : 'Vorheriger Anbieter gespeichert, wirksam nach einem Neustart.' });
  });

  // ================= 7.1 Export =================
  const exportSchema = z.object({ art: z.enum(['okf', 'zip', 'umzugspaket']), passphrase: z.string().max(500).optional() }).strict();
  app.post('/api/export', async (c) => {
    const u = user(c);
    const b = await k.json(c, exportSchema);
    const a = k.exporte.starte(kern, u, b.art as ExportArt, { passphrase: b.passphrase });
    k.prot(c, 'export', u.id, 'ok', `${b.art}:${a.id}`);
    return c.json({ id: a.id, status: a.status }, 202);
  });
  app.get('/api/export', (c) => c.json(k.exporte.liste(user(c)).map((a) => k.exporte.ansicht(a))));
  app.get('/api/export/:id', (c) => {
    const a = k.exporte.hole(c.req.param('id'));
    if (!a || !k.exporte.darfSehen(user(c), a)) throw nichtGefunden('Export nicht gefunden.');
    return c.json(k.exporte.ansicht(a));
  });
  app.get('/api/export/:id/datei', async (c) => {
    const a = k.exporte.hole(c.req.param('id'));
    if (!a || !k.exporte.darfSehen(user(c), a) || !k.exporte.pruefeSignatur(a, c.req.query('sig') ?? '')) throw nichtGefunden('Export nicht gefunden.');
    if (a.bereit_bis && Date.parse(a.bereit_bis) < Date.now()) throw nichtGefunden('Der Link ist abgelaufen. Bitte neu exportieren.');
    const datei = k.exporte.datei(a);
    if (!datei) throw nichtGefunden('Export nicht gefunden.');
    k.prot(c, 'export', user(c).id, 'ok', `download:${a.id}`);
    const name = a.datei!;
    return new Response(fs.createReadStream(datei) as unknown as ReadableStream, {
      headers: {
        'Content-Type': a.art === 'umzugspaket' ? 'application/octet-stream' : 'application/zip',
        'Content-Length': String(a.bytes ?? fs.statSync(datei).size),
        'Content-Disposition': `attachment; filename="${name}"`,
        'Cache-Control': 'private, no-store',
        'Content-Security-Policy': "default-src 'none'; sandbox",
      },
    });
  });

  // ================= Import (v1.2 Importe, v1.4 kern-zip) =================
  app.post('/api/importieren',
    bodyLimit({ maxSize: config.maxUploadBytes, onError: (c) => c.json({ fehler: `Datei zu groß (höchstens ${Math.round(config.maxUploadBytes / 1048576)} MB).`, code: 'zu_gross' }, 413) }),
    async (c) => {
      k.pruefeRecht(c, 'hinzufuegen');
      const u = user(c);
      const typ = c.req.header('content-type') ?? '';
      if (!typ.startsWith('multipart/form-data') && !typ.startsWith('application/json')) throw new KernFehler(415, 'Erwartet multipart/form-data oder JSON.');
      const roh: Record<string, unknown> = typ.startsWith('multipart/') ? await c.req.parseBody() : ((await c.req.json().catch(() => null)) ?? {});
      const art = String(roh.art ?? '') as ImportArt;
      if (!IMPORT_ARTEN.includes(art)) throw ungueltig(`art: ${IMPORT_ARTEN.join(', ')}`);
      if (art === 'kern-zip' && !u.rollen.includes('admin')) throw keineRechte('Ein Kern-Export lässt sich nur als Admin einspielen.');
      const sammlung = typeof roh.sammlung === 'string' && /^[\p{L}\p{N}_ -]{1,120}$/u.test(roh.sammlung) ? roh.sammlung : 'import';
      const sichtbarkeit = (typeof roh.sichtbarkeit === 'string' && /^(ich|betrieb|team:[\p{L}\p{N}_ -]{1,60})$/u.test(roh.sichtbarkeit) ? roh.sichtbarkeit : 'betrieb') as Sichtbarkeit;
      if (sichtbarkeit.startsWith('team:') && !u.rollen.includes('admin') && !u.teams.includes(sichtbarkeit.slice(5))) throw keineRechte('Du bist nicht in diesem Team.');
      if (typeof kern.importiere !== 'function' && !(art === 'okf' && typeof kern.importiereOkf === 'function')) throw nichtDa(`Diese core-Version kann „${art}“ noch nicht importieren.`);
      const sp = k.betrieb.grenzen.speicher_max_bytes;
      if (sp !== null && k.betrieb.speicherBytes() >= sp) throw Object.assign(new KernFehler(429, 'Der Speicher eures Pakets ist voll. Suche und Wissen laufen weiter.', 'kontingent'), { grund: 'speicher' });
      if (config.kern.provider.art !== 'mock') await k.kiFreigabe(u, 'ki');
      let tmp: string | null = null;
      let pfad: string;
      try {
        const datei = roh.datei;
        if (datei instanceof File) {
          if (datei.size > Math.min(config.maxUploadBytes, k.betrieb.grenzen.upload_max_bytes ?? Infinity)) throw new KernFehler(413, 'Datei zu groß.');
          tmp = path.join(config.dataDir, '.kern', 'upload', crypto.randomBytes(8).toString('hex'));
          await fsp.mkdir(tmp, { recursive: true });
          const name = path.basename(datei.name.replace(/\\/g, '/')).replace(/[^\p{L}\p{N}._ -]/gu, '_').replace(/^\.+/, '').slice(-120) || 'import';
          pfad = path.join(tmp, name);
          await fsp.writeFile(pfad, Buffer.from(await datei.arrayBuffer()));
        } else if (typeof roh.pfad === 'string' && roh.pfad) {
          // Pfad auf dem Server: nur Admins im Selbstbetrieb (eigener Rechner), nie im Managed-Betrieb.
          if (!u.rollen.includes('admin') || config.modus === 'managed') throw keineRechte('Ein Pfad auf dem Server geht nur für Admins im Selbstbetrieb. Bitte die Datei hochladen.');
          pfad = path.resolve(roh.pfad);
          if (pfad === config.dataDir || pfad.startsWith(config.dataDir + path.sep)) throw ungueltig('Der Pfad darf nicht im Datenordner liegen.');
          if (!fs.existsSync(pfad)) throw nichtGefunden('Diesen Pfad gibt es auf dem Server nicht.');
        } else throw ungueltig('Datei fehlt (Feld "datei").');
        const r = (typeof kern.importiere === 'function'
          ? await kern.importiere(u, { art, pfad, sammlung, sichtbarkeit } as never)
          : await kern.importiereOkf!(u, pfad)) as { quellen?: unknown[] | number; vorschlaege?: unknown[] | number; uebersprungen?: unknown[]; hinweise?: string[] } | undefined;
        const zahl = (x: unknown[] | number | undefined) => (Array.isArray(x) ? x.length : typeof x === 'number' ? x : 0);
        k.prot(c, 'einstellungen', u.id, 'ok', `import:${art}`);
        return c.json({
          quellen: zahl(r?.quellen), vorschlaege: zahl(r?.vorschlaege),
          hinweise: [...(r?.hinweise ?? []), ...(r?.uebersprungen?.length ? [`${r.uebersprungen.length} Dateien übersprungen.`] : []), 'Importiertes kommt als Quellen und Vorschläge; ins Wissen kommt nur, was ihr freigebt.'],
        }, 201);
      } finally {
        if (tmp) await fsp.rm(tmp, { recursive: true, force: true }).catch(() => {});
      }
    });

  // ================= 8.1 Prüfbank =================
  const laeufe = new Map<string, { status: 'laeuft' | 'fehler'; am: string; fehler?: string; ergebnis?: PruefbankLauf }>();
  const kurz = (l: PruefbankLauf) => ({
    id: l.id, am: l.am, status: 'fertig' as const, satz: l.satz, anbieter: l.anbieter ?? null, modell: l.modell ?? null,
    belegtreue: l.kennzahlen?.belegtreue ?? null, lecks: l.kennzahlen?.lecks ?? null, injektion: l.kennzahlen?.injektionsfest ?? null, bestanden: l.bestanden ?? null,
  });
  const alleLaeufe = async (u: User): Promise<PruefbankLauf[]> => {
    const ausCore = typeof kern.pruefbankLaeufe === 'function' ? await kern.pruefbankLaeufe(u) : [];
    const ausSpeicher = [...laeufe.values()].map((x) => x.ergebnis).filter((x): x is PruefbankLauf => !!x && !ausCore.some((y) => y.id === x.id));
    return [...ausCore, ...ausSpeicher].sort((a, b) => b.am.localeCompare(a.am));
  };

  app.post('/api/pruefbank/lauf', async (c) => {
    nurAdmin(c);
    const u = user(c);
    const b = await k.json(c, z.object({ satz: z.enum(['oeffentlich', 'betrieb']).default('oeffentlich') }).strict());
    if (typeof kern.pruefbank !== 'function') throw nichtDa('Die Prüfbank kommt mit core (v1.4 8.1). Bis dahin: npm run pruefung im Paket core.');
    if ([...laeufe.values()].some((x) => x.status === 'laeuft' && !x.ergebnis)) throw new KernFehler(409, 'Es läuft schon eine Prüfung.', 'laeuft');
    if (config.kern.provider.art !== 'mock') await k.kiFreigabe(u, 'ki');
    const id = zufall('p');
    const am = new Date().toISOString();
    const providerVorher = JSON.stringify(config.kern.provider);
    laeufe.set(id, { status: 'laeuft', am });
    void (async () => {
      try {
        const l = await kern.pruefbank!(u, { satz: b.satz });
        // 8.2: Status nur setzen, wenn der Anbieter während des Laufs nicht gewechselt hat.
        if (JSON.stringify(config.kern.provider) === providerVorher && config.kern.provider.art !== 'mock') {
          await k.ki.setzeStatus(u, (l.bestanden ? 'geprueft' : 'unter_schwelle') as KiStatus).catch(() => {});
        }
        laeufe.set(id, { status: 'laeuft', am, ergebnis: l });
      } catch (e) {
        const sf = statusAusFehler(e);
        laeufe.set(id, { status: 'fehler', am, fehler: sf.status < 500 ? sf.meldung : 'Die Prüfung ist abgebrochen.' });
      }
    })();
    return c.json({ id, am, status: 'laeuft', satz: b.satz, anbieter: null, modell: null, belegtreue: null, lecks: null, injektion: null, bestanden: null }, 202);
  });

  app.get('/api/pruefbank', async (c) => {
    nurAdmin(c);
    const u = user(c);
    const liste = await alleLaeufe(u);
    const offen = [...laeufe.entries()].find(([, x]) => x.status === 'laeuft' && !x.ergebnis);
    if (!liste.length && !offen) throw nichtGefunden(typeof kern.pruefbank === 'function' ? 'Noch kein Prüfbank-Lauf.' : 'Die Prüfbank kommt mit core (v1.4 8.1).');
    let vergleich: string | null = null;
    try { vergleich = await fsp.readFile(path.join(config.dataDir, 'pruefung', 'vergleich.md'), 'utf8'); } catch { /* keiner */ }
    // Contract: „Läufe, Vergleich“. Zusätzlich oben die Kurzform des neuesten Laufs (Annahme W2 3), damit die Karte ohne Umbau läuft.
    const oben = offen ? { id: offen[0], am: offen[1].am, status: 'laeuft' as const, anbieter: null, modell: null, belegtreue: null, lecks: null, injektion: null, bestanden: null } : kurz(liste[0]!);
    return c.json({ ...oben, ki_status: k.ki.status(), laeufe: liste.map(kurz), vergleich });
  });

  // 8.1: geschätzte Kosten vor dem Start (die UI nennt sie, bevor jemand startet).
  app.get('/api/pruefbank/schaetzung', async (c) => {
    nurAdmin(c);
    const satz = c.req.query('satz') === 'betrieb' ? 'betrieb' : 'oeffentlich';
    if (typeof kern.pruefbankSchaetzung !== 'function') throw nichtDa('Die Kostenschätzung kommt mit der Prüfbank in core (v1.4 8.1).');
    return c.json({ satz, ...(await kern.pruefbankSchaetzung(user(c), { satz })) });
  });

  app.get('/api/pruefbank/:id', async (c) => {
    nurAdmin(c);
    const id = c.req.param('id');
    const j = laeufe.get(id);
    if (j?.ergebnis) return c.json({ ...j.ergebnis, status: 'fertig' });
    if (j) return c.json({ id, am: j.am, status: j.status, ...(j.fehler ? { fehler: j.fehler } : {}) }, j.status === 'laeuft' ? 202 : 200);
    const l = (await alleLaeufe(user(c))).find((x) => x.id === id);
    if (!l) throw nichtGefunden('Lauf nicht gefunden.');
    return c.json({ ...l, status: 'fertig' });
  });

  // ================= 9 Kontextbilanz =================
  app.get('/api/kontextbilanz', async (c) => {
    k.pruefeRecht(c, 'entscheiden');
    if (typeof kern.kontextbilanz !== 'function') throw nichtDa('Die Kontextbilanz kommt mit core (v1.4 9).');
    return c.json(await kern.kontextbilanz(user(c)));
  });

  // ================= 7.3 Ausstiegsprobe =================
  let probeLaeuft: Promise<unknown> | null = null;
  let probeFehler: string | null = null;
  const letzteProbe = async (): Promise<Record<string, unknown> | null> => {
    const lp = (kern as { letzteAusstiegsprobe?: () => unknown }).letzteAusstiegsprobe;
    if (typeof lp === 'function') { try { const r = await lp.call(kern); if (r) return r as Record<string, unknown>; } catch { /* Rückfall: Datei */ } }
    const ordner = path.join(config.dataDir, 'pruefung', 'ausstieg');
    let namen: string[] = [];
    try { namen = (await fsp.readdir(ordner)).filter((n) => n.endsWith('.json')).sort(); } catch { return null; }
    const letzte = namen.at(-1);
    if (!letzte) return null;
    try { return JSON.parse(await fsp.readFile(path.join(ordner, letzte), 'utf8')) as Record<string, unknown>; } catch { return null; }
  };
  app.post('/api/ausstiegsprobe', async (c) => {
    nurAdmin(c);
    if (typeof kern.ausstiegsprobe !== 'function') throw nichtDa('Die Ausstiegsprobe kommt mit core (v1.4 7.3). Bis dahin: kern umzug packen und kern umzug pruefen.');
    if (probeLaeuft) throw new KernFehler(409, 'Die Ausstiegsprobe läuft schon.', 'laeuft');
    probeFehler = null;
    const u = user(c);
    probeLaeuft = kern.ausstiegsprobe(u)
      .catch((e) => { const sf = statusAusFehler(e); probeFehler = sf.status < 500 ? sf.meldung : 'Die Ausstiegsprobe ist abgebrochen.'; })
      .finally(() => { probeLaeuft = null; });
    k.prot(c, 'export', u.id, 'ok', 'ausstiegsprobe');
    return c.json({ status: 'laeuft' }, 202);
  });
  app.get('/api/ausstiegsprobe', async (c) => {
    nurAdmin(c);
    if (probeLaeuft) return c.json({ status: 'laeuft' }, 202);
    const l = await letzteProbe();
    if (!l) throw nichtGefunden(probeFehler ?? 'Noch keine Ausstiegsprobe.');
    return c.json({ ...l, ...(probeFehler ? { letzter_fehler: probeFehler } : {}) });
  });

  // ================= 8.5 Abgelaufene Agenten-Notizen (nur die eigenen) =================
  // core `notizenAblauf(u)` liefert Pfade relativ zu /memories/notizen; ein Eingangs-Vorschlag ist dort nicht möglich
  // (Ziel liegt nicht unter wissen/), deshalb zeigt der Server die Liste und löscht auf Wunsch über den Adapter.
  const ablaufTage = () => {
    const y = leseKernYaml(config.dataDir) as { notizen?: { ablauf_tage?: number } };
    return Number(y.notizen?.ablauf_tage ?? 90);
  };
  app.get('/api/ich/notizen/abgelaufen', async (c) => {
    if (typeof kern.notizenAblauf !== 'function') throw nichtDa('Abgelaufene Notizen kommen mit core (v1.4 8.5).');
    const pfade = await kern.notizenAblauf(user(c));
    return c.json({ ablauf_tage: ablaufTage(), pfade: pfade.map((p) => `/memories/notizen/${p}`) });
  });
  app.post('/api/ich/notizen/abgelaufen/loeschen', async (c) => {
    const u = user(c);
    k.pruefeRecht(c, 'vorschlagen');
    const b = await k.json(c, z.object({ pfade: z.array(z.string().min(1).max(1024)).max(500).optional() }).strict());
    if (typeof kern.notizenAblauf !== 'function' || typeof kern.gedaechtnis !== 'function') throw nichtDa('Abgelaufene Notizen kommen mit core (v1.4 8.5).');
    const abgelaufen = (await kern.notizenAblauf(u)).map((p) => `/memories/notizen/${p}`);
    // Nur, was wirklich abgelaufen ist und dem Menschen selbst gehört (core bildet /memories/notizen auf nutzer/<eigene id>/ ab).
    const ziel = b.pfade ? abgelaufen.filter((p) => b.pfade!.includes(p)) : abgelaufen;
    const geloescht: string[] = [];
    const fehler: { pfad: string; meldung: string }[] = [];
    for (const p of ziel) {
      const r = await kern.gedaechtnis(u, { command: 'delete', path: p });
      if (r.ok) geloescht.push(p); else fehler.push({ pfad: p, meldung: r.text });
    }
    return c.json({ geloescht, fehler, nicht_abgelaufen: (b.pfade ?? []).filter((p) => !abgelaufen.includes(p)) });
  });

  // ================= 8.3 Kontextpaket =================
  app.get('/api/kontextpaket', async (c) => {
    const frage = (c.req.query('frage') ?? '').trim() || undefined;
    const thema = (c.req.query('thema') ?? '').trim() || undefined;
    if (!frage && !thema) throw ungueltig('frage oder thema angeben.');
    if ((frage?.length ?? 0) > 2000 || (thema?.length ?? 0) > 200) throw ungueltig('frage oder thema zu lang.');
    const budget = Math.min(Math.max(Number(c.req.query('budget') ?? 4000) || 4000, 200), 64_000);
    if (typeof kern.kontextpaket !== 'function') throw nichtDa('Das Kontextpaket kommt mit core (v1.4 8.3).');
    const rw = c.req.query('reichweite') || undefined;
    if (rw && !['ich', 'team', 'betrieb'].includes(rw)) throw ungueltig('reichweite: ich, team oder betrieb');
    const p = await kern.kontextpaket(user(c), { frage, thema, budgetTokens: budget, mitFakten: c.req.query('fakten') !== '0', ...(rw ? { reichweite: rw as 'ich' | 'team' | 'betrieb' } : {}) });
    return c.json({ ki_erzeugt: false, modell: null, ...p });
  });

  // ================= v1.3 Lesen (die Oberfläche ruft diese Endpunkte) =================
  app.get('/api/heute', async (c) => {
    if (typeof kern.heute !== 'function') throw nichtDa('Diese core-Version hat noch keine Heute-Seite.');
    const stil = c.req.query('stil');
    if (stil && !['zusammenfassung', 'entscheidung', 'fokus'].includes(stil)) throw ungueltig('stil: zusammenfassung, entscheidung oder fokus');
    const seit = c.req.query('seit') || undefined;
    if (seit && !/^\d{4}-\d{2}-\d{2}/.test(seit)) throw ungueltig('seit: Datum JJJJ-MM-TT');
    return c.json(await kern.heute(user(c), { stil, seit }));
  });
  app.post('/api/gelesen', async (c) => {
    const b = await k.json(c, z.object({ objekt: z.string().min(1).max(300), punkt: z.string().max(40).optional(), stufe: z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4)]) }).strict());
    if (typeof kern.lesestand !== 'function') return c.body(null, 204);
    await kern.lesestand(user(c), b);
    return c.body(null, 204);
  });
  app.get('/api/lesen', async (c) => {
    if (typeof kern.leseEinstellungen !== 'function') throw nichtDa('Diese core-Version hat noch keine Leseeinstellungen.');
    return c.json(await kern.leseEinstellungen(user(c)));
  });
  app.put('/api/lesen', async (c) => {
    if (typeof kern.setzeLeseEinstellungen !== 'function') throw nichtDa('Diese core-Version hat noch keine Leseeinstellungen.');
    const b = await k.json(c, z.record(z.string(), z.unknown()));
    return c.json(await kern.setzeLeseEinstellungen(user(c), b));
  });
  app.get('/api/lesebilanz', async (c) => {
    if (typeof kern.lesebilanz !== 'function') throw nichtDa('Diese core-Version hat noch keine Lesebilanz.');
    return c.json(await kern.lesebilanz(user(c)));
  });
  app.post('/api/ansichten', async (c) => {
    const b = await k.json(c, z.object({ zweck: z.enum(['briefing', 'thema', 'entscheidungsvorlage', 'vertretung', 'agentenbericht', 'antwort']), thema: z.string().max(200).optional(), seit: z.string().regex(/^\d{4}-\d{2}-\d{2}/).optional() }).strict());
    if (typeof kern.ansicht !== 'function') throw nichtDa('Diese core-Version hat noch keine Ansichten.');
    if (config.kern.provider.art !== 'mock') await k.kiFreigabe(user(c), 'ki');
    const a = await kern.ansicht(user(c), b);
    const kopf = (a as { kopf?: Record<string, unknown> }).kopf ?? a;
    return c.json({ ki_erzeugt: true, modell: null, ...kopf }, 201);
  });
  app.post('/api/einschaetzung', () => { throw nichtDa('„Erst du, dann ich“ (Abgleich) ist in core noch nicht gebaut (v1.3 Schritt 4, Fahrplan).'); });
  app.post('/api/fehler', () => { throw nichtDa('Das Fehlerbuch kommt mit Stufe 3 (v1.4 Fahrplan).'); });
}
