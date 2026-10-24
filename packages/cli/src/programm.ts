import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import readline from 'node:readline';
import { Command, CommanderError, Option } from 'commander';
import {
  ladeKonfiguration, leseKernYaml, schreibeKernYaml, oeffneKern, starteServer, statusAusFehler, waehleZugang, ALLE_SCOPES, VERSION,
  agentenScopes, sammelEntscheiden, freigebenErlaubt,
  type Scope,
  type Antwort, type ImportArt, type KernLike, type Rolle, type ServerConfig, type Sichtbarkeit, type User, IMPORT_ARTEN, ROLLEN,
} from '@kern/server';
import { sammleDateien, schreibeZip } from './zip.js';
import { pruefeBestand } from './pruefen.js';
import { starteBruecke, starteStdio } from './mcp-lokal.js';
import { auspacken, packen, pruefen as pruefeUmzug } from './umzug.js';

export interface Io {
  out: (s: string) => void;
  err: (s: string) => void;
  env: NodeJS.ProcessEnv;
  /** Für Tests: Passwort ohne Eingabe. */
  passwort?: string;
}

const standardIo = (): Io => ({ out: (s) => process.stdout.write(s), err: (s) => process.stderr.write(s), env: process.env });

class Abbruch extends Error {
  constructor(message: string, public code = 1) { super(message); }
}

async function liesPasswort(io: Io, frage: string): Promise<string> {
  if (io.passwort) return io.passwort;
  if (io.env.KERN_PASSWORT) return io.env.KERN_PASSWORT;
  if (!process.stdin.isTTY) {
    const rl = readline.createInterface({ input: process.stdin });
    for await (const zeile of rl) { rl.close(); return zeile; }
    throw new Abbruch('Kein Passwort erhalten (stdin leer).');
  }
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    const rlx = rl as unknown as { _writeToOutput: (s: string) => void };
    rl.question(frage, (a) => { rl.close(); process.stdout.write('\n'); resolve(a); });
    rlx._writeToOutput = (s: string) => { if (s.includes(frage)) process.stdout.write(s); };
  });
}

const liste = (s: string | undefined) => (s ? s.split(',').map((x) => x.trim()).filter(Boolean) : []);

function formatAntwort(a: Antwort): string {
  if (a.status !== 'beantwortet') return `${a.status === 'steht_nicht_drin' ? 'Steht nicht drin.' : 'Gehört nicht hierher.'}${a.hinweis ? ` ${a.hinweis}` : ''}\n`;
  let s = '';
  for (const p of a.punkte) s += `• ${p.text} ${p.belege.map((b) => `[${b + 1}]`).join('')}\n`;
  s += '\nBelege:\n';
  a.belege.forEach((b, i) => { s += `[${i + 1}] ${b.quelle} › ${b.abschnitt} (Z. ${b.zeilen[0]}–${b.zeilen[1]})\n    „${b.zitat.replace(/\s+/g, ' ').slice(0, 160)}“\n`; });
  if (a.hinweis) s += `\n${a.hinweis}\n`;
  return s;
}

export function baueProgramm(io: Io = standardIo()): Command {
  const p = new Command();
  p.name('kern')
    .description('Kern: Firmenwissen als Markdown-Ordner mit belegten Antworten. Befehle wirken direkt auf den Datenordner.')
    .version(VERSION, '-v, --version', 'Version anzeigen')
    .helpOption('-h, --help', 'Hilfe anzeigen')
    .addHelpCommand('hilfe [befehl]', 'Hilfe zu einem Befehl anzeigen')
    .option('-d, --daten <ordner>', 'Datenordner (Standard: KERN_DATA oder ./kern-data)')
    .option('--als <name>', 'Als dieser Benutzer handeln (Standard: KERN_ALS oder der erste Admin)')
    .option('--fake', 'Attrappe statt @kern/core verwenden (wie KERN_FAKE=1)')
    .showHelpAfterError('(Hilfe mit: kern --help)')
    .configureOutput({ writeOut: io.out, writeErr: io.err })
    .configureHelp({
      styleTitle: (t: string) => ({ 'Usage:': 'Aufruf:', 'Options:': 'Optionen:', 'Commands:': 'Befehle:', 'Arguments:': 'Argumente:', 'Global Options:': 'Allgemeine Optionen:' })[t] ?? t,
      optionDescription(o) {
        const basis = o.description ?? '';
        const extra: string[] = [];
        if (o.argChoices) extra.push(`erlaubt: ${o.argChoices.join(', ')}`);
        if (o.defaultValue !== undefined && o.defaultValue !== false && o.defaultValue !== '') extra.push(`Standard: ${JSON.stringify(o.defaultValue)}`);
        return extra.length ? `${basis} (${extra.join('; ')})` : basis;
      },
    })
    .exitOverride();

  const g = () => p.opts<{ daten?: string; als?: string; fake?: boolean }>();

  const konfig = (fuerServer = false): ServerConfig => {
    const env = { ...io.env };
    if (g().fake) env.KERN_FAKE = '1';
    if (!fuerServer && !env.KERN_SECRET) env.KERN_SECRET = crypto.randomBytes(32).toString('hex');
    return ladeKonfiguration({ dataDir: g().daten ?? env.KERN_DATA, env });
  };

  const oeffne = async (opt: { mussExistieren?: boolean } = { mussExistieren: true }) => {
    const config = konfig();
    if (opt.mussExistieren !== false && !fs.existsSync(config.dataDir)) throw new Abbruch(`Datenordner ${config.dataDir} gibt es nicht. Anlegen mit: kern init <ordner>`);
    const kern = await oeffneKern(config.kern, config.fake);
    return { config, kern };
  };

  const handelnder = async (kern: KernLike): Promise<User> => {
    const name = g().als ?? io.env.KERN_ALS;
    const alle = await kern.benutzer.liste();
    if (name) {
      const u = alle.find((x) => x.name === name);
      if (!u) throw new Abbruch(`Benutzer "${name}" gibt es nicht.`);
      return u;
    }
    return alle.find((x) => x.rollen.includes('admin')) ?? { id: 'cli', name: 'cli', rollen: ['admin'], teams: [] };
  };

  const json = (x: unknown) => io.out(`${JSON.stringify(x, null, 2)}\n`);

  // ---------- init ----------
  p.command('init')
    .description('Neuen Datenordner anlegen (kern.yaml, Ordner, git) und optional einen Admin')
    .argument('<ordner>', 'Zielordner, wird angelegt')
    .option('--betrieb <name>', 'Name des Betriebs', 'Mein Betrieb')
    .option('--admin <name>', 'Gleich einen Admin anlegen (Passwort per Eingabe oder KERN_PASSWORT)')
    .option('--beispieldaten', 'Erfundenen Beispielbetrieb laden (nur für Vorführungen). Passwörter werden zufällig erzeugt und einmal angezeigt.')
    .action(async (ordner: string, o: { betrieb: string; admin?: string; beispieldaten?: boolean }) => {
      const dir = path.resolve(ordner);
      if (o.beispieldaten) {
        if (fs.existsSync(path.join(dir, 'kern.yaml'))) throw new Abbruch('Beispieldaten nur in einen neuen, leeren Ordner.');
        await ladeBeispiel(dir, io);
        return;
      }
      fs.mkdirSync(dir, { recursive: true });
      if (!fs.existsSync(path.join(dir, 'kern.yaml'))) {
        schreibeKernYaml(dir, { betrieb: o.betrieb, sprache: 'de', teams: [], provider: { art: 'mock' } });
      }
      const env = { ...io.env, KERN_SECRET: io.env.KERN_SECRET ?? crypto.randomBytes(32).toString('hex'), ...(g().fake ? { KERN_FAKE: '1' } : {}) };
      const config = ladeKonfiguration({ dataDir: dir, env });
      const kern = await oeffneKern(config.kern, config.fake);
      io.out(`Datenordner angelegt: ${dir}\n`);
      if (o.admin) {
        const pw = await liesPasswort(io, `Passwort für ${o.admin}: `);
        if (pw.length < 10) throw new Abbruch('Passwort: mindestens 10 Zeichen.');
        const u = await kern.benutzer.anlegen(o.admin, pw, ['admin']);
        io.out(`Admin angelegt: ${u.name} (${u.id})\n`);
      }
      io.out(`Start: kern -d ${ordner} serve\n`);
    });

  // ---------- nutzer ----------
  const nutzer = p.command('nutzer').description('Benutzer verwalten');
  nutzer.command('anlegen')
    .description('Benutzer anlegen (Passwort per Eingabe oder KERN_PASSWORT)')
    .argument('<name>', 'Anmeldename')
    .option('-r, --rollen <liste>', `Rollen, kommagetrennt: ${ROLLEN.join(', ')}`, 'leser')
    .option('-t, --teams <liste>', 'Teams, kommagetrennt', '')
    .option('--passwort-aendern', 'beim ersten Anmelden muss ein eigenes Passwort gesetzt werden (z. B. Erstzugang aus dem Log)')
    .action(async (name: string, o: { rollen: string; teams: string; passwortAendern?: boolean }) => {
      const { kern } = await oeffne();
      const rollen = liste(o.rollen);
      const falsch = rollen.filter((r) => !ROLLEN.includes(r as Rolle));
      if (falsch.length || rollen.length === 0) throw new Abbruch(`Unbekannte Rolle: ${falsch.join(', ') || '(keine)'}. Erlaubt: ${ROLLEN.join(', ')}`);
      if ((await kern.benutzer.liste()).some((u) => u.name === name)) throw new Abbruch(`Benutzer "${name}" gibt es schon.`);
      const pw = await liesPasswort(io, `Passwort für ${name}: `);
      if (pw.length < 10) throw new Abbruch('Passwort: mindestens 10 Zeichen.');
      const u = await kern.benutzer.anlegen(name, pw, rollen as Rolle[], liste(o.teams));
      if (o.passwortAendern || /^(1|true|ja)$/i.test(io.env.KERN_PASSWORT_AENDERN ?? '')) {
        if (typeof kern.benutzer.aendere !== 'function') throw new Abbruch('Diese core-Version kann die Pflicht zum Passwortwechsel nicht setzen.');
        await kern.benutzer.aendere(u.id, { mussPasswortAendern: true });
      }
      io.out(`Benutzer angelegt: ${u.name} (${u.id}), Rollen: ${u.rollen.join(', ')}\n`);
    });
  nutzer.command('liste').description('Benutzer auflisten').option('--json', 'Ausgabe als JSON')
    .action(async (o: { json?: boolean }) => {
      const { kern } = await oeffne();
      const l = await kern.benutzer.liste();
      if (o.json) return json(l);
      for (const u of l) io.out(`${u.name}\t${u.id}\t${u.rollen.join(',')}\t${u.teams.join(',')}\n`);
    });

  // ---------- token ----------
  const token = p.command('token').description('MCP-Zugangstoken verwalten (je Benutzer)');
  token.command('anlegen').description('Token für einen Benutzer erzeugen (handelt als dieser Benutzer), wird nur einmal angezeigt')
    .argument('<name>', 'Benutzername')
    .option('-b, --bezeichnung <text>', 'Wofür das Token ist, z. B. "Claude Desktop"', 'MCP')
    .option('--scopes <liste>', `Scopes, kommagetrennt: ${ALLE_SCOPES.join(', ')}`, 'kern:lesen,kern:fragen')
    .option('--tage <zahl>', 'Gültigkeit in Tagen (1 bis 365)', '90')
    .option('--agent <name>', 'Agenten-Zugang (v1.4 8.4): Vorschläge tragen von: agent/<name>@<benutzer>, Scopes fest nach --profil')
    .option('--profil <profil>', 'Agentenprofil: leser (lesen, fragen) oder autor (dazu vorschlagen, bericht)')
    .option('--reichweite <r>', 'Einschränkung des Zugangs: ich, team oder betrieb')
    .action(async (name: string, o: { bezeichnung: string; scopes: string; tage: string; agent?: string; profil?: string; reichweite?: string }) => {
      const { kern, config } = await oeffne();
      const u = (await kern.benutzer.liste()).find((x) => x.name === name);
      if (!u) throw new Abbruch(`Benutzer "${name}" gibt es nicht.`);
      if (o.reichweite && !['ich', 'team', 'betrieb'].includes(o.reichweite)) throw new Abbruch('--reichweite: ich, team oder betrieb.');
      if (o.profil && !o.agent) throw new Abbruch('--profil gibt es nur zusammen mit --agent.');
      if (o.profil && !['leser', 'autor'].includes(o.profil)) throw new Abbruch('--profil: leser oder autor.');
      if (o.profil === 'autor' && !u.rollen.some((r) => r !== 'leser')) throw new Abbruch(`Das Profil autor braucht die Rolle autor; ${u.name} ist nur leser.`);
      const scopes = o.agent ? agentenScopes((o.profil ?? 'leser') as 'leser' | 'autor') as Scope[] : liste(o.scopes) as Scope[];
      const falsch = scopes.filter((s) => !ALLE_SCOPES.includes(s));
      if (falsch.length || !scopes.length) throw new Abbruch(`Unbekannter Scope: ${falsch.join(', ') || '(keiner)'}. Erlaubt: ${ALLE_SCOPES.join(', ')}`);
      if (scopes.includes('kern:verwalten') && !u.rollen.includes('admin')) throw new Abbruch('kern:verwalten nur für Admins.');
      if (scopes.includes('kern:freigeben') && !freigebenErlaubt(u, { art: 'mcp', agent: o.agent ?? null })) throw new Abbruch('kern:freigeben nur für eigene Tokens von Freigebern und Admins, nie für Agenten (v1.4.2).');
      const tage = Number(o.tage);
      if (!Number.isInteger(tage) || tage < 1 || tage > 365) throw new Abbruch('--tage: 1 bis 365.');
      const { zugang } = waehleZugang(kern, config.dataDir);
      const { token: t, eintrag } = zugang.erzeuge(u, {
        art: 'mcp', bezeichnung: o.agent && o.bezeichnung === 'MCP' ? `Agent ${o.agent}` : o.bezeichnung, scopes, gueltigSek: tage * 86400,
        ...(o.agent ? { agent: o.agent } : {}), ...(o.reichweite ? { reichweite: o.reichweite as 'ich' | 'team' | 'betrieb' } : {}),
      });
      io.out(`${t}\n`);
      io.err(`Token ${eintrag.id} für ${u.name} angelegt (${scopes.join(', ')}, gültig bis ${eintrag.laeuftAb?.slice(0, 10) ?? 'unbegrenzt'}). Es wird nur jetzt angezeigt.\nNutzung: Authorization: Bearer <token> an <server>/mcp\n`);
    });
  token.command('liste').description('Tokens auflisten (ohne Geheimnis)').argument('[name]', 'Nur für diesen Benutzer')
    .action(async (name?: string) => {
      const { kern, config } = await oeffne();
      const alle = await kern.benutzer.liste();
      const u = name ? alle.find((x) => x.name === name) : undefined;
      if (name && !u) throw new Abbruch(`Benutzer "${name}" gibt es nicht.`);
      const { zugang } = waehleZugang(kern, config.dataDir);
      const betreiber = { id: 'cli', name: 'cli', rollen: ['admin' as const], teams: [] };
      for (const x of u ? [u] : alle) {
        for (const t of zugang.liste(betreiber, x.id, { art: ['mcp', 'api', 'oauth_zugriff'] })) {
          io.out(`${t.id}\t${x.name}\t${t.bezeichnung}\t${t.scopes.join(',')}\terstellt ${t.erstellt.slice(0, 10)}\tbis ${t.laeuftAb?.slice(0, 10) ?? '-'}\tzuletzt ${t.zuletzt?.slice(0, 16) ?? '-'}\n`);
        }
      }
    });
  token.command('widerrufen').description('Token ungültig machen').argument('<id>', 'Token-ID (t_…)')
    .action(async (id: string) => {
      const { kern, config } = await oeffne();
      const { zugang } = waehleZugang(kern, config.dataDir);
      if (!zugang.widerrufe({ id: 'cli', name: 'cli', rollen: ['admin'], teams: [] }, id)) throw new Abbruch(`Token ${id} nicht gefunden.`);
      io.out(`Token ${id} widerrufen.\n`);
    });

  // ---------- add ----------
  p.command('add')
    .description('Datei, Webseite oder Text als Quelle hinzufügen; Vorschläge für das Wissen landen im Eingang')
    .argument('<datei|url|->', 'Pfad zu einer Datei, eine http(s)-Adresse oder "-" für Text von stdin')
    .option('-s, --sammlung <name>', 'Sammlung', 'allgemein')
    .addOption(new Option('--sichtbarkeit <wert>', 'ich | team:<name> | betrieb').default('betrieb'))
    .option('--titel <text>', 'Titel der Quelle')
    .option('--beobachten', 'Datei oder Seite auf Änderungen beobachten')
    .option('--audio', 'Datei ist eine Audioaufnahme')
    .option('--json', 'Ausgabe als JSON')
    .action(async (ziel: string, o: { sammlung: string; sichtbarkeit: string; titel?: string; beobachten?: boolean; audio?: boolean; json?: boolean }) => {
      if (!/^(ich|betrieb|team:.+)$/.test(o.sichtbarkeit)) throw new Abbruch('Sichtbarkeit: ich, betrieb oder team:<name>.');
      const { kern } = await oeffne();
      const u = await handelnder(kern);
      const basis = { sammlung: o.sammlung, sichtbarkeit: o.sichtbarkeit as Sichtbarkeit, titel: o.titel, beobachten: !!o.beobachten };
      let erg;
      if (/^https?:\/\//i.test(ziel)) erg = await kern.fuegeHinzu(u, { ...basis, art: 'web', url: ziel });
      else if (ziel === '-') {
        const teile: Buffer[] = [];
        for await (const c of process.stdin) teile.push(c as Buffer);
        erg = await kern.fuegeHinzu(u, { ...basis, art: 'text', inhalt: Buffer.concat(teile).toString('utf8') });
      } else {
        const abs = path.resolve(ziel);
        if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) throw new Abbruch(`Datei ${ziel} gibt es nicht.`);
        erg = await kern.fuegeHinzu(u, { ...basis, art: o.audio ? 'audio' : 'datei', dateiPfad: abs });
      }
      if (o.json) return json(erg);
      io.out(`Quelle: ${erg.quelle.pfad}\n`);
      for (const v of erg.vorschlaege) io.out(`Vorschlag ${v.id}: ${v.art} ${v.ziel}\n`);
      if (erg.vorschlaege.length) io.out(`Freigeben mit: kern freigeben <id>\n`);
    });

  // ---------- suche, frage, fakten ----------
  p.command('suche').description('Im Wissen und in den Quellen suchen')
    .argument('<anfrage>', 'Suchbegriffe')
    .addOption(new Option('--reichweite <r>', 'Reichweite').choices(['ich', 'team', 'betrieb']))
    .option('-s, --sammlung <name>', 'Nur diese Sammlung')
    .option('-n, --limit <zahl>', 'Höchstzahl Treffer', '10')
    .option('--json', 'Ausgabe als JSON')
    .action(async (q: string, o: { reichweite?: 'ich' | 'team' | 'betrieb'; sammlung?: string; limit: string; json?: boolean }) => {
      const { kern } = await oeffne();
      const t = await kern.suche(await handelnder(kern), q, { reichweite: o.reichweite, sammlung: o.sammlung, limit: Number(o.limit) || 10 });
      if (o.json) return json(t);
      if (t.length === 0) return io.out('Keine Treffer.\n');
      for (const x of t) io.out(`${x.pfad}:${x.zeilen[0]}-${x.zeilen[1]}  ${x.titel} › ${x.abschnitt}\n    ${x.ausschnitt.replace(/\s+/g, ' ').slice(0, 140)}\n`);
    });

  p.command('frage').description('Frage stellen, Antwort nur mit Belegen')
    .argument('<frage>', 'Frage in normaler Sprache')
    .addOption(new Option('--reichweite <r>', 'Reichweite').choices(['ich', 'team', 'betrieb']))
    .option('-s, --sammlung <name>', 'Nur diese Sammlung')
    .option('--json', 'Ausgabe als JSON')
    .action(async (f: string, o: { reichweite?: 'ich' | 'team' | 'betrieb'; sammlung?: string; json?: boolean }) => {
      const { kern } = await oeffne();
      const a = await kern.frage(await handelnder(kern), f, { reichweite: o.reichweite, sammlung: o.sammlung });
      if (o.json) return json(a);
      io.out(formatAntwort(a));
    });

  p.command('fakten').description('Belegte Fakten abfragen (Preise, Fristen, Zuständigkeiten …)')
    .addOption(new Option('--art <art>', 'Art des Fakts').choices(['preis', 'frist', 'zustaendigkeit', 'kennzahl', 'kontakt', 'regel']))
    .option('--gegenstand <text>', 'Worum es geht (Teilwort)')
    .option('--gueltig-am <datum>', 'Gilt an diesem Tag (JJJJ-MM-TT)')
    .option('--json', 'Ausgabe als JSON')
    .action(async (o: { art?: string; gegenstand?: string; gueltigAm?: string; json?: boolean }) => {
      const { kern } = await oeffne();
      if (typeof kern.fakten !== 'function') throw new Abbruch('Diese core-Version kennt noch keine Faktenschicht.');
      const f = await kern.fakten(await handelnder(kern), { art: o.art, gegenstand: o.gegenstand, gueltigAm: o.gueltigAm });
      if (o.json) return json(f);
      if (f.length === 0) return io.out('Keine Fakten gefunden.\n');
      for (const x of f) io.out(`${x.art}\t${x.gegenstand}: ${x.wert}${x.einheit ? ` ${x.einheit}` : ''}${x.gilt_bis ? ` (bis ${x.gilt_bis})` : ''}\t${x.artikel ?? ''}#${x.fundstelle}\n`);
    });

  // ---------- eingang ----------
  p.command('eingang').description('Offene Vorschläge anzeigen').option('--json', 'Ausgabe als JSON')
    .action(async (o: { json?: boolean }) => {
      const { kern } = await oeffne();
      const l = await kern.eingang(await handelnder(kern));
      if (o.json) return json(l);
      if (l.length === 0) return io.out('Eingang ist leer.\n');
      for (const v of l) io.out(`${v.id}\t${v.art}\t${v.ziel}\t${v.grund}\n`);
    });

  const entscheide = (aktion: 'freigeben' | 'ablehnen') => async (id: string, o: { begruendung?: string }) => {
    const { kern } = await oeffne();
    const v = await kern.entscheide(await handelnder(kern), id, { aktion, begruendung: o.begruendung });
    io.out(`Vorschlag ${v.id}: ${v.status} (${v.ziel})\n`);
  };
  p.command('freigeben').description('Vorschlag freigeben: Datei wird geschrieben und committet')
    .argument('<id>', 'ID aus "kern eingang"').option('-b, --begruendung <text>', 'Begründung für den Verlauf')
    .action(entscheide('freigeben'));
  p.command('ablehnen').description('Vorschlag ablehnen')
    .argument('<id>', 'ID aus "kern eingang"').option('-b, --begruendung <text>', 'Begründung')
    .action(entscheide('ablehnen'));
  // v1.4.1 U10: Sammelfreigabe mit denselben Rechten wie einzeln (freigeber/admin, Regeln nur admin).
  p.command('sammelfreigabe').description('Offene Vorschläge gesammelt freigeben oder ablehnen (gleicher Grund, gleiche Quelle, gleicher Absender oder IDs)')
    .argument('[ids...]', 'IDs aus "kern eingang"')
    .option('--grund <text>', 'Nur Vorschläge mit genau diesem Grund')
    .option('--quelle <pfad>', 'Nur Vorschläge aus dieser Quelle')
    .option('--von <absender>', 'Nur Vorschläge dieses Absenders, z. B. agent/claude@<id>')
    .option('--art <art>', 'Nur diese Art: neu, aenderung, loeschung, nachtrag')
    .option('--ablehnen', 'Ablehnen statt freigeben')
    .option('-b, --begruendung <text>', 'Begründung für den Verlauf')
    .option('--json', 'Ausgabe als JSON')
    .action(async (ids: string[], o: { grund?: string; quelle?: string; von?: string; art?: string; ablehnen?: boolean; begruendung?: string; json?: boolean }) => {
      if (o.art && !['neu', 'aenderung', 'loeschung', 'nachtrag'].includes(o.art)) throw new Abbruch('--art: neu, aenderung, loeschung oder nachtrag.');
      const { kern } = await oeffne();
      const r = await sammelEntscheiden(kern, await handelnder(kern), {
        ...(ids.length ? { ids } : {}), grund: o.grund, quelle: o.quelle, von: o.von, art: o.art as 'neu' | undefined,
      }, { aktion: o.ablehnen ? 'ablehnen' : 'freigeben', begruendung: o.begruendung }, { ohneRegeln: true }); // v1.4.2: Regeln nur in der Weboberfläche
      if (o.json) return json(r);
      io.out(`${r.erledigt.length} von ${r.gefunden} ${o.ablehnen ? 'abgelehnt' : 'freigegeben'}, ${r.konflikte.length} Konflikte, ${r.fehler.length} Fehler.\n`);
      for (const f of r.fehler) io.err(`${f.id}: ${f.meldung}\n`);
      for (const k of r.konflikte) io.err(`${k.id}: Konflikt, ${k.ziel} wurde inzwischen geändert.\n`);
    });

  // ---------- reindex, serve ----------
  p.command('reindex').description('Suchindex aus den Dateien neu bauen')
    .action(async () => {
      const { kern } = await oeffne();
      const r = await kern.reindex();
      io.out(`Index neu gebaut: ${r.dateien} Dateien, ${r.abschnitte} Abschnitte.\n`);
    });

  p.command('serve').description('Server mit Weboberfläche, REST-API und MCP starten')
    .option('-p, --port <zahl>', 'Port (Standard: PORT oder 7480)')
    .option('--host <adresse>', 'Adresse (Standard: HOST oder 0.0.0.0)')
    .action(async (o: { port?: string; host?: string }) => {
      const config = konfig(true);
      if (!fs.existsSync(config.dataDir)) throw new Abbruch(`Datenordner ${config.dataDir} gibt es nicht. Anlegen mit: kern init <ordner>`);
      if (o.port) config.port = Number(o.port);
      if (o.host) config.host = o.host;
      const s = await starteServer({ config });
      await new Promise<void>((resolve) => {
        const ende = () => { void s.stop().then(resolve); };
        process.once('SIGINT', ende);
        process.once('SIGTERM', ende);
      });
    });

  // ---------- export, import ----------
  p.command('export').description('Datenordner als ZIP sichern (ohne .kern/) oder mit --okf als OKF-Ordner ausgeben')
    .argument('<ziel>', 'ZIP-Datei, bei --okf ein Ordner')
    .option('--okf', 'Im Open Knowledge Format in einen Ordner exportieren')
    .option('--ohne-git', 'Versionsgeschichte (.git/) nicht ins ZIP nehmen')
    .action(async (ziel: string, o: { okf?: boolean; ohneGit?: boolean }) => {
      const { kern, config } = await oeffne();
      const abs = path.resolve(ziel);
      if (abs === config.dataDir || abs.startsWith(config.dataDir + path.sep)) throw new Abbruch('Ziel darf nicht im Datenordner liegen.');
      if (o.okf) {
        if (typeof kern.exportiereOkf !== 'function') throw new Abbruch('Diese core-Version kann noch nicht nach OKF exportieren.');
        fs.mkdirSync(abs, { recursive: true });
        const r = await kern.exportiereOkf(abs);
        io.out(`OKF-Export nach ${abs}: ${JSON.stringify(r)}\n`);
        return;
      }
      const dateien = sammleDateien(config.dataDir, (rel) => rel === '.kern' || (!!o.ohneGit && rel === '.git'));
      const r = schreibeZip(config.dataDir, dateien, abs);
      io.out(`ZIP geschrieben: ${abs} (${r.dateien} Dateien, ${(r.bytes / 1048576).toFixed(1)} MB)\n`);
    });

  const imp = p.command('import')
    .description('Fremdbestand einlesen: wird zu Quellen und Vorschlägen, nichts geht direkt ins Wissen')
    .addHelpText('after', '\nBeispiel: kern import --obsidian ~/Vault');
  for (const art of IMPORT_ARTEN) {
    const text: Record<string, string> = {
      obsidian: 'Obsidian-Vault (Ordner)', notion: 'Notion-Export (Markdown-ZIP entpackt)', outline: 'Outline-Export (Markdown-Ordner)',
      confluence: 'Confluence-Export (HTML-Ordner)', markdown: 'beliebiger Markdown-Ordner', okf: 'Open-Knowledge-Format-Ordner',
      'kern-zip': 'ZIP-Export einer anderen Kern-Instanz (POST /api/export art zip)',
    };
    imp.option(`--${art} <pfad>`, text[art]!);
  }
  imp.action(async (roh: Record<string, string | undefined>) => {
    // commander schreibt --kern-zip als kernZip
    const o = Object.fromEntries(IMPORT_ARTEN.map((a) => [a, roh[a.replace(/-([a-z])/g, (_m, b: string) => b.toUpperCase())]])) as Partial<Record<ImportArt, string>>;
    const gewaehlt = IMPORT_ARTEN.filter((a) => o[a]);
    if (gewaehlt.length !== 1) throw new Abbruch(`Genau eine Quelle angeben: ${IMPORT_ARTEN.map((a) => `--${a} <pfad>`).join(' | ')}`);
    const art = gewaehlt[0]!;
    const abs = path.resolve(o[art]!);
    if (!fs.existsSync(abs)) throw new Abbruch(`${o[art]} gibt es nicht.`);
    const { kern } = await oeffne();
    const u = await handelnder(kern);
    let r: { quellen?: unknown[]; vorschlaege?: unknown[]; uebersprungen?: unknown[] } | undefined;
    if (typeof kern.importiere === 'function') r = (await kern.importiere(u, { art, pfad: abs })) as typeof r;
    else if (art === 'okf' && typeof kern.importiereOkf === 'function') r = (await kern.importiereOkf(u, abs)) as typeof r;
    else throw new Abbruch(`Diese core-Version kann "${art}" noch nicht importieren.`);
    io.out(`Import (${art}): ${r?.quellen?.length ?? '?'} Quellen, ${r?.vorschlaege?.length ?? '?'} Vorschläge im Eingang${r?.uebersprungen?.length ? `, ${r.uebersprungen.length} übersprungen` : ''}.\n`);
  });

  // ---------- v1.4 8.1 Prüfbank, 7.3 Ausstiegsprobe ----------
  p.command('pruefbank').description('Prüfbank mit dem eingestellten KI-Anbieter laufen lassen (Belegtreue, Lecks, Injektion)')
    .option('--satz <satz>', 'oeffentlich (Beispielbetrieb) oder betrieb (eigene Prüffragen)', 'oeffentlich')
    .option('--json', 'Ausgabe als JSON')
    .action(async (o: { satz: string; json?: boolean }) => {
      if (o.satz !== 'oeffentlich' && o.satz !== 'betrieb') throw new Abbruch('--satz: oeffentlich oder betrieb');
      const { kern } = await oeffne();
      if (typeof kern.pruefbank !== 'function') throw new Abbruch('Diese core-Version hat noch keine Prüfbank (v1.4 8.1).');
      const u = await handelnder(kern);
      const l = await kern.pruefbank(u, { satz: o.satz });
      if (o.json) { io.out(`${JSON.stringify(l, null, 2)}\n`); return; }
      const k = l.kennzahlen;
      io.out(`Prüfbank ${l.satz} mit ${l.anbieter}/${l.modell}: ${l.bestanden ? 'bestanden' : 'NICHT bestanden'}\n  Belegtreue ${k.belegtreue}, Lecks ${k.lecks}, Injektionsfest ${k.injektionsfest}, Treffer@5 ${k.trefferAt5}\n`);
      if (!l.bestanden) process.exitCode = 1;
    });
  p.command('ausstiegsprobe').description('Ausstiegsprobe: Umzugspaket in einen leeren Ordner und prüfen, OKF-Export auf Lesbarkeit ohne Kern')
    .option('--json', 'Ausgabe als JSON')
    .action(async (o: { json?: boolean }) => {
      const { kern } = await oeffne();
      if (typeof kern.ausstiegsprobe !== 'function') throw new Abbruch('Diese core-Version hat noch keine Ausstiegsprobe (v1.4 7.3).');
      const r = await kern.ausstiegsprobe(await handelnder(kern));
      io.out(o.json ? `${JSON.stringify(r, null, 2)}\n` : `Ausstiegsprobe ${r.bestanden ? 'bestanden' : 'NICHT bestanden'} (${r.am}).\n`);
      if (!r.bestanden) process.exitCode = 1;
    });

  // ---------- mcp (v1.4 6.5) ----------
  const mcpAktion = async (o: { verbinde?: string; tokenEnv: string }) => {
    if (o.verbinde) {
      const token = io.env[o.tokenEnv];
      if (!token) throw new Abbruch(`Token fehlt: Umgebungsvariable ${o.tokenEnv} setzen (nie als Argument übergeben).`);
      const b = await starteBruecke(o.verbinde, token, (s) => io.err(`${s}\n`));
      io.err(`[kern] Brücke zu ${new URL(o.verbinde).host} bereit (stdio).\n`);
      await b.fertig;
      return;
    }
    const name = g().als ?? io.env.KERN_ALS;
    if (!name) throw new Abbruch('Lokales MCP braucht einen Benutzer: --als <name> oder KERN_ALS. Die Rechte sind die dieses Benutzers.');
    const { kern, config } = await oeffne();
    const u = await handelnder(kern);
    const p = config.kern.provider as Record<string, unknown>;
    const stop = await starteStdio(kern, u, { produktName: config.produktName, modell: { anbieter: String(p.art), name: String(p.chatModell ?? p.art) } });
    io.err(`[kern] MCP (stdio) für ${u.name} auf ${config.dataDir}.\n`);
    await new Promise<void>((resolve) => { process.stdin.once('end', resolve); process.stdin.once('close', resolve); });
    await stop();
    await kern.schliesse?.();
  };
  for (const [befehl, text] of [['mcp', 'MCP über stdio: direkt auf dem Datenordner oder mit --verbinde als Brücke zu einer Instanz im VPN'], ['mcp-bruecke', 'Wie "mcp" (Name aus der IT-Mappe)']] as const) {
    p.command(befehl).description(text)
      .option('--verbinde <url>', 'Adresse der Instanz (…/mcp); stdio wird zu Streamable HTTP weitergereicht')
      .option('--token-env <name>', 'Umgebungsvariable mit dem Zugangstoken', 'KERN_TOKEN')
      .addHelpText('after', '\nBeispiele:\n  KERN_ALS=anna kern -d ./daten mcp\n  KERN_TOKEN=kern_… kern mcp --verbinde https://kern.intern.example/mcp')
      .action(mcpAktion);
  }

  // ---------- umzug (v1.4 7.2) ----------
  const umzug = p.command('umzug').description('Umzugspaket: Kern zu Kern ohne Verlust (Managed, eigene Cloud, lokal)');
  umzug.command('packen').description('Datenordner als verschlüsseltes Umzugspaket schreiben (Server vorher anhalten oder nur_lesen)')
    .argument('<ziel>', 'Zieldatei, z. B. umzug-2026-10-24.tar.age')
    .option('--empfaenger <schluessel>', 'age-Empfänger (age1…), ohne Passphrase-Eingabe')
    .option('--passphrase', 'mit Passphrase verschlüsseln (Eingabe am Terminal über age)')
    .option('--unverschluesselt', 'ohne Verschlüsselung (nur für Tests oder verschlüsselte Datenträger)')
    .option('--instanz <id>', 'Instanzkennung für das Manifest')
    .action(async (ziel: string, o: { empfaenger?: string; passphrase?: boolean; unverschluesselt?: boolean; instanz?: string }) => {
      const { kern, config } = await oeffne();
      const z = (kern as { zugang?: { exportiere?: () => unknown } }).zugang;
      const b = await pruefeBestand(kern, await handelnder(kern), config.dataDir);
      // Zugänge exportieren, solange der Zugangsspeicher von core noch offen ist.
      const zugangExport = typeof z?.exportiere === 'function' ? await z.exportiere() : undefined;
      await kern.schliesse?.();
      const r = packen({
        dataDir: config.dataDir, ziel, version: VERSION, instanz: o.instanz, befundeFehler: b.zahlen.fehler,
        zugangExport: zugangExport as Parameters<typeof packen>[0]['zugangExport'],
        empfaenger: o.empfaenger, passphraseAmTerminal: o.passphrase, unverschluesselt: o.unverschluesselt,
      });
      io.out(`Umzugspaket: ${r.datei} (${r.bytes} Bytes), sha256 ${r.sha256}\nHEAD ${r.head}, ${r.dateien} Dateien im Manifest.\nWeiter am Ziel: kern umzug auspacken <paket> <ordner> und kern umzug pruefen <ordner>\n`);
      if (typeof z?.exportiere !== 'function') io.err('Hinweis: Diese core-Version exportiert keine Zugänge; MCP-Tokens und OAuth-Apps am Ziel neu anlegen.\n');
    });
  umzug.command('auspacken').description('Umzugspaket in einen neuen, leeren Ordner auspacken')
    .argument('<paket>', 'Paketdatei').argument('<ordner>', 'Zielordner (neu oder leer)')
    .option('-i, --identitaet <datei>', 'age-Identität (privater Schlüssel), sonst Passphrase am Terminal')
    .option('--passphrase-env <name>', 'Passphrase aus dieser Umgebungsvariable (ohne Terminal, z. B. per docker exec beim Stufenwechsel); Paket aus POST /api/export bzw. /_betrieb/export')
    .action(async (paket: string, ordner: string, o: { identitaet?: string; passphraseEnv?: string }) => {
      if (o.passphraseEnv) {
        const pw = io.env[o.passphraseEnv];
        if (!pw) throw new Abbruch(`Passphrase fehlt: Umgebungsvariable ${o.passphraseEnv} setzen.`);
        const modName = '@kern/core';
        const core = (await import(modName)) as { umzugAuspacken?: (p: string, z: string, pw: string) => Promise<{ head: string; dateien: unknown[] }> };
        if (typeof core.umzugAuspacken !== 'function') throw new Abbruch('Diese core-Version kann kein Umzugspaket auspacken.');
        const m = await core.umzugAuspacken(path.resolve(paket), path.resolve(ordner), pw);
        io.out(`Ausgepackt nach ${path.resolve(ordner)} (HEAD ${m.head}, ${m.dateien.length} Dateien).\nWeiter mit: kern umzug pruefen ${ordner}\n`);
        return;
      }
      const r = auspacken({ paket, ordner, identitaet: o.identitaet });
      io.out(`Ausgepackt nach ${r.ordner} (HEAD ${r.manifest.head}, ${r.manifest.dateien.length} Dateien).\nWeiter mit: kern umzug pruefen ${ordner}\n`);
    });
  umzug.command('pruefen').description('Ausgepackten Ordner prüfen: Prüfsummen, git fsck, HEAD, Index neu, kern pruefen; schreibt .kern/pruefbericht.json')
    .argument('<ordner>', 'Datenordner')
    .option('--json', 'Ausgabe als JSON')
    .action(async (ordner: string, o: { json?: boolean }) => {
      const abs = path.resolve(ordner);
      const env = { ...io.env, KERN_SECRET: io.env.KERN_SECRET ?? crypto.randomBytes(32).toString('hex'), ...(g().fake ? { KERN_FAKE: '1' } : {}) };
      const config = ladeKonfiguration({ dataDir: abs, env });
      const kern = await oeffneKern(config.kern, config.fake);
      try {
        // Pakete aus core (POST /api/export, /_betrieb/export): core prüft selbst und schreibt .kern/pruefbericht.json.
        const kc = kern as typeof kern & { umzugPruefen?: (u: User) => Promise<{ bestanden: boolean }> };
        if (typeof kc.umzugPruefen === 'function' && fs.existsSync(path.join(abs, '.kern', 'umzug-manifest.json'))) {
          const admin = (await kern.benutzer.liste()).find((x) => x.rollen.includes('admin'));
          if (!admin) throw new Abbruch('Im Paket ist kein Admin.');
          const b = await kc.umzugPruefen(admin);
          if (o.json) json(b); else io.out(b.bestanden ? `UMZUG OK. Prüfbericht ${path.join(abs, '.kern/pruefbericht.json')}\n` : 'UMZUG NICHT OK. Quelle nicht abschalten.\n');
          if (!b.bestanden) throw new Abbruch('', 1);
          return;
        }
        const b = await pruefeUmzug({
          ordner: abs,
          reindex: () => kern.reindex(),
          befundeFehler: async () => (await pruefeBestand(kern, await handelnder(kern), abs)).zahlen.fehler,
        });
        if (o.json) json(b);
        else {
          io.out(`Prüfsummen ${b.pruefsummen_ok ? 'ok' : 'NICHT ok'}, git fsck ${b.git_fsck_ok ? 'ok' : 'NICHT ok'}, HEAD ${b.head_gleich ? 'gleich' : 'ABWEICHEND'}, Index ${b.index_neu ? 'neu gebaut' : 'FEHLER'}, neue Befunde ${b.pruefen_befunde_neu}.\n`);
          for (const a of b.abweichungen.slice(0, 20)) io.out(`  ${a}\n`);
          io.out(b.bestanden ? `UMZUG OK. Prüfbericht ${path.join(abs, '.kern/pruefbericht.json')}\n` : 'UMZUG NICHT OK. Quelle nicht abschalten.\n');
        }
        if (!b.bestanden) throw new Abbruch('', 1);
      } finally {
        await kern.schliesse?.();
      }
    });

  // ---------- pruefen ----------
  p.command('pruefen').description('Konsistenz prüfen: Fundstellen, fällige Artikel, Fakten, Index gegen Dateien')
    .option('--json', 'Ausgabe als JSON')
    .action(async (o: { json?: boolean }) => {
      const { kern, config } = await oeffne();
      const b = await pruefeBestand(kern, await handelnder(kern), config.dataDir);
      if (o.json) json(b);
      else {
        io.out(`Geprüft: ${b.zahlen.artikel} Artikel, ${b.zahlen.quellen} Quellen (core ${b.coreVersion}).\n`);
        for (const x of b.befunde) io.out(`[${x.schwere}] ${x.art}${x.pfad ? ` ${x.pfad}` : ''}: ${x.text}${x.vorschlag ? ` (Vorschlag ${x.vorschlag})` : ''}\n`);
        io.out(`${b.zahlen.fehler} Fehler, ${b.zahlen.warnungen} Warnungen, ${b.zahlen.faellig} fällige Artikel.\n`);
      }
      if (b.zahlen.fehler > 0) throw new Abbruch('', 1);
    });

  return p;
}

/**
 * P2 (N2): Beispielbetrieb nur auf ausdrücklichen Wunsch. core legt die Demo-Zugänge an; danach bekommt
 * jeder Zugang ein zufälliges Passwort, das genau einmal ausgegeben wird. Feste Demo-Passwörter bleiben nicht stehen.
 */
async function ladeBeispiel(dir: string, io: Io): Promise<void> {
  const modName = '@kern/core';
  const core = (await import(modName)) as { seedDemo?: (d: string, o: object) => Promise<{ benutzer: { name: string }[] }> };
  if (typeof core.seedDemo !== 'function') throw new Abbruch('Diese core-Version hat keine Beispieldaten.');
  const erg = await core.seedDemo(dir, {});
  const config = ladeKonfiguration({ dataDir: dir, env: { ...io.env, KERN_SECRET: crypto.randomBytes(32).toString('hex') } });
  const kern = await oeffneKern(config.kern, false);
  try {
    if (typeof kern.benutzer.aendere !== 'function') throw new Abbruch('Diese core-Version kann Passwörter nicht ändern; Beispieldaten abgebrochen.');
    io.out(`Beispielbetrieb (erfunden) angelegt: ${dir}\nZugänge, Passwörter werden nur jetzt angezeigt:\n`);
    for (const u of await kern.benutzer.liste()) {
      const pw = crypto.randomBytes(12).toString('base64url');
      await kern.benutzer.aendere(u.id, { passwort: pw });
      io.out(`  ${u.name}\t${u.rollen.join(',')}\t${pw}\n`);
    }
    io.out(`(${erg.benutzer.length} Zugänge.) Nie auf einer öffentlich erreichbaren Instanz verwenden.\nStart: kern -d ${dir} serve\n`);
  } finally {
    await kern.schliesse?.();
  }
}

/** Führt die CLI aus und gibt den Exit-Code zurück. */
export async function fuehreAus(argv: string[], io: Io = standardIo()): Promise<number> {
  const p = baueProgramm(io);
  try {
    await p.parseAsync(argv, { from: 'user' });
    return 0;
  } catch (e) {
    if (e instanceof CommanderError) return e.exitCode;
    if (e instanceof Abbruch) {
      if (e.message) io.err(`Fehler: ${e.message}\n`);
      return e.code;
    }
    const { meldung, status } = statusAusFehler(e);
    io.err(`Fehler: ${status >= 500 ? (e as Error).message : meldung}\n`);
    return 1;
  }
}

export { leseKernYaml };
