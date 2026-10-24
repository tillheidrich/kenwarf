import { posix } from 'node:path';
import { URL_ID, UUID, urlIdAusPfad } from './typen.js';

export interface AnhangVerweis {
  id: string;
  name: string;
  bild: boolean;
}

const ANHANG = /attachments\.redirect\?id=([0-9a-f-]{36})/i;

/** Findet alle Verweise auf Outline-Anhänge (Bilder und Dateilinks) im Markdown. */
export function sammleAnhangVerweise(md: string): AnhangVerweis[] {
  const out: AnhangVerweis[] = [];
  const re = /(!?)\[((?:[^[\]]|\[[^\]]*\])*)\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)/g;
  for (const m of md.matchAll(re)) {
    const id = ANHANG.exec(m[3]!)?.[1];
    if (!id) continue;
    out.push({ id: id.toLowerCase(), name: m[2]!.trim(), bild: m[1] === '!' });
  }
  return out;
}

export interface LinkKontext {
  /** Hostnamen, unter denen das Wiki erreichbar ist (z. B. wiki.example.org). */
  hosts: string[];
  basisUrl: string | null;
  /** Pfad der Zieldatei im Kern-Datenordner (z. B. wissen/marke-branding/farbe.md); Links werden relativ dazu geschrieben. */
  vonPfad: string;
  /** Verzeichnis des Dokuments im Export-Archiv (nur ZIP), für relative Links. */
  exportVerzeichnis: string | null;
  zielFuerDokument(k: { urlId?: string; id?: string; exportPfad?: string }): string | null;
  zielFuerSammlung(urlIdOderId: string): string | null;
  zielFuerAnhang(k: { id?: string; exportPfad?: string }): string | null;
}

export interface LinkErgebnis {
  text: string;
  aufgeloest: { von: string; nach: string }[];
  offen: { ziel: string; grund: string }[];
  erwaehnungen: number;
}

/**
 * Schreibt Outline-Verweise in Kern-Verweise um: relative Markdown-Links zwischen Dateien im Datenordner
 * (funktionieren in Kern, Obsidian und jedem Editor). Erkennt volle Adressen, /doc/…-Pfade (urlId und UUID),
 * Erwähnungen, Sammlungslinks, Anhänge und relative Links aus dem Markdown-Export.
 * Nicht auflösbare Wiki-Verweise bleiben als absolute Adresse stehen und werden gemeldet.
 * Codeblöcke und Inline-Code bleiben unangetastet.
 */
export function schreibeLinksUm(md: string, ctx: LinkKontext): LinkErgebnis {
  const ergebnis: LinkErgebnis = { text: '', aufgeloest: [], offen: [], erwaehnungen: 0 };
  const teile = md.split(/(^```[^\n]*\n[\s\S]*?^```[ \t]*$)/m);
  ergebnis.text = teile.map((t, i) => (i % 2 === 1 ? t : schreibeAbschnitt(t, ctx, ergebnis))).join('');
  return ergebnis;
}

function schreibeAbschnitt(text: string, ctx: LinkKontext, e: LinkErgebnis): string {
  // Inline-Code schützen
  const code: string[] = [];
  let t = text.replace(/`[^`\n]+`/g, (m) => {
    code.push(m);
    return `\u0000${code.length - 1}\u0000`;
  });
  // Erwähnungen: Personen werden zu Text, Dokument-/Sammlungserwähnungen zu Links
  t = t.replace(/@\[([^\]]*)\]\(mention:\/\/([^)]*)\)/g, (_m, label: string, rest: string) => {
    e.erwaehnungen++;
    const [, typ, modell] = rest.split('/');
    if (typ === 'document' && modell) return `[${label}](/doc/${modell})`;
    if (typ === 'collection' && modell) return `[${label}](/collection/${modell})`;
    return `@${label}`;
  });
  t = t.replace(/(!?)\[((?:[^[\]]|\[[^\]]*\])*)\]\(\s*<?([^)\s>]+)>?(\s+"[^"]*")?\s*\)/g, (m, bang: string, label: string, ziel: string, titel?: string) => {
    const neu = loese(ziel, ctx, e);
    if (neu === null) return m;
    return `${bang}[${label}](${neu}${titel ?? ''})`;
  });
  // freistehende Wiki-Adressen (z. B. in Kommentaren)
  if (ctx.hosts.length) {
    const hostRe = ctx.hosts.map((h) => h.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
    const frei = new RegExp(`(^|[\\s"„])(https?://(?:${hostRe})/doc/[^\\s)<>"“]+)`, 'g');
    t = t.replace(frei, (m, vor: string, url: string) => {
      const sauber = url.replace(/[.,;:!?]+$/, '');
      const rest = url.slice(sauber.length);
      const neu = loese(sauber, ctx, e);
      return neu === null ? m : `${vor}[${sauber}](${neu})${rest}`;
    });
  }
  return t.replace(/\u0000(\d+)\u0000/g, (_m, i: string) => code[Number(i)]!);
}

/** Liefert das neue Linkziel, oder null, wenn der Link unverändert bleiben soll. */
function loese(ziel: string, ctx: LinkKontext, e: LinkErgebnis): string | null {
  if (/^(mailto:|tel:|#|data:)/i.test(ziel)) return null;
  let pfad: string | null = null; // Outline-Pfad wie /doc/…
  let relativ: string | null = null; // relativer Pfad im Export
  if (/^https?:\/\//i.test(ziel)) {
    let u: URL;
    try {
      u = new URL(ziel);
    } catch {
      return null;
    }
    const host = u.hostname.replace(/\.$/, '');
    if (!ctx.hosts.includes(host)) return null;
    // Outline-Export-Fehler: „https://host./Datei.md“ (relativer Pfad hinter dem Host)
    if (u.hostname.endsWith('.') && !u.pathname.startsWith('/doc/')) relativ = decodeURI(u.pathname.replace(/^\//, './'));
    else pfad = u.pathname + u.search + u.hash;
  } else if (ziel.startsWith('/')) {
    pfad = ziel;
  } else if (/^[a-z][a-z0-9+.-]*:/i.test(ziel)) {
    return null;
  } else {
    relativ = ziel;
  }

  const rel = (nach: string, anker = '') => {
    const r = posix.relative(posix.dirname(ctx.vonPfad), nach) || posix.basename(nach);
    const out = (r.startsWith('.') ? r : `./${r}`) + anker;
    e.aufgeloest.push({ von: ziel, nach: out });
    return out;
  };
  const absolut = (p: string) => (ctx.basisUrl ? ctx.basisUrl + p : p);

  if (pfad !== null) {
    const anker = pfad.includes('#') ? pfad.slice(pfad.indexOf('#')) : '';
    if (pfad.startsWith('/doc/')) {
      const k = urlIdAusPfad(pfad);
      const roh = pfad.slice(5).split(/[?#/]/)[0] ?? '';
      const z = k ? ctx.zielFuerDokument(UUID.test(k) ? { id: k } : { urlId: k }) : roh ? ctx.zielFuerDokument({ id: roh }) : null;
      if (z) return rel(z, anker);
      e.offen.push({ ziel: absolut(pfad), grund: 'Dokument ist nicht Teil dieses Imports' });
      return pfad === ziel ? absolut(pfad) : null;
    }
    if (pfad.startsWith('/collection/')) {
      const seg = pfad.split(/[/?#]/)[2] ?? '';
      const k = UUID.test(seg) ? seg : (seg.split('-').pop() ?? '');
      const z = URL_ID.test(k) || UUID.test(k) ? ctx.zielFuerSammlung(k) : null;
      if (z) return rel(z);
      e.offen.push({ ziel: absolut(pfad), grund: 'Sammlung ist nicht Teil dieses Imports' });
      return pfad === ziel ? absolut(pfad) : null;
    }
    const a = ANHANG.exec(pfad);
    if (a) {
      const z = ctx.zielFuerAnhang({ id: a[1]!.toLowerCase() });
      if (z) return rel(z);
      e.offen.push({ ziel: absolut(pfad), grund: 'Anhang nicht übernommen (Datei fehlt oder Typ wird von Kern noch nicht gespeichert)' });
      return pfad === ziel ? absolut(pfad) : null;
    }
    return null;
  }

  if (relativ !== null) {
    let dekodiert = relativ;
    try {
      dekodiert = decodeURI(relativ);
    } catch {
      /* bleibt */
    }
    const anker = dekodiert.includes('#') ? dekodiert.slice(dekodiert.indexOf('#')) : '';
    const ohne = dekodiert.replace(/#.*$/, '');
    const voll = posix.normalize(posix.join(ctx.exportVerzeichnis ?? '', ohne));
    if (/\.md$/i.test(ohne)) {
      const z = ctx.zielFuerDokument({ exportPfad: voll });
      if (z) return rel(z, anker);
      e.offen.push({ ziel: relativ, grund: 'Relativer Export-Link ohne passendes Dokument' });
      return null;
    }
    const z = ctx.zielFuerAnhang({ exportPfad: voll });
    if (z) return rel(z);
    if (ctx.exportVerzeichnis !== null) e.offen.push({ ziel: relativ, grund: 'Relativer Export-Verweis auf eine Datei, die nicht übernommen wurde' });
    return null;
  }
  return null;
}
