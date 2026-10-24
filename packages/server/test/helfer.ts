import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { erstelleApp, ladeKonfiguration, oeffneKern, type KernLike, type ServerConfig } from '../src/index.js';

export const PASSWORT = 'sehr-geheimes-passwort';

export const ARTIKEL = `---
titel: Urlaubsregel
gruppe: betrieb
kurzfassung: Urlaub wird drei Wochen vorher beantragt.
stand: 2026-10-01
verantwortlich: Chefin
pruefen_bis: 2020-01-01
sichtbarkeit: betrieb
besitzer: niemand
fundstellen:
  - quelle: quellen/2026/handbuch.md
    abschnitt: Urlaub
    zeilen: [1, 3]
fakten:
  - id: f1
    art: frist
    gegenstand: Urlaubsantrag Vorlauf
    wert: 21
    einheit: Tage
    gilt_ab: 2026-01-01
    fundstelle: fs1
status: freigegeben
---
## Urlaub

Urlaub wird drei Wochen vorher im Büro beantragt.
`;

export interface TestUmgebung {
  dir: string;
  kern: KernLike;
  config: ServerConfig;
  app: ReturnType<typeof erstelleApp>;
  nutzer: Record<'admin' | 'freigeber' | 'autor' | 'leser', { id: string }>;
  aufraeumen(): void;
}

export async function baueUmgebung(env: Record<string, string> = {}): Promise<TestUmgebung> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kern-server-'));
  const config = ladeKonfiguration({
    dataDir: dir,
    env: { KERN_FAKE: '1', KERN_SECRET: 'x'.repeat(40), KERN_WEB_DIST: path.join(dir, 'kein-web'), ...env },
  });
  const kern = await oeffneKern(config.kern, true);
  const nutzer = {
    admin: await kern.benutzer.anlegen('admin', PASSWORT, ['admin']),
    freigeber: await kern.benutzer.anlegen('frei', PASSWORT, ['freigeber', 'autor']),
    autor: await kern.benutzer.anlegen('autor', PASSWORT, ['autor']),
    leser: await kern.benutzer.anlegen('leser', PASSWORT, ['leser']),
  };
  fs.mkdirSync(path.join(dir, 'wissen/betrieb'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'wissen/betrieb/urlaub.md'), ARTIKEL);
  fs.mkdirSync(path.join(dir, 'quellen/2026'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'quellen/2026/handbuch.md'), '---\ntitel: Handbuch\nart: text\nherkunft: text\nerfasst_am: 2026-10-01\nerfasst_von: niemand\nsichtbarkeit: betrieb\nsammlung: allgemein\nhash: x\nersetzt: null\nbeobachtet: false\n---\n## Urlaub\n\nUrlaub drei Wochen vorher.\n');
  fs.writeFileSync(path.join(dir, 'quellen/2026/handbuch.orig.txt'), 'Original-Handbuch');
  const app = erstelleApp({ kern, config });
  return { dir, kern, config, app, nutzer, aufraeumen: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

/** Kleiner Client mit Cookie-Speicher gegen app.request (ohne Netz). */
export class Client {
  cookie = '';
  constructor(private app: TestUmgebung['app']['app']) {}

  async req(methode: string, pfad: string, opt: { json?: unknown; body?: BodyInit; headers?: Record<string, string>; csrf?: boolean } = {}) {
    const headers: Record<string, string> = { ...(opt.headers ?? {}) };
    if (this.cookie) headers.cookie = this.cookie;
    if (opt.csrf !== false && methode !== 'GET') headers['x-kern'] = '1';
    let body = opt.body;
    if (opt.json !== undefined) {
      headers['content-type'] = 'application/json';
      body = JSON.stringify(opt.json);
    }
    const res = await this.app.request(`http://kern.test${pfad}`, { method: methode, headers, body });
    const sc = res.headers.get('set-cookie');
    if (sc) {
      const wert = sc.split(';')[0]!;
      this.cookie = /=$/.test(wert) || /Max-Age=0/i.test(sc) ? '' : wert;
    }
    return res;
  }

  async login(name: string, passwort = PASSWORT) {
    return this.req('POST', '/api/login', { json: { name, passwort } });
  }
}
