#!/usr/bin/env node
/** kern-betrieb: admin anlegen | token erzeugen | planer */
import { oeffneDb } from './db.js';
import { Admins } from './auth.js';
import { Leitstand } from './leitstand.js';
import { LokalBereitsteller } from './bereitsteller/lokal.js';
import { DummyBereitsteller } from './bereitsteller/dummy.js';
import { createInterface } from 'node:readline/promises';

const [cmd, sub, name] = process.argv.slice(2);
const db = oeffneDb(process.env.BETRIEB_DB ?? './leitstand/leitstand.sqlite');
const admins = new Admins(db);

async function frage(text: string): Promise<string> {
  if (process.env.BETRIEB_PASSWORT) return process.env.BETRIEB_PASSWORT;
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const a = await rl.question(text);
  rl.close();
  return a;
}

if (cmd === 'admin' && sub === 'anlegen' && name) {
  const pw = await frage('Passwort (mind. 14 Zeichen): ');
  const r = admins.anlegen(name, pw);
  console.log(`Admin ${name} angelegt.\nTOTP-Geheimnis (in die Authenticator-App eintragen, wird nicht wieder angezeigt):\n  ${r.secret}\n  ${r.uri}`);
} else if (cmd === 'token' && sub === 'erzeugen' && name) {
  console.log(admins.tokenErzeugen(name));
} else if (cmd === 'planer') {
  const b = process.env.BETRIEB_BEREITSTELLER === 'lokal' ? new LokalBereitsteller(process.env.BETRIEB_LOKAL_ORDNER ?? './leitstand/instanzen') : new DummyBereitsteller();
  const r = await new Leitstand({ db, bereitsteller: b }).planer();
  console.log(JSON.stringify(r, null, 2));
} else {
  console.log('kern-betrieb admin anlegen <name> | token erzeugen <name> | planer');
  process.exitCode = 1;
}
