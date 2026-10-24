#!/usr/bin/env node
import { existsSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { Kern, type Sichtbarkeit } from '@kern/core';
import { parse as parseYaml } from 'yaml';
import { readFile } from 'node:fs/promises';
import { bestandsaufnahme } from './bestand.js';
import { berichtAlsMarkdown, importiereOutline } from './importieren.js';
import { lese } from './lese.js';

const HILFE = `kern-import-outline: Outline-Wiki nach Kern übernehmen (Quellen plus Vorschläge im Eingang)

Aufruf:
  kern-import-outline [<export.zip | export-ordner | mcp-abzug>] --daten <kern-data> [Optionen]
  Ohne Pfad: Outline-API mit OUTLINE_URL und OUTLINE_API_TOKEN (nur lesende Aufrufe).

Optionen:
  --daten <ordner>       Kern-Datenordner (Standard: KERN_DATA oder ./kern-data)
  --als <name>           als dieser Kern-Benutzer handeln (Standard: KERN_ALS oder der erste Admin)
  --trockenlauf          nur planen und berichten, nichts schreiben
  --bestand              nur zählen (Sammlungen, Dokumente, Tabellen, Bilder, Links), nichts schreiben
  --rechte <datei.yaml>  Sichtbarkeit je Sammlung, z. B. "Strategie (privat)": ich
  --privat-als <s>       Sichtbarkeit für private Outline-Sammlungen (Standard: ich)
  --sammlung <name>      nur diese Sammlung(en) (API), mehrfach möglich
  --basis-url <url>      Wiki-Adresse (für JSON-Export und Link-Erkennung; sonst OUTLINE_URL)
  --nur-quellen          keine Wissen-Vorschläge anlegen
  --kompilieren          zusätzlich KI-Kompilierung (teuer)
  --ohne-kommentare      Kommentare nicht übernehmen
  --ohne-anhaenge        Anhänge nicht laden
  --freigeben            Vorschläge sofort freigeben (nur Rolle freigeber; nur nach Prüfung des Trockenlaufs)
  --bericht <datei.md>   Bericht zusätzlich als Datei schreiben
  --json                 Bericht als JSON ausgeben`;

async function main(): Promise<number> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      daten: { type: 'string' }, als: { type: 'string' }, trockenlauf: { type: 'boolean' }, bestand: { type: 'boolean' },
      rechte: { type: 'string' }, 'privat-als': { type: 'string' }, sammlung: { type: 'string', multiple: true },
      'basis-url': { type: 'string' }, 'nur-quellen': { type: 'boolean' }, kompilieren: { type: 'boolean' },
      'ohne-kommentare': { type: 'boolean' }, 'ohne-anhaenge': { type: 'boolean' }, freigeben: { type: 'boolean' },
      bericht: { type: 'string' }, json: { type: 'boolean' }, hilfe: { type: 'boolean', short: 'h' },
    },
  });
  if (values.hilfe) {
    console.log(HILFE);
    return 0;
  }
  const buendel = await lese({
    ...(positionals[0] ? { pfad: positionals[0] } : {}),
    ...(values['basis-url'] ? { basisUrl: values['basis-url'] } : {}),
    ...(values.sammlung ? { sammlungen: values.sammlung } : {}),
    kommentare: !values['ohne-kommentare'],
    anhaenge: !values['ohne-anhaenge'],
  });
  if (values.bestand) {
    console.log(JSON.stringify(bestandsaufnahme(buendel), null, 2));
    return 0;
  }
  const dataDir = values.daten ?? process.env['KERN_DATA'] ?? './kern-data';
  const trocken = !!values.trockenlauf;
  const kern = existsSync(dataDir) || !trocken ? await Kern.open({ dataDir, provider: { art: 'mock' }, betrieb: 'Kern', sprache: 'de' }) : null;
  try {
    const nutzer = kern ? await kern.benutzer.liste() : [];
    const name = values.als ?? process.env['KERN_ALS'];
    const u = name ? nutzer.find((x) => x.name === name) : nutzer.find((x) => x.rollen.includes('admin'));
    if (!u && !trocken) throw new Error(name ? `Benutzer "${name}" gibt es nicht` : 'Kein Admin im Datenordner; erst „kern init“ und „kern nutzer anlegen“');
    const rechte = values.rechte ? (parseYaml(await readFile(values.rechte, 'utf8')) as Record<string, Sichtbarkeit>) : undefined;
    const bericht = await importiereOutline(kern, u ?? { id: 'trockenlauf', name: 'trockenlauf', rollen: ['admin'], teams: [] }, buendel, {
      datenOrdner: dataDir,
      trockenlauf: trocken,
      ...(rechte ? { rechte } : {}),
      ...(values['privat-als'] ? { privatAls: values['privat-als'] as Sichtbarkeit } : {}),
      wissen: !values['nur-quellen'],
      kompilieren: !!values.kompilieren,
      kommentare: !values['ohne-kommentare'],
      anhaenge: !values['ohne-anhaenge'],
      freigeben: !!values.freigeben,
    });
    const md = berichtAlsMarkdown(bericht);
    if (values.bericht) await writeFile(values.bericht, md);
    console.log(values.json ? JSON.stringify(bericht, null, 2) : md);
    if (kern && !trocken) await kern.reindex();
    return 0;
  } finally {
    await kern?.schliesse();
  }
}

main().then(
  (c) => process.exit(c),
  (e: Error) => {
    console.error(`Fehler: ${e.message}`);
    process.exit(1);
  },
);
