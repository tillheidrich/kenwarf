import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fuehreAus, type Io } from '../src/programm.js';
import { leseZipNamen } from '../src/zip.js';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kern-cli-'));
const daten = path.join(tmp, 'daten');
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

async function kern(...args: string[]) {
  let out = '';
  let err = '';
  const io: Io = { out: (s) => { out += s; }, err: (s) => { err += s; }, env: { KERN_FAKE: '1' }, passwort: 'ein-langes-passwort' };
  const code = await fuehreAus(['-d', daten, ...args], io);
  return { code, out, err };
}

describe('kern CLI gegen Temp-Ordner (Attrappe)', () => {
  beforeAll(async () => {
    const r = await kern('init', daten, '--betrieb', 'Testbetrieb', '--admin', 'chef');
    expect(r.code, r.err).toBe(0);
  });

  it('init legt kern.yaml und Ordner an', () => {
    expect(fs.readFileSync(path.join(daten, 'kern.yaml'), 'utf8')).toContain('Testbetrieb');
    for (const d of ['quellen', 'wissen', 'eingang']) expect(fs.existsSync(path.join(daten, d))).toBe(true);
  });

  it('Hilfe ist deutsch', async () => {
    const r = await kern('--help');
    expect(r.code).toBe(0);
    expect(r.out).toContain('Datenordner');
    expect(r.out).toContain('freigeben');
  });

  it('nutzer anlegen und liste, falsche Rolle abgewiesen', async () => {
    expect((await kern('nutzer', 'anlegen', 'lisa', '--rollen', 'leser')).code).toBe(0);
    expect((await kern('nutzer', 'anlegen', 'max', '--rollen', 'autor,freigeber', '--teams', 'buero')).code).toBe(0);
    const f = await kern('nutzer', 'anlegen', 'x', '--rollen', 'gott');
    expect(f.code).toBe(1);
    expect(f.err).toContain('Unbekannte Rolle');
    const l = await kern('nutzer', 'liste', '--json');
    expect(JSON.parse(l.out).map((u: { name: string }) => u.name)).toEqual(['chef', 'lisa', 'max']);
  });

  it('add, eingang, freigeben, suche, frage', async () => {
    const datei = path.join(tmp, 'preise.md');
    fs.writeFileSync(datei, '# Preise\n\nDer Stundensatz für Gesellen beträgt 68 Euro.\n');
    const a = await kern('add', datei, '--sammlung', 'preise', '--titel', 'Preisliste', '--json');
    expect(a.code, a.err).toBe(0);
    const erg = JSON.parse(a.out);
    expect(erg.quelle.pfad).toMatch(/^quellen\/\d{4}\/preisliste\.md$/);
    const e = await kern('eingang', '--json');
    const offen = JSON.parse(e.out);
    expect(offen).toHaveLength(1);
    // Leser darf nicht freigeben
    const verboten = await kern('--als', 'lisa', 'freigeben', offen[0].id);
    expect(verboten.code).toBe(1);
    const fg = await kern('--als', 'max', 'freigeben', offen[0].id, '-b', 'stimmt');
    expect(fg.code, fg.err).toBe(0);
    expect(fg.out).toContain('freigegeben');
    expect(fs.existsSync(path.join(daten, offen[0].ziel))).toBe(true);
    const s = await kern('suche', 'Stundensatz');
    expect(s.out).toContain('preisliste.md');
    const f = await kern('frage', 'Wie hoch ist der Stundensatz?');
    expect(f.out).toContain('Belege:');
    expect(f.out).toContain('[1]');
    const n = await kern('frage', 'Quantenchromodynamik');
    expect(n.out).toContain('Steht nicht drin');
  });

  it('add mit fehlender Datei gibt Fehler', async () => {
    const r = await kern('add', path.join(tmp, 'gibtsnicht.pdf'));
    expect(r.code).toBe(1);
    expect(r.err).toContain('gibt es nicht');
  });

  it('token anlegen, liste, widerrufen', async () => {
    const t = await kern('token', 'anlegen', 'lisa', '-b', 'Claude');
    expect(t.out.trim()).toMatch(/^kern_/);
    const l = await kern('token', 'liste', 'lisa');
    const id = l.out.split('\t')[0]!;
    expect(id).toMatch(/^t_/);
    expect((await kern('token', 'widerrufen', id)).code).toBe(0);
    expect((await kern('token', 'widerrufen', id)).code).toBe(1);
  });

  it('token anlegen --agent: Profil passt zur Rolle, Scopes fest (v1.4 8.4)', async () => {
    const f = await kern('token', 'anlegen', 'lisa', '--agent', 'Claude', '--profil', 'autor');
    expect(f.code).toBe(1);
    expect(f.err).toContain('nur leser');
    expect((await kern('token', 'anlegen', 'lisa', '--profil', 'leser')).code).toBe(1);
    const t = await kern('token', 'anlegen', 'max', '--agent', 'Claude', '--profil', 'autor', '--reichweite', 'team');
    expect(t.code, t.err).toBe(0);
    expect(t.err).toContain('kern:vorschlagen');
  });

  it('sammelfreigabe: Leser abgewiesen, ohne Filter abgewiesen (v1.4.1 U10)', async () => {
    const l = await kern('--als', 'lisa', 'sammelfreigabe', '--grund', 'Import');
    expect(l.code).toBe(1);
    expect(l.err).toContain('freigeber');
    expect((await kern('sammelfreigabe')).code).toBe(1);
  });

  it('reindex', async () => {
    const r = await kern('reindex');
    expect(r.out).toMatch(/Index neu gebaut: \d+ Dateien/);
  });

  it('export ZIP ohne .kern/, Ziel im Datenordner verboten', async () => {
    fs.mkdirSync(path.join(daten, '.git'), { recursive: true });
    fs.writeFileSync(path.join(daten, '.git', 'HEAD'), 'ref: refs/heads/main\n');
    const zip = path.join(tmp, 'sicherung.zip');
    const r = await kern('export', zip);
    expect(r.code, r.err).toBe(0);
    const namen = leseZipNamen(zip);
    expect(namen).toContain('kern.yaml');
    expect(namen.some((n) => n.startsWith('wissen/'))).toBe(true);
    expect(namen).toContain('.git/HEAD');
    expect(namen.some((n) => n.startsWith('.kern'))).toBe(false);
    const ohneGit = path.join(tmp, 'ohne-git.zip');
    await kern('export', ohneGit, '--ohne-git');
    expect(leseZipNamen(ohneGit).some((n) => n.startsWith('.git'))).toBe(false);
    expect((await kern('export', path.join(daten, 'x.zip'))).code).toBe(1);
  });

  it('ZIP lässt sich mit unzip prüfen, falls vorhanden', async () => {
    const zip = path.join(tmp, 'sicherung.zip');
    const code = await new Promise<number>((res) => {
      const p = spawn('unzip', ['-tq', zip]);
      p.on('error', () => res(-1));
      p.on('exit', (c) => res(c ?? 1));
    });
    if (code !== -1) expect(code).toBe(0);
  });

  it('export --okf und import --okf (Rundlauf über Vorschläge)', async () => {
    const okf = path.join(tmp, 'okf');
    const r = await kern('export', okf, '--okf');
    expect(r.code, r.err).toBe(0);
    expect(fs.existsSync(path.join(okf, 'wissen'))).toBe(true);
    const vorher = JSON.parse((await kern('eingang', '--json')).out).length;
    const i = await kern('import', '--okf', okf);
    expect(i.code, i.err).toBe(0);
    expect(i.out).toMatch(/Import \(okf\): \d+ Quellen/);
    const md = path.join(tmp, 'vault');
    fs.mkdirSync(md, { recursive: true });
    fs.writeFileSync(path.join(md, 'Notiz.md'), '# Notiz\n\nAus Obsidian.');
    const ob = await kern('import', '--obsidian', md);
    expect(ob.code, ob.err).toBe(0);
    expect((await kern('import', '--obsidian', md, '--markdown', md)).code).toBe(1);
    expect((await kern('import')).code).toBe(1);
    expect(JSON.parse((await kern('eingang', '--json')).out).length).toBeGreaterThan(vorher);
  });

  it('pruefen meldet kaputte Fundstelle und fällige Artikel, Exit-Code 1', async () => {
    fs.mkdirSync(path.join(daten, 'wissen', 'alt'), { recursive: true });
    fs.writeFileSync(path.join(daten, 'wissen', 'alt', 'kaputt.md'), '---\ntitel: Kaputt\ngruppe: alt\nkurzfassung: x\nstand: 2020-01-01\nsichtbarkeit: betrieb\nstatus: freigegeben\npruefen_bis: 2021-01-01\nfundstellen:\n  - quelle: quellen/1999/weg.md\n    abschnitt: A\n    zeilen: [1, 2]\n---\nText\n');
    const r = await kern('pruefen', '--json');
    expect(r.code).toBe(1);
    const b = JSON.parse(r.out);
    expect(b.coreVersion).toBe('v1.1');
    expect(b.befunde.some((x: { art: string }) => x.art === 'fundstelle_kaputt')).toBe(true);
    expect(b.befunde.some((x: { art: string }) => x.art === 'pruefung_faellig')).toBe(true);
    fs.rmSync(path.join(daten, 'wissen', 'alt'), { recursive: true });
  });

  it('fakten', async () => {
    const r = await kern('fakten', '--json');
    expect(r.code).toBe(0);
    expect(Array.isArray(JSON.parse(r.out))).toBe(true);
  });

  it('Befehl ohne Datenordner gibt verständlichen Fehler', async () => {
    let err = '';
    const code = await fuehreAus(['-d', path.join(tmp, 'nix'), 'suche', 'x'], { out: () => {}, err: (s) => { err += s; }, env: { KERN_FAKE: '1' } });
    expect(code).toBe(1);
    expect(err).toContain('kern init');
  });

  it('kern serve startet auf Port 4301 und antwortet auf /healthz', async () => {
    const tsx = path.resolve(__dirname, '../../../node_modules/tsx/dist/loader.mjs');
    const kind = spawn(process.execPath, ['--import', tsx, path.resolve(__dirname, '../src/cli.ts'), '-d', daten, 'serve', '--port', '4301', '--host', '127.0.0.1'], {
      env: { ...process.env, KERN_FAKE: '1', KERN_SECRET: 'y'.repeat(40) }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    try {
      await new Promise<void>((res, rej) => {
        const t = setTimeout(() => rej(new Error('Server startet nicht')), 20000);
        kind.stdout.on('data', (d: Buffer) => { if (d.toString().includes('läuft auf')) { clearTimeout(t); res(); } });
        kind.on('exit', (c) => rej(new Error(`beendet mit ${c}`)));
      });
      const r = await fetch('http://127.0.0.1:4301/healthz');
      expect((await r.json()).ok).toBe(true);
    } finally {
      kind.kill('SIGTERM');
      await new Promise((r) => kind.once('exit', r));
    }
  });
});

const coreGebaut = fs.existsSync(path.join(__dirname, '..', '..', 'core', 'dist', 'index.js'));
describe.skipIf(!coreGebaut)('P2: Beispieldaten nur mit Flag, Zufallspasswörter (echtes core)', () => {
  it('init --beispieldaten gibt Zufallspasswörter einmal aus, demo-passwort gilt nicht', async () => {
    const ziel = path.join(tmp, 'beispiel');
    let out = '';
    const code = await fuehreAus(['init', ziel, '--beispieldaten'], { out: (s) => { out += s; }, err: () => {}, env: {} });
    expect(code).toBe(0);
    const zeile = out.split('\n').find((z) => z.includes('Jörn Wendt'))!;
    const pw = zeile.split('\t')[2]!;
    expect(pw.length).toBeGreaterThanOrEqual(16);
    const core = (await import('@kern/core' as string)) as { Kern: { open(c: object): Promise<{ benutzer: { pruefe(n: string, p: string): Promise<unknown> }; schliesse?(): Promise<void> }> } };
    const k = await core.Kern.open({ dataDir: ziel, provider: { art: 'mock' }, betrieb: 'x', sprache: 'de' });
    expect(await k.benutzer.pruefe('Jörn Wendt', 'demo-passwort')).toBeNull();
    expect(await k.benutzer.pruefe('Jörn Wendt', pw)).toBeTruthy();
    await k.schliesse?.();
  }, 60000);

  const cliGebaut = fs.existsSync(path.join(__dirname, '..', 'dist', 'cli.js'));
  it.skipIf(!cliGebaut)('einstieg.sh mit KERN_DEMO=1 schreibt die Zufallspasswörter einmal ins Log, beim zweiten Start nicht mehr', async () => {
    const { spawnSync } = await import('node:child_process');
    const ziel = path.join(tmp, 'demo-einstieg');
    const skript = path.join(__dirname, '..', '..', '..', 'deploy', 'scripts', 'einstieg.sh');
    const env = { PATH: process.env.PATH ?? '', KERN_DATA: ziel, KERN_DEMO: '1', KERN_CLI: `node ${path.join(__dirname, '..', 'dist', 'cli.js')}` };
    const r1 = spawnSync('sh', [skript, '--version'], { env, encoding: 'utf8' });
    expect(r1.status, r1.stderr).toBe(0);
    expect(r1.stdout).toContain('DEMO-ZUGÄNGE');
    const zeile = r1.stdout.split('\n').find((z) => z.includes('Jörn Wendt'))!;
    const pw = zeile.trim().split('\t')[2]!;
    expect(pw.length).toBeGreaterThanOrEqual(16);
    const core = (await import('@kern/core' as string)) as { Kern: { open(c: object): Promise<{ benutzer: { pruefe(n: string, p: string): Promise<unknown> }; schliesse?(): Promise<void> }> } };
    const k = await core.Kern.open({ dataDir: ziel, provider: { art: 'mock' }, betrieb: 'x', sprache: 'de' });
    expect(await k.benutzer.pruefe('Jörn Wendt', pw)).toBeTruthy();
    await k.schliesse?.();
    const r2 = spawnSync('sh', [skript, '--version'], { env, encoding: 'utf8' });
    expect(r2.status, r2.stderr).toBe(0);
    expect(r2.stdout).not.toContain('DEMO-ZUGÄNGE');
  }, 90000);
});

describe.skipIf(!coreGebaut)('v1.4 7.2: kern umzug packen, auspacken, pruefen (echtes core)', () => {
  const env = { KERN_PASSWORT: 'ein-langes-passwort', KERN_SECRET: 'u'.repeat(40) };
  const k = async (...args: string[]) => {
    let out = ''; let err = '';
    const code = await fuehreAus(args, { out: (s) => { out += s; }, err: (s) => { err += s; }, env });
    return { code, out, err };
  };
  it('Rundlauf ohne Abweichung, Manipulation wird erkannt, Pfade im Paket geprüft', async () => {
    const quelle = path.join(tmp, 'umzug-quelle');
    expect((await k('init', quelle, '--admin', 'chefin')).code).toBe(0);
    const datei = path.join(tmp, 'notiz.md');
    fs.writeFileSync(datei, '# Urlaub\n\nUrlaub wird drei Wochen vorher beantragt.\n');
    expect((await k('-d', quelle, 'add', datei)).code).toBe(0);
    const paket = path.join(tmp, 'umzug.tar');
    const p = await k('-d', quelle, 'umzug', 'packen', paket, '--unverschluesselt');
    expect(p.code, p.err).toBe(0);
    const ziel = path.join(tmp, 'umzug-ziel');
    expect((await k('umzug', 'auspacken', paket, ziel)).code).toBe(0);
    expect(fs.existsSync(path.join(ziel, '.kern/users.json'))).toBe(true);
    expect(fs.existsSync(path.join(ziel, '.kern/index.sqlite'))).toBe(false);
    const r = await k('umzug', 'pruefen', ziel, '--json');
    expect(r.code, r.out + r.err).toBe(0);
    expect(JSON.parse(r.out)).toMatchObject({ format: 'kern-pruefbericht/1', pruefsummen_ok: true, git_fsck_ok: true, head_gleich: true, index_neu: true, bestanden: true });
    // Anmeldung am Ziel geht mit dem alten Passwort
    const core = (await import('@kern/core' as string)) as { Kern: { open(c: object): Promise<{ benutzer: { pruefe(n: string, p: string): Promise<unknown> }; schliesse?(): Promise<void> }> } };
    const kz = await core.Kern.open({ dataDir: ziel, provider: { art: 'mock' }, betrieb: 'x', sprache: 'de' });
    expect(await kz.benutzer.pruefe('chefin', 'ein-langes-passwort')).toBeTruthy();
    await kz.schliesse?.();
    // Manipulation
    const ziel2 = path.join(tmp, 'umzug-ziel2');
    await k('umzug', 'auspacken', paket, ziel2);
    const q = fs.readdirSync(path.join(ziel2, 'quellen'), { recursive: true }).map(String).find((x) => x.endsWith('.md'))!;
    fs.appendFileSync(path.join(ziel2, 'quellen', q), '\nmanipuliert\n');
    expect((await k('umzug', 'pruefen', ziel2)).code).toBe(1);
    // ohne Wahl der Verschlüsselung → Abbruch
    expect((await k('-d', quelle, 'umzug', 'packen', path.join(tmp, 'x.tar'))).code).toBe(1);
    // Paket mit Ausbruchspfad wird abgewiesen
    const boese = path.join(tmp, 'boese');
    fs.mkdirSync(path.join(boese, 'daten'), { recursive: true });
    fs.writeFileSync(path.join(boese, 'manifest.json'), '{"format":"kern-umzug/1"}');
    fs.writeFileSync(path.join(tmp, 'aussen.txt'), 'x');
    const { execFileSync } = await import('node:child_process');
    execFileSync('tar', ['-C', boese, '-cf', path.join(tmp, 'boese.tar'), 'manifest.json', 'daten', '../aussen.txt']);
    expect((await k('umzug', 'auspacken', path.join(tmp, 'boese.tar'), path.join(tmp, 'boese-ziel'))).code).toBe(1);
  }, 120000);

  it('verschlüsselt mit age-Empfänger und wieder entschlüsselt', async () => {
    const { execFileSync, spawnSync } = await import('node:child_process');
    if (spawnSync('age-keygen', ['--version']).status !== 0) return;
    const schl = path.join(tmp, 'id.txt');
    execFileSync('age-keygen', ['-o', schl], { stdio: 'ignore' });
    const pub = /public key: (age1\w+)/.exec(fs.readFileSync(schl, 'utf8'))![1]!;
    const quelle = path.join(tmp, 'umzug-quelle');
    const paket = path.join(tmp, 'umzug.tar.age');
    expect((await k('-d', quelle, 'umzug', 'packen', paket, '--empfaenger', pub)).code).toBe(0);
    expect(fs.readFileSync(paket).subarray(0, 21).toString()).toBe('age-encryption.org/v1');
    const ziel = path.join(tmp, 'umzug-ziel-age');
    expect((await k('umzug', 'auspacken', paket, ziel, '-i', schl)).code).toBe(0);
    expect((await k('umzug', 'pruefen', ziel)).code).toBe(0);
  }, 120000);
});

describe('v1.4 6.5: kern mcp (stdio) und kern mcp --verbinde (Attrappe)', () => {
  const cli = path.join(__dirname, '..', 'dist', 'cli.js');
  it('stdio-Server auf dem Datenordner mit den Rechten von KERN_ALS', async () => {
    const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
    const { StdioClientTransport } = await import('@modelcontextprotocol/sdk/client/stdio.js');
    const c = new Client({ name: 't', version: '1' });
    await c.connect(new StdioClientTransport({ command: process.execPath, args: [cli, '-d', daten, '--fake', 'mcp'], env: { ...process.env, KERN_ALS: 'chef' } as Record<string, string>, stderr: 'ignore' }));
    const tools = await c.listTools();
    expect(tools.tools.map((t) => t.name)).toContain('kern_suche');
    const r = await c.callTool({ name: 'kern_eingang', arguments: {} });
    expect(r.isError).toBeFalsy();
    await c.close();
  }, 30000);

  it('ohne Benutzer bricht kern mcp ab; --verbinde ohne Token bricht ab', async () => {
    expect((await kern('mcp')).code).toBe(1);
    expect((await kern('mcp', '--verbinde', 'https://x.example/mcp')).code).toBe(1);
  });

  it('Brücke stdio → Streamable HTTP mit Token aus der Umgebung', async () => {
    const server = await import('@kern/server');
    const config = server.ladeKonfiguration({ dataDir: daten, env: { KERN_FAKE: '1', KERN_SECRET: 's'.repeat(40) } });
    config.port = 0; config.host = '127.0.0.1';
    const lauf = await server.starteServer({ config, beobachten: false, leise: true });
    try {
      const chef = (await lauf.kern.benutzer.liste()).find((u) => u.name === 'chef')!;
      const { token } = lauf.app.erzeugeToken(chef);
      const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
      const { StdioClientTransport } = await import('@modelcontextprotocol/sdk/client/stdio.js');
      const c = new Client({ name: 't', version: '1' });
      await c.connect(new StdioClientTransport({ command: process.execPath, args: [cli, 'mcp', '--verbinde', `${lauf.url}/mcp`], env: { ...process.env, KERN_TOKEN: token } as Record<string, string>, stderr: 'ignore' }));
      expect((await c.listTools()).tools.length).toBeGreaterThan(3);
      expect((await c.callTool({ name: 'kern_eingang', arguments: {} })).isError).toBeFalsy();
      await c.close();
    } finally { await lauf.stop(); }
  }, 30000);
});
