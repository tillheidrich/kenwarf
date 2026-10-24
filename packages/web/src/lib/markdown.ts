import { Marked, type Tokens } from 'marked';

// Markdown aus dem Wissensordner sicher darstellen: rohes HTML wird als Text gezeigt,
// Links nur mit http(s), mailto, tel oder relativ. Relative .md-Links werden auf
// die passende Ansicht der App umgebogen.

export function escape(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

export function sichereUrl(href: string): string | null {
  const h = href.trim();
  if (/^(https?:|mailto:|tel:)/i.test(h)) return h;
  if (/^[a-z][a-z0-9+.-]*:/i.test(h)) return null; // javascript:, data:, vbscript: …
  if (h.startsWith('//')) return null;
  return h;
}

/** Löst einen relativen Link aus einem Artikel auf einen App-Hash auf. */
export function loeseLink(href: string, basisPfad?: string): string {
  if (!basisPfad || /^(https?:|mailto:|tel:|#)/i.test(href)) return href;
  if (!/\.md(#.*)?$/.test(href)) return href;
  const [ziel] = href.split('#');
  const teile = basisPfad.split('/').slice(0, -1);
  for (const seg of ziel.split('/')) {
    if (seg === '..') teile.pop();
    else if (seg !== '.' && seg !== '') teile.push(seg);
  }
  const pfad = teile.join('/');
  return pfad.startsWith('quellen/') ? `#/dokumente/${pfad.slice(8)}` : `#/wissen/${pfad.replace(/^wissen\//, '')}`;
}

function baue(basisPfad?: string): Marked {
  const m = new Marked({ gfm: true, breaks: false });
  m.use({
    renderer: {
      html(t: Tokens.HTML | Tokens.Tag) {
        return escape(t.text);
      },
      link(this: { parser: { parseInline(t: Tokens.Generic[]): string } }, t: Tokens.Link) {
        const inhalt = this.parser.parseInline(t.tokens);
        const u = sichereUrl(t.href);
        if (!u) return inhalt;
        const ziel = loeseLink(u, basisPfad);
        const extern = /^https?:/i.test(ziel);
        const titel = t.title ? ` title="${escape(t.title)}"` : '';
        return `<a href="${escape(ziel)}"${titel}${extern ? ' rel="noopener noreferrer" target="_blank"' : ''}>${inhalt}${extern ? '<span class="sr-only"> (öffnet in neuem Tab)</span>' : ''}</a>`;
      },
      image(t: Tokens.Image) {
        const u = sichereUrl(t.href);
        if (!u || !/^https?:/i.test(u)) return escape(t.text);
        return `<img src="${escape(u)}" alt="${escape(t.text)}" loading="lazy">`;
      },
      table(this: { parser: { parseInline(t: Tokens.Generic[]): string } }, t: Tokens.Table) {
        const kopf = t.header.map((z) => `<th scope="col">${this.parser.parseInline(z.tokens)}</th>`).join('');
        const rumpf = t.rows
          .map((r) => `<tr>${r.map((z) => `<td>${this.parser.parseInline(z.tokens)}</td>`).join('')}</tr>`)
          .join('');
        return `<div class="tabelle" tabindex="0" role="region" aria-label="Tabelle"><table><thead><tr>${kopf}</tr></thead><tbody>${rumpf}</tbody></table></div>`;
      },
    },
  });
  return m;
}

const standard = baue();

export function markdownZuHtml(md: string, basisPfad?: string): string {
  const m = basisPfad ? baue(basisPfad) : standard;
  // Überschrift-Ebenen absenken: h1 im Text wird h2, weil die Seite schon ein h1 hat
  return (m.parse(md, { async: false }) as string).replace(/<(\/?)h1>/g, '<$1h2>');
}

/** Klartext ohne Markdown-Zeichen, z. B. für Vorschauen. */
export function klartext(md: string): string {
  return md
    .replace(/^---[\s\S]*?---\n/, '')
    .replace(/```[\s\S]*?```/g, '')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/^#+\s*/gm, '')
    .replace(/^>\s?/gm, '')
    .replace(/[*_`|]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}
