import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { extname, join, posix } from 'node:path';
import { parseMarkdown, slugify, stringifyMarkdown, type Kern, type Quelle, type Sichtbarkeit, type User, type Vorschlag } from '@kern/core';
import { schreibeLinksUm, type LinkErgebnis } from './links.js';
import type { OutlineAnhang, OutlineBuendel, OutlineDokument, OutlineKommentar, OutlineSammlung } from './typen.js';
import { datumTeil } from './typen.js';

export interface ImportOptionen {
  /** Kern-Datenordner (für Zeilennummern der Fundstellen); Pflicht für einen echten Lauf. */
  datenOrdner?: string;
  /** Sichtbarkeit je Sammlung (Schlüssel: Name, id oder urlId). Geht vor den Standards. */
  rechte?: Record<string, Sichtbarkeit>;
  /** Für Outline-Sammlungen ohne Arbeitsbereichs-Freigabe (permission null). Standard „ich“ (sicherste Wahl). */
  privatAls?: Sichtbarkeit;
  /** Für Sammlungen mit permission read/read_write. Standard „betrieb“. */
  freigegebenAls?: Sichtbarkeit;
  /** 1:1-Vorschläge für wissen/ anlegen (Standard true). Ohne: nur Quellen. */
  wissen?: boolean;
  /** Zusätzlich die KI-Kompilierung von Kern laufen lassen (Standard false, teuer bei großen Wikis). */
  kompilieren?: boolean;
  /** Kommentare als eigene Quelle je Dokument (Standard true). */
  kommentare?: boolean;
  /** Anhänge laden und, soweit Kern den Typ lesen kann, als Quelle anlegen (Standard true). */
  anhaenge?: boolean;
  /** Nur planen und berichten, nichts schreiben. */
  trockenlauf?: boolean;
  /** Angelegte Vorschläge sofort freigeben (nur mit Rolle freigeber, nur auf ausdrücklichen Wunsch). */
  freigeben?: boolean;
  /** Präfix der Kern-Sammlung, Standard „outline“ → „outline-marke-branding“. */
  sammlungPraefix?: string;
}

export type Aktion = 'neu' | 'aktualisieren' | 'unveraendert' | 'uebersprungen';

export interface DokumentBericht {
  schluessel: string;
  titel: string;
  outlineUrl: string | null;
  sammlung: string;
  sichtbarkeit: Sichtbarkeit;
  quelle: { aktion: Aktion; pfad: string | null };
  wissen: { aktion: Aktion; ziel: string | null; vorschlag: string | null; freigegeben: boolean } | null;
  links: { aufgeloest: number; offen: LinkErgebnis['offen']; erwaehnungen: number };
  kommentare: number;
  hinweise: string[];
}

export interface ImportBericht {
  art: OutlineBuendel['art'];
  basisUrl: string | null;
  trockenlauf: boolean;
  sammlungen: { name: string; gruppe: string; kernSammlung: string; permission: OutlineSammlung['permission']; sichtbarkeit: Sichtbarkeit; grund: string; dokumente: number }[];
  dokumente: DokumentBericht[];
  anhaenge: { name: string; aktion: Aktion; pfad: string | null; grund: string }[];
  summe: { dokumente: number; neu: number; aktualisiert: number; unveraendert: number; vorschlaege: number; freigegeben: number; anhaengeAlsQuelle: number; anhaengeOffen: number; linksAufgeloest: number; linksOffen: number; kommentare: number };
  warnungen: string[];
}

const LESBAR = new Set(['.pdf', '.docx', '.md', '.markdown', '.txt', '.html', '.htm']);
const GRUND = 'Outline-Import';

function gruppeFuer(s: OutlineSammlung): string {
  const g = slugify(s.name).replace(/^_+/, '') || 'outline';
  return g === '_regeln' ? 'outline-regeln' : g;
}

function sichtbarkeitFuer(s: OutlineSammlung, opt: ImportOptionen, u: User): { sichtbarkeit: Sichtbarkeit; grund: string } {
  const r = opt.rechte ?? {};
  const treffer = r[s.name] ?? r[s.id] ?? (s.urlId ? r[s.urlId] : undefined);
  let sicht: Sichtbarkeit;
  let grund: string;
  if (treffer) {
    sicht = treffer;
    grund = 'aus der Zuordnung';
  } else if (s.permission === null) {
    sicht = opt.privatAls ?? 'ich';
    grund = 'Outline: privat (nur Mitglieder); Mitgliederliste ist nicht übertragbar';
  } else {
    sicht = opt.freigegebenAls ?? 'betrieb';
    grund = `Outline: für den ganzen Arbeitsbereich (${s.permission})`;
  }
  if (sicht.startsWith('team:') && !u.rollen.includes('admin') && !u.teams.includes(sicht.slice(5))) {
    grund += `; ${u.name} ist nicht im Team ${sicht.slice(5)}, deshalb „ich“`;
    sicht = 'ich';
  }
  return { sichtbarkeit: sicht, grund };
}

const sha = (t: string | Buffer) => createHash('sha256').update(t).digest('hex');

function kurzfassung(md: string, titel: string): string {
  const absatz = md
    .split(/\n\s*\n/)
    .map((a) => a.trim())
    .find((a) => a && !/^(#|!\[|\||```|---|>|\* |- |\d+\. )/.test(a));
  const roh = (absatz ?? '')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[*_`~]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!roh) return `Aus Outline übernommen: ${titel}.`;
  return roh.length > 300 ? roh.slice(0, 297).replace(/\s+\S*$/, '') + ' …' : roh;
}

function quellText(d: OutlineDokument, s: OutlineSammlung): string {
  const kopf: Record<string, unknown> = {
    titel: d.titel,
    outline_schluessel: d.schluessel,
    ...(d.id ? { outline_id: d.id } : {}),
    ...(d.urlId ? { outline_url_id: d.urlId } : {}),
    ...(d.url ? { outline_url: d.url } : {}),
    outline_sammlung: s.name,
    outline_sammlung_id: s.id,
    outline_eltern: d.elternId,
    ...(d.breadcrumb ? { outline_pfad: d.breadcrumb } : {}),
    ...(d.exportPfad ? { outline_exportpfad: d.exportPfad } : {}),
    ...(d.erstelltAm ? { outline_erstellt_am: d.erstelltAm } : {}),
    ...(d.geaendertAm ? { outline_geaendert_am: d.geaendertAm } : {}),
    ...(d.autor ? { outline_autor: d.autor } : {}),
    ...(d.geaendertVon ? { outline_geaendert_von: d.geaendertVon } : {}),
    ...(d.revision !== null ? { outline_revision: d.revision } : {}),
    ...(d.archiviertAm ? { outline_archiviert_am: d.archiviertAm } : {}),
  };
  const herkunft = [
    d.url ? `[${d.titel}](${d.url})` : d.titel,
    d.breadcrumb ? `Pfad: ${d.breadcrumb}` : null,
    datumTeil(d.geaendertAm) ? `Stand: ${datumTeil(d.geaendertAm)}` : null,
    d.geaendertVon ?? d.autor ? `zuletzt: ${d.geaendertVon ?? d.autor}` : null,
  ].filter(Boolean);
  return stringifyMarkdown(kopf, `> Aus Outline: ${herkunft.join(' · ')}\n\n${d.markdown.trim()}\n`);
}

function kommentarText(d: OutlineDokument, liste: OutlineKommentar[]): string {
  const wurzeln = liste.filter((k) => !k.elternId || !liste.some((x) => x.id === k.elternId));
  const zeile = (k: OutlineKommentar) => `${k.autor}, ${k.erstelltAm.slice(0, 16).replace('T', ' ')}${k.erledigtAm ? ' (erledigt)' : ' (offen)'}`;
  const teile: string[] = [`> Kommentare zu „${d.titel}“ aus Outline${d.url ? ` (${d.url})` : ''}`];
  for (const w of wurzeln.sort((a, b) => a.erstelltAm.localeCompare(b.erstelltAm))) {
    teile.push(`## ${zeile(w)}\n\n${w.text.trim()}`);
    for (const a of liste.filter((x) => x.elternId === w.id).sort((a, b) => a.erstelltAm.localeCompare(b.erstelltAm))) {
      teile.push(`**Antwort: ${zeile(a)}**\n\n${a.text.trim().split('\n').map((z) => `> ${z}`).join('\n')}`);
    }
  }
  return stringifyMarkdown({ titel: `Kommentare: ${d.titel}`, outline_schluessel: `${d.schluessel}#kommentare`, ...(d.id ? { outline_id: d.id } : {}) }, teile.join('\n\n') + '\n');
}

/**
 * Plant (trockenlauf) oder führt den Import aus. Schreibt ausschließlich über die öffentliche Schnittstelle von @kern/core:
 * fuegeHinzu (Quellen), schlageVor (Wissen als Vorschlag), entscheide (nur mit `freigeben`).
 * Wiederholungsläufe erkennen Bestehendes an `herkunft` (Quellen) und `outline_schluessel` (Wissen, offene Vorschläge):
 * gleich ⇒ unverändert, geändert ⇒ neue Fassung bzw. Änderungsvorschlag, nie Dubletten.
 * `kern` darf im Trockenlauf null sein (leerer, noch nicht angelegter Datenordner).
 */
export async function importiereOutline(kern: Kern | null, u: User, b: OutlineBuendel, opt: ImportOptionen = {}): Promise<ImportBericht> {
  const trocken = !!opt.trockenlauf || !kern;
  if (!kern && !opt.trockenlauf) throw new Error('Für einen echten Lauf wird ein geöffneter Kern gebraucht');
  if (!trocken && !opt.datenOrdner) throw new Error('datenOrdner fehlt');
  if (opt.freigeben && !u.rollen.some((r) => r === 'freigeber' || r === 'admin')) throw new Error('freigeben braucht die Rolle freigeber');
  const praefix = opt.sammlungPraefix ?? 'outline';
  const mitWissen = opt.wissen !== false;
  const bericht: ImportBericht = {
    art: b.art,
    basisUrl: b.basisUrl,
    trockenlauf: trocken,
    sammlungen: [],
    dokumente: [],
    anhaenge: [],
    summe: { dokumente: b.dokumente.length, neu: 0, aktualisiert: 0, unveraendert: 0, vorschlaege: 0, freigegeben: 0, anhaengeAlsQuelle: 0, anhaengeOffen: 0, linksAufgeloest: 0, linksOffen: 0, kommentare: 0 },
    warnungen: [...b.warnungen],
  };

  // Bestand im Kern
  const quellenNachHerkunft = new Map<string, Quelle>();
  const wissenNachSchluessel = new Map<string, { pfad: string; text: string }>();
  const belegtePfade = new Set<string>();
  const offeneNachSchluessel = new Map<string, Vorschlag>();
  if (kern) {
    for (const q of await kern.listeQuellen(u)) quellenNachHerkunft.set(q.kopf.herkunft, q);
    for (const a of await kern.listeWissen(u)) {
      belegtePfade.add(a.pfad);
      const k = a.kopf as Record<string, unknown>;
      if (typeof k['outline_schluessel'] === 'string') wissenNachSchluessel.set(k['outline_schluessel'] as string, { pfad: a.pfad, text: a.text });
    }
    // core ab v1.3 begrenzt eingang() ohne {alle:true} auf wenige Einträge; ältere Fassungen kennen die Option nicht
    const eingang = kern.eingang as unknown as (u: User, o?: { alle?: boolean }) => Promise<Vorschlag[]>;
    for (const v of await eingang.call(kern, u, { alle: true })) {
      if (!v.grund.startsWith(GRUND)) continue;
      const k = parseMarkdown(v.neu).kopf;
      if (typeof k['outline_schluessel'] === 'string') offeneNachSchluessel.set(k['outline_schluessel'] as string, v);
      belegtePfade.add(v.ziel);
    }
  }

  const sammlungNach = new Map(b.sammlungen.map((s) => [s.id, s]));
  const infoNach = new Map<string, { gruppe: string; kernSammlung: string; sichtbarkeit: Sichtbarkeit }>();
  for (const s of b.sammlungen) {
    const g = gruppeFuer(s);
    const r = sichtbarkeitFuer(s, opt, u);
    infoNach.set(s.id, { gruppe: g, kernSammlung: `${praefix}-${g}`, sichtbarkeit: r.sichtbarkeit });
    bericht.sammlungen.push({ name: s.name, gruppe: g, kernSammlung: `${praefix}-${g}`, permission: s.permission, sichtbarkeit: r.sichtbarkeit, grund: r.grund, dokumente: b.dokumente.filter((d) => d.sammlungId === s.id).length });
  }

  // Zielpfade im Wissen festlegen (deterministisch, stabil über Läufe)
  const ziele = new Map<string, string>();
  for (const d of b.dokumente) {
    const vorhanden = wissenNachSchluessel.get(d.schluessel)?.pfad ?? offeneNachSchluessel.get(d.schluessel)?.ziel;
    if (vorhanden) {
      ziele.set(d.schluessel, vorhanden);
      continue;
    }
    const info = infoNach.get(d.sammlungId);
    const gruppe = info?.gruppe ?? 'outline';
    let slug = slugify(d.titel) || 'ohne-titel';
    if (slug === 'index' || slug === 'log') slug += '-seite';
    let pfad = `wissen/${gruppe}/${slug}.md`;
    if (belegtePfade.has(pfad)) pfad = `wissen/${gruppe}/${slug}-${(d.urlId ?? sha(d.schluessel).slice(0, 8)).toLowerCase()}.md`;
    for (let i = 2; belegtePfade.has(pfad); i++) pfad = `wissen/${gruppe}/${slug}-${i}.md`;
    belegtePfade.add(pfad);
    ziele.set(d.schluessel, pfad);
  }
  const nachUrlId = new Map(b.dokumente.filter((d) => d.urlId).map((d) => [d.urlId!, d.schluessel]));
  const nachId = new Map(b.dokumente.filter((d) => d.id).map((d) => [d.id!.toLowerCase(), d.schluessel]));
  const nachExport = new Map(b.dokumente.filter((d) => d.exportPfad).map((d) => [d.exportPfad!, d.schluessel]));
  // Links auch auf früher importierte Dokumente auflösen, die nicht in diesem Bündel sind
  for (const [schl, w] of wissenNachSchluessel) if (!ziele.has(schl)) ziele.set(schl, w.pfad);
  const sammlungZiel = new Map<string, string>();
  for (const s of b.sammlungen) {
    const g = infoNach.get(s.id)!.gruppe;
    sammlungZiel.set(s.id, `wissen/${g}/index.md`);
    if (s.urlId) sammlungZiel.set(s.urlId, `wissen/${g}/index.md`);
  }
  const hosts = b.basisUrl ? [new URL(b.basisUrl).hostname] : [];

  const tmp = trocken ? null : await mkdtemp(join(tmpdir(), 'kern-import-outline-'));
  const anhangZiel = new Map<string, string>(); // id oder exportPfad → Quellpfad
  try {
    // 1. Anhänge (vor den Dokumenten, damit Links auf sie zeigen können)
    if (opt.anhaenge !== false) {
      for (const a of b.anhaenge) {
        const r = await anhangAnlegen(kern, u, a, b, infoNach, quellenNachHerkunft, tmp, trocken, praefix);
        bericht.anhaenge.push(r);
        if (r.pfad && r.aktion !== 'uebersprungen') {
          if (a.id) anhangZiel.set(a.id, r.pfad);
          if (a.exportPfad) anhangZiel.set(a.exportPfad, r.pfad);
          bericht.summe.anhaengeAlsQuelle++;
        } else bericht.summe.anhaengeOffen++;
      }
    }

    // 2. Dokumente: Quelle, Kommentare, Wissen-Vorschlag
    for (const d of b.dokumente) {
      const s = sammlungNach.get(d.sammlungId) ?? { id: d.sammlungId, urlId: null, url: null, name: d.sammlungId || 'Outline', beschreibung: null, permission: null, baum: [] };
      if (!infoNach.has(s.id)) {
        const r = sichtbarkeitFuer(s, opt, u);
        infoNach.set(s.id, { gruppe: gruppeFuer(s), kernSammlung: `${praefix}-${gruppeFuer(s)}`, sichtbarkeit: r.sichtbarkeit });
      }
      const info = infoNach.get(s.id)!;
      const db: DokumentBericht = {
        schluessel: d.schluessel,
        titel: d.titel,
        outlineUrl: d.url,
        sammlung: s.name,
        sichtbarkeit: info.sichtbarkeit,
        quelle: { aktion: 'neu', pfad: null },
        wissen: null,
        links: { aufgeloest: 0, offen: [], erwaehnungen: 0 },
        kommentare: 0,
        hinweise: [],
      };
      if (!d.markdown.trim()) db.hinweise.push('leeres Dokument');

      // Quelle
      const herkunft = `outline-${slugify(d.schluessel.replace(/^zip:/, '')) || sha(d.schluessel).slice(0, 12)}.md`;
      const inhalt = quellText(d, s);
      const alt = quellenNachHerkunft.get(herkunft);
      let quellPfad: string | null = alt?.pfad ?? null;
      if (alt && alt.kopf.hash === sha(inhalt)) db.quelle = { aktion: 'unveraendert', pfad: alt.pfad };
      else if (trocken) db.quelle = { aktion: alt ? 'aktualisieren' : 'neu', pfad: alt?.pfad ?? null };
      else {
        const datei = join(tmp!, herkunft);
        await writeFile(datei, inhalt);
        const r = await kern!.fuegeHinzu(u, {
          art: 'datei', dateiPfad: datei, dateiName: herkunft, titel: d.titel, sammlung: info.kernSammlung, sichtbarkeit: info.sichtbarkeit,
          kompilieren: !!opt.kompilieren, ...(alt ? { ersetzt: alt.pfad } : {}),
        });
        quellPfad = r.quelle.pfad;
        db.quelle = { aktion: r.doppelt ? 'unveraendert' : alt ? 'aktualisieren' : 'neu', pfad: r.quelle.pfad };
        if (r.warnungen.length) db.hinweise.push(...r.warnungen.filter((w) => !w.startsWith('Diese Quelle gibt es schon')));
        if (r.vorschlaege.length) bericht.summe.vorschlaege += r.vorschlaege.length;
      }

      // Kommentare
      const ks = b.kommentare.filter((k) => k.dokumentId === d.id || k.dokumentId === d.schluessel);
      db.kommentare = ks.length;
      bericht.summe.kommentare += ks.length;
      let kommentarPfad: string | null = null;
      if (ks.length && opt.kommentare !== false) {
        const kh = herkunft.replace(/\.md$/, '-kommentare.md');
        const kt = kommentarText(d, ks);
        const kalt = quellenNachHerkunft.get(kh);
        kommentarPfad = kalt?.pfad ?? null;
        if (!trocken && !(kalt && kalt.kopf.hash === sha(kt))) {
          await writeFile(join(tmp!, kh), kt);
          const r = await kern!.fuegeHinzu(u, { art: 'datei', dateiPfad: join(tmp!, kh), dateiName: kh, titel: `Kommentare: ${d.titel}`, sammlung: info.kernSammlung, sichtbarkeit: info.sichtbarkeit, kompilieren: false, ...(kalt ? { ersetzt: kalt.pfad } : {}) });
          kommentarPfad = r.quelle.pfad;
        }
      }

      // Wissen
      if (mitWissen) {
        const ziel = ziele.get(d.schluessel)!;
        const links = schreibeLinksUm(d.markdown, {
          hosts,
          basisUrl: b.basisUrl,
          vonPfad: ziel,
          exportVerzeichnis: d.exportPfad ? posix.dirname(d.exportPfad) : null,
          zielFuerDokument: (k) => {
            const schl = k.urlId ? nachUrlId.get(k.urlId) ?? k.urlId : k.id ? nachId.get(k.id.toLowerCase()) ?? k.id : k.exportPfad ? nachExport.get(k.exportPfad) : undefined;
            return schl ? (ziele.get(schl) ?? null) : null;
          },
          zielFuerSammlung: (k) => sammlungZiel.get(k) ?? null,
          zielFuerAnhang: (k) => (k.id ? anhangZiel.get(k.id) : k.exportPfad ? anhangZiel.get(k.exportPfad) : undefined) ?? null,
        });
        db.links = { aufgeloest: links.aufgeloest.length, offen: links.offen, erwaehnungen: links.erwaehnungen };
        bericht.summe.linksAufgeloest += links.aufgeloest.length;
        bericht.summe.linksOffen += links.offen.length;
        const koerper = links.text.trim() + '\n';
        const bestehend = wissenNachSchluessel.get(d.schluessel);
        const offen = offeneNachSchluessel.get(d.schluessel);
        if (bestehend && bestehend.text.trim() === koerper.trim()) {
          db.wissen = { aktion: 'unveraendert', ziel, vorschlag: null, freigegeben: false };
        } else if (offen && parseMarkdown(offen.neu).text.trim() === koerper.trim()) {
          db.wissen = { aktion: 'unveraendert', ziel, vorschlag: offen.id, freigegeben: false };
          db.hinweise.push('Vorschlag aus einem früheren Lauf wartet noch auf Freigabe');
        } else if (trocken) {
          db.wissen = { aktion: bestehend ? 'aktualisieren' : 'neu', ziel, vorschlag: null, freigegeben: false };
        } else {
          if (offen) {
            if (u.rollen.some((r) => r === 'freigeber' || r === 'admin')) {
              await kern!.entscheide(u, offen.id, { aktion: 'ablehnen', begruendung: 'Ersetzt durch einen neueren Outline-Import' });
            } else {
              db.wissen = { aktion: 'uebersprungen', ziel, vorschlag: offen.id, freigegeben: false };
              db.hinweise.push('älterer Import-Vorschlag ist noch offen; erst entscheiden, dann erneut importieren');
            }
          }
          if (!db.wissen) {
            const elternZiel = d.elternId ? (ziele.get(d.elternId) ?? null) : null;
            const zeilen = await fundstellenZeilen(opt.datenOrdner!, quellPfad);
            const kopf: Record<string, unknown> = {
              type: 'Artikel',
              titel: d.titel,
              gruppe: info.gruppe,
              kurzfassung: kurzfassung(d.markdown, d.titel),
              stand: datumTeil(d.geaendertAm) ?? datumTeil(new Date().toISOString()),
              verantwortlich: d.geaendertVon ?? d.autor ?? '',
              pruefen_bis: null,
              sichtbarkeit: info.sichtbarkeit,
              besitzer: u.id,
              fundstellen: quellPfad ? [{ id: 'outline', quelle: quellPfad, abschnitt: d.titel, zeilen }] : [],
              ...(d.archiviertAm ? { status: 'veraltet' } : {}),
              outline_schluessel: d.schluessel,
              ...(d.url ? { outline_url: d.url } : {}),
              ...(d.breadcrumb ? { outline_pfad: d.breadcrumb } : {}),
              eltern: elternZiel,
              ...(kommentarPfad ? { kommentare: kommentarPfad } : {}),
            };
            const v = await kern!.schlageVor(u, {
              art: bestehend ? 'aenderung' : 'neu',
              ziel,
              alt: null,
              neu: stringifyMarkdown(kopf, koerper),
              grund: `${GRUND}: ${d.titel}${bestehend ? ' (geändert in Outline)' : ''}`,
              ...(quellPfad ? { quelle: quellPfad } : {}),
            } as Omit<Vorschlag, 'id' | 'status' | 'erstellt' | 'von'>);
            bericht.summe.vorschlaege++;
            let frei = false;
            if (opt.freigeben) {
              const e = await kern!.entscheide(u, v.id, { aktion: 'freigeben', begruendung: 'Outline-Import, 1:1 übernommen' });
              frei = e.status === 'freigegeben';
              if (frei) bericht.summe.freigegeben++;
              else db.hinweise.push(`Freigabe ergab Status ${e.status}`);
            }
            db.wissen = { aktion: bestehend ? 'aktualisieren' : 'neu', ziel, vorschlag: v.id, freigegeben: frei };
          }
        }
      }
      const a = db.wissen?.aktion === 'aktualisieren' || db.quelle.aktion === 'aktualisieren' ? 'aktualisieren' : db.wissen?.aktion === 'neu' || db.quelle.aktion === 'neu' ? 'neu' : 'unveraendert';
      if (a === 'neu') bericht.summe.neu++;
      else if (a === 'aktualisieren') bericht.summe.aktualisiert++;
      else bericht.summe.unveraendert++;
      bericht.dokumente.push(db);
    }
  } finally {
    if (tmp) await rm(tmp, { recursive: true, force: true });
  }
  return bericht;
}

async function fundstellenZeilen(dir: string, pfad: string | null): Promise<[number, number]> {
  if (!pfad || !existsSync(join(dir, pfad))) return [1, 1];
  const inhalt = await readFile(join(dir, pfad), 'utf8');
  const p = parseMarkdown(inhalt);
  const gesamt = inhalt.replace(/\n$/, '').split('\n').length;
  return [Math.min(gesamt, p.kopfZeilen + 1), gesamt];
}

async function anhangAnlegen(
  kern: Kern | null, u: User, a: OutlineAnhang, b: OutlineBuendel,
  infoNach: Map<string, { gruppe: string; kernSammlung: string; sichtbarkeit: Sichtbarkeit }>,
  quellen: Map<string, Quelle>, tmp: string | null, trocken: boolean, praefix: string,
): Promise<ImportBericht['anhaenge'][number]> {
  const ext = extname(a.name).toLowerCase();
  if (!ext || !LESBAR.has(ext)) {
    return { name: a.name, aktion: 'uebersprungen', pfad: null, grund: ext ? `Typ ${ext} speichert Kern noch nicht als Quelle (Link bleibt auf Outline)` : 'Bild oder Datei ohne erkennbaren Typ (Link bleibt auf Outline)' };
  }
  // Sichtbarkeit: die strengste der Sammlungen, die den Anhang verwenden (sonst die erste bekannte)
  const doks = b.dokumente.filter((d) => a.dokumente.includes(d.schluessel));
  const infos = doks.map((d) => infoNach.get(d.sammlungId)).filter((x): x is NonNullable<typeof x> => !!x);
  const rang = (s: Sichtbarkeit) => (s === 'ich' ? 0 : s.startsWith('team:') ? 1 : 2);
  const info = infos.sort((x, y) => rang(x.sichtbarkeit) - rang(y.sichtbarkeit))[0] ?? { kernSammlung: `${praefix}-anhaenge`, sichtbarkeit: 'ich' as Sichtbarkeit, gruppe: 'anhaenge' };
  const kennung = a.id ?? sha(a.exportPfad ?? a.name).slice(0, 12);
  const herkunft = `outline-anhang-${kennung}${ext}`;
  const alt = quellen.get(herkunft);
  if (trocken) return { name: a.name, aktion: alt ? 'unveraendert' : 'neu', pfad: alt?.pfad ?? null, grund: a.lade ? 'wird als Quelle angelegt' : 'Datei nicht ladbar' };
  if (!a.lade) return alt ? { name: a.name, aktion: 'unveraendert', pfad: alt.pfad, grund: 'schon vorhanden' } : { name: a.name, aktion: 'uebersprungen', pfad: null, grund: 'Datei im Abzug nicht enthalten (nur Verweis)' };
  const daten = await a.lade();
  if (!daten) return { name: a.name, aktion: 'uebersprungen', pfad: alt?.pfad ?? null, grund: 'Download fehlgeschlagen' };
  if (alt && alt.kopf.hash === sha(daten)) return { name: a.name, aktion: 'unveraendert', pfad: alt.pfad, grund: 'gleicher Inhalt' };
  const datei = join(tmp!, herkunft);
  await writeFile(datei, daten);
  const r = await kern!.fuegeHinzu(u, { art: 'datei', dateiPfad: datei, dateiName: herkunft, titel: a.name, sammlung: info.kernSammlung, sichtbarkeit: info.sichtbarkeit, kompilieren: false, ...(alt ? { ersetzt: alt.pfad } : {}) });
  return { name: a.name, aktion: r.doppelt ? 'unveraendert' : alt ? 'aktualisieren' : 'neu', pfad: r.quelle.pfad, grund: 'als Quelle angelegt' };
}

/** Bericht als Markdown (für Trockenlauf und Protokoll). */
export function berichtAlsMarkdown(r: ImportBericht): string {
  const z: string[] = [];
  z.push(`# Outline-Import ${r.trockenlauf ? '(Trockenlauf, nichts geschrieben)' : ''}`.trim(), '');
  z.push(`Quelle: ${r.art}${r.basisUrl ? ` (${r.basisUrl})` : ''}`, '');
  const s = r.summe;
  z.push(`Dokumente ${s.dokumente}: neu ${s.neu}, aktualisiert ${s.aktualisiert}, unverändert ${s.unveraendert}. Vorschläge ${s.vorschlaege}, freigegeben ${s.freigegeben}. Anhänge als Quelle ${s.anhaengeAlsQuelle}, nicht übernommen ${s.anhaengeOffen}. Links aufgelöst ${s.linksAufgeloest}, offen ${s.linksOffen}. Kommentare ${s.kommentare}.`, '');
  z.push('## Sammlungen und Rechte', '', '| Outline | Kern-Gruppe | Outline-Recht | Kern-Sichtbarkeit | Grund | Dokumente |', '|---|---|---|---|---|---|');
  for (const x of r.sammlungen) z.push(`| ${x.name} | ${x.gruppe} | ${x.permission ?? 'privat'} | ${x.sichtbarkeit} | ${x.grund} | ${x.dokumente} |`);
  z.push('', '## Dokumente', '', '| Titel | Quelle | Wissen | Links aufgelöst/offen | Hinweise |', '|---|---|---|---|---|');
  for (const d of r.dokumente) z.push(`| ${d.titel.replace(/\|/g, '/')} | ${d.quelle.aktion} | ${d.wissen ? `${d.wissen.aktion}${d.wissen.freigegeben ? ', freigegeben' : ''} → ${d.wissen.ziel}` : 'nur Quelle'} | ${d.links.aufgeloest}/${d.links.offen.length} | ${d.hinweise.join('; ')} |`);
  if (r.anhaenge.length) {
    z.push('', '## Anhänge', '', '| Datei | Aktion | Grund |', '|---|---|---|');
    for (const a of r.anhaenge) z.push(`| ${a.name.replace(/\|/g, '/')} | ${a.aktion} | ${a.grund} |`);
  }
  const offen = r.dokumente.flatMap((d) => d.links.offen.map((o) => ({ titel: d.titel, ...o })));
  if (offen.length) {
    z.push('', '## Offene Links (zeigen weiter auf Outline)', '');
    for (const o of offen) z.push(`* ${o.titel}: ${o.ziel} (${o.grund})`);
  }
  if (r.warnungen.length) z.push('', '## Warnungen', '', ...r.warnungen.map((w) => `* ${w}`));
  return z.join('\n') + '\n';
}
