import { readFile, stat, readdir } from 'node:fs/promises';
import { join, posix, relative, sep } from 'node:path';
import JSZip from 'jszip';
import { parse as parseYaml } from 'yaml';
import { ordneNachBaum } from '../baum.js';
import { prosemirrorZuMarkdown, type PmKnoten } from '../prosemirror.js';
import type { OutlineAnhang, OutlineBuendel, OutlineDokument, OutlineKnoten, OutlineSammlung } from '../typen.js';
import { urlIdAusPfad } from '../typen.js';

/**
 * Liest einen Outline-Export (Einstellungen › Export): Markdown-ZIP, OKF-ZIP (ab Outline 1.10.1) oder JSON-ZIP.
 * Auch ein bereits entpackter Ordner geht. Das Format wird am Inhalt erkannt.
 *
 * Aufbau laut Outline-Quelltext (server/queues/tasks/ExportDocumentTreeTask.ts, ExportJSONTask.ts, Stand 1.12.0):
 * - Markdown/OKF: `<Sammlung>/<Titel>.md`, Unterseiten in `<Sammlung>/<Titel>/…`, Anhänge unter ihrem
 *   Speicherschlüssel relativ zum Dokumentordner, interne Links als relative Pfade, Zeitstempel im ZIP-Kommentar.
 *   OKF zusätzlich mit YAML-Kopf (type, title, description, resource, status, generated) und `index.md`.
 * - JSON: je Sammlung `<Sammlung>.json` mit collection (inkl. documentStructure, permission), documents
 *   (ProseMirror-JSON in `data`) und attachments (Schlüssel = Pfad im ZIP), dazu `metadata.json`.
 */
export async function leseExport(pfad: string, opt: { basisUrl?: string | null } = {}): Promise<OutlineBuendel> {
  const dateien = await ladeDateien(pfad);
  const namen = [...dateien.keys()];
  const basisUrl = opt.basisUrl?.replace(/\/+$/, '') ?? null;
  const jsonSammlungen = namen.filter((n) => n.endsWith('.json') && !n.includes('/') && n !== 'metadata.json');
  if (namen.includes('metadata.json') && jsonSammlungen.length) return leseJson(dateien, jsonSammlungen, basisUrl);
  return leseMarkdown(dateien, basisUrl);
}

interface Datei {
  daten: () => Promise<Buffer>;
  kommentar: string | null;
  datum: Date | null;
}

async function ladeDateien(pfad: string): Promise<Map<string, Datei>> {
  const st = await stat(pfad);
  const out = new Map<string, Datei>();
  if (st.isDirectory()) {
    const lauf = async (abs: string) => {
      for (const x of await readdir(abs, { withFileTypes: true })) {
        const p = join(abs, x.name);
        if (x.isDirectory()) await lauf(p);
        else if (x.isFile()) {
          const rel = relative(pfad, p).split(sep).join('/');
          out.set(rel, { daten: () => readFile(p), kommentar: null, datum: (await stat(p)).mtime });
        }
      }
    };
    await lauf(pfad);
    return out;
  }
  const zip = await JSZip.loadAsync(await readFile(pfad));
  zip.forEach((rel, f) => {
    if (f.dir) return;
    const name = posix.normalize(rel).replace(/^(\.\.\/)+/, '');
    out.set(name, { daten: () => f.async('nodebuffer'), kommentar: (f as unknown as { comment?: string }).comment ?? null, datum: f.date ?? null });
  });
  return out;
}

function zeitAusKommentar(d: Datei): { createdAt: string | null; updatedAt: string | null } {
  if (d.kommentar) {
    try {
      const j = JSON.parse(d.kommentar) as { createdAt?: string; updatedAt?: string };
      return { createdAt: j.createdAt ?? null, updatedAt: j.updatedAt ?? null };
    } catch {
      /* kein JSON */
    }
  }
  return { createdAt: null, updatedAt: d.datum ? d.datum.toISOString() : null };
}

async function leseMarkdown(dateien: Map<string, Datei>, basisUrlOpt: string | null): Promise<OutlineBuendel> {
  const warnungen: string[] = [];
  const md = [...dateien.keys()].filter((n) => n.endsWith('.md') && n.includes('/')).sort();
  const okf = dateien.has('index.md') && /okf_version/.test((await dateien.get('index.md')!.daten()).toString('utf8'));
  const sammlungsNamen = [...new Set(md.map((n) => n.split('/')[0]!))];
  const dokumente: OutlineDokument[] = [];
  let basisUrl = basisUrlOpt;
  for (const n of md) {
    const d = dateien.get(n)!;
    let text = (await d.daten()).toString('utf8');
    let kopf: Record<string, unknown> = {};
    const fm = /^---\n([\s\S]*?)\n---\n?/.exec(text);
    if (fm) {
      try {
        kopf = (parseYaml(fm[1]!) as Record<string, unknown>) ?? {};
      } catch {
        warnungen.push(`${n}: YAML-Kopf nicht lesbar`);
      }
      text = text.slice(fm[0].length);
    }
    const h1 = /^\s*#\s+(.+)\n?/.exec(text);
    const dateiTitel = posix.basename(n, '.md').replace(/ \(\d+\)$/, '');
    let titel = typeof kopf['title'] === 'string' ? (kopf['title'] as string) : h1 ? h1[1]!.trim() : dateiTitel;
    if (h1) text = text.slice(h1[0].length);
    if (!kopf['title'] && h1 && !titel.startsWith(dateiTitel.slice(0, 3))) titel = titel.replace(/^\S+\s+/, '');
    const resource = typeof kopf['resource'] === 'string' ? (kopf['resource'] as string) : null;
    if (resource && !basisUrl) basisUrl = new URL(resource).origin;
    const urlId = resource ? urlIdAusPfad(resource) : null;
    const zeit = zeitAusKommentar(d);
    const gen = kopf['generated'] as { by?: string; at?: string } | undefined;
    const elternPfad = posix.dirname(n) + '.md';
    dokumente.push({
      schluessel: urlId ?? `zip:${n}`,
      id: null,
      urlId,
      url: resource,
      titel,
      icon: null,
      sammlungId: n.split('/')[0]!,
      elternId: dateien.has(elternPfad) ? (await schluesselFuer(dateien, elternPfad)) : null,
      exportPfad: n,
      markdown: text.replace(/^\s+/, '').replace(/\s+$/, '') + '\n',
      erstelltAm: zeit.createdAt,
      geaendertAm: gen?.at ?? zeit.updatedAt,
      veroeffentlichtAm: null,
      archiviertAm: kopf['status'] === 'deprecated' ? (gen?.at ?? zeit.updatedAt) : null,
      autor: null,
      geaendertVon: gen?.by ? gen.by.replace(/^human:/, '') : null,
      revision: null,
      breadcrumb: [n.split('/')[0]!, ...posix.dirname(n).split('/').slice(1)].join(' › '),
    });
  }
  // Eltern beziehen sich auf Schlüssel, nicht auf Outline-IDs
  const anhaenge: OutlineAnhang[] = [];
  for (const [n, d] of dateien) {
    if (n.endsWith('.md') || n === 'metadata.json') continue;
    anhaenge.push({ id: idAusSchluessel(n), name: posix.basename(n), contentType: null, groesse: null, exportPfad: n, dokumente: [], lade: () => d.daten() });
  }
  const sammlungen: OutlineSammlung[] = sammlungsNamen.map((name) => ({ id: name, urlId: null, url: null, name, beschreibung: null, permission: null, baum: [] }));
  if (!okf) warnungen.push('Markdown-Export: keine Outline-Kennungen und keine Rechte im Archiv. Wiederholungsläufe erkennen Dokumente am Pfad; ein umbenanntes Dokument gilt als neu. Besser: JSON-Export oder API.');
  else warnungen.push('OKF-Export: keine Rechte im Archiv; Sichtbarkeit kommt aus der Zuordnung (Standard: privat).');
  const b: OutlineBuendel = { art: okf ? 'okf-zip' : 'markdown-zip', basisUrl, sammlungen, dokumente, anhaenge, kommentare: [], warnungen };
  // Reihenfolge: Eltern vor Kindern (Pfadtiefe)
  b.dokumente.sort((x, y) => (x.exportPfad!.split('/').length - y.exportPfad!.split('/').length) || x.exportPfad!.localeCompare(y.exportPfad!));
  return b;
}

async function schluesselFuer(dateien: Map<string, Datei>, n: string): Promise<string> {
  const text = (await dateien.get(n)!.daten()).toString('utf8');
  const res = /^---\n[\s\S]*?^resource:\s*(\S+)[\s\S]*?\n---/m.exec(text)?.[1];
  const urlId = res ? urlIdAusPfad(res) : null;
  return urlId ?? `zip:${n}`;
}

function idAusSchluessel(n: string): string | null {
  const m = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/[^/]+$/i.exec(n);
  return m ? m[1]!.toLowerCase() : null;
}

interface JsonExport {
  collection: { id: string; urlId: string; name: string; permission?: 'read' | 'read_write' | null; documentStructure: OutlineKnoten[] | null; data?: PmKnoten | null };
  documents: Record<string, { id: string; urlId: string; title: string; icon?: string | null; emoji?: string | null; data: PmKnoten; createdByName?: string; createdAt: string; updatedAt: string; publishedAt: string | null; parentDocumentId: string | null }>;
  attachments: Record<string, { id: string; documentId: string | null; contentType: string; name: string; size: number; key: string }>;
}

async function leseJson(dateien: Map<string, Datei>, namen: string[], basisUrl: string | null): Promise<OutlineBuendel> {
  const warnungen: string[] = [];
  const sammlungen: OutlineSammlung[] = [];
  const dokumente: OutlineDokument[] = [];
  const anhaenge: OutlineAnhang[] = [];
  for (const n of namen.sort()) {
    const j = JSON.parse((await dateien.get(n)!.daten()).toString('utf8')) as JsonExport;
    const c = j.collection;
    sammlungen.push({
      id: c.id,
      urlId: c.urlId ?? null,
      url: basisUrl && c.urlId ? `${basisUrl}/collection/${c.urlId}` : null,
      name: c.name,
      beschreibung: c.data ? prosemirrorZuMarkdown(c.data).trim() : null,
      permission: c.permission ?? null,
      baum: c.documentStructure ?? [],
    });
    const urlZu = new Map<string, string>();
    const lauf = (k: OutlineKnoten[]) => k.forEach((x) => (urlZu.set(x.id, x.url), lauf(x.children ?? [])));
    lauf(c.documentStructure ?? []);
    for (const d of Object.values(j.documents)) {
      const unbekannt = new Set<string>();
      const markdown = prosemirrorZuMarkdown(d.data, unbekannt);
      if (unbekannt.size) warnungen.push(`${d.title}: unbekannte Bausteine als Text übernommen (${[...unbekannt].join(', ')})`);
      const pfad = urlZu.get(d.id) ?? `/doc/${d.urlId}`;
      dokumente.push({
        schluessel: d.urlId ?? d.id,
        id: d.id,
        urlId: d.urlId ?? null,
        url: basisUrl ? basisUrl + pfad : null,
        titel: d.title,
        icon: d.icon ?? d.emoji ?? null,
        sammlungId: c.id,
        elternId: d.parentDocumentId,
        exportPfad: null,
        markdown,
        erstelltAm: d.createdAt,
        geaendertAm: d.updatedAt,
        veroeffentlichtAm: d.publishedAt,
        archiviertAm: null,
        autor: d.createdByName ?? null,
        geaendertVon: null,
        revision: null,
        breadcrumb: null,
      });
    }
    for (const a of Object.values(j.attachments)) {
      const datei = dateien.get(a.key);
      if (!datei) warnungen.push(`Anhang ${a.name}: Datei ${a.key} fehlt im Archiv`);
      anhaenge.push({
        id: a.id.toLowerCase(),
        name: a.name,
        contentType: a.contentType,
        groesse: a.size,
        exportPfad: a.key,
        dokumente: [],
        lade: datei ? () => datei.daten() : null,
      });
    }
  }
  // Anhänge den Dokumenten zuordnen (über Verweise im Text)
  const nachId = new Map(anhaenge.filter((a) => a.id).map((a) => [a.id!, a]));
  for (const d of dokumente) {
    for (const m of d.markdown.matchAll(/attachments\.redirect\?id=([0-9a-f-]{36})/gi)) {
      const a = nachId.get(m[1]!.toLowerCase());
      if (a && !a.dokumente.includes(d.schluessel)) a.dokumente.push(d.schluessel);
    }
  }
  // Eltern auf Schlüssel (urlId) abbilden
  const idZuSchluessel = new Map(dokumente.filter((d) => d.id).map((d) => [d.id!, d.schluessel]));
  for (const d of dokumente) if (d.elternId) d.elternId = idZuSchluessel.get(d.elternId) ?? null;
  const b = ordneNachBaum({ art: 'json-zip', basisUrl, sammlungen, dokumente, anhaenge, kommentare: [], warnungen });
  if (!basisUrl) b.warnungen.push('JSON-Export enthält keine Wiki-Adresse; mit --basis-url angeben, damit volle Links erkannt werden.');
  return b;
}
