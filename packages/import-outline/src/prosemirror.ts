/**
 * Wandelt Outlines ProseMirror-JSON (JSON-Export, Feld `data`) in Markdown um.
 * Knoten- und Markennamen nach outline/shared/editor (Stand Outline 1.12.0):
 * doc, paragraph, heading, blockquote, bullet_list, ordered_list, list_item, checkbox_list, checkbox_item,
 * code_block, code_fence, hr, br, image, attachment, video, embed, mention, emoji, container_notice,
 * container_toggle, table, tr, th, td, math_inline, math_block; Marken strong, em, code_inline, link,
 * strikethrough, underline, highlight, comment, placeholder.
 * Unbekannte Knoten werden als Text ihrer Kinder übernommen und gemeldet.
 */
export interface PmKnoten {
  type: string;
  attrs?: Record<string, unknown>;
  content?: PmKnoten[];
  text?: string;
  marks?: { type: string; attrs?: Record<string, unknown> }[];
}

export function prosemirrorZuMarkdown(doc: PmKnoten, unbekannt: Set<string> = new Set()): string {
  const out = bloecke(doc.content ?? [], '', unbekannt).join('\n\n');
  return out.replace(/\n{3,}/g, '\n\n').trim() + '\n';
}

const s = (v: unknown) => (typeof v === 'string' ? v : v == null ? '' : String(v));

function bloecke(knoten: PmKnoten[], einzug: string, unbekannt: Set<string>): string[] {
  return knoten.map((k) => block(k, einzug, unbekannt)).filter((x) => x.trim() !== '');
}

function block(k: PmKnoten, einzug: string, u: Set<string>): string {
  const kinder = k.content ?? [];
  switch (k.type) {
    case 'paragraph':
      return inline(kinder, u);
    case 'heading':
      return `${'#'.repeat(Math.min(6, Math.max(1, Number(k.attrs?.['level'] ?? 1))))} ${inline(kinder, u)}`;
    case 'blockquote':
      return bloecke(kinder, '', u).join('\n\n').split('\n').map((z) => (z ? `> ${z}` : '>')).join('\n');
    case 'bullet_list':
      return liste(kinder, () => '* ', einzug, u);
    case 'ordered_list': {
      const start = Number(k.attrs?.['order'] ?? 1) || 1;
      return liste(kinder, (i) => `${start + i}. `, einzug, u);
    }
    case 'checkbox_list':
      return liste(kinder, (_i, item) => (item.attrs?.['checked'] ? '- [x] ' : '- [ ] '), einzug, u);
    case 'code_block':
    case 'code_fence': {
      const sprache = s(k.attrs?.['language']);
      const text = kinder.map((c) => c.text ?? '').join('');
      return '```' + (sprache === 'none' ? '' : sprache) + '\n' + text + '\n```';
    }
    case 'math_block':
      return '$$\n' + kinder.map((c) => c.text ?? '').join('') + '\n$$';
    case 'hr':
      return '---';
    case 'container_notice': {
      const stil = s(k.attrs?.['style']) || 'info';
      return `:::${stil}\n${bloecke(kinder, '', u).join('\n\n')}\n:::`;
    }
    case 'container_toggle':
      return bloecke(kinder, einzug, u).join('\n\n');
    case 'table':
      return tabelle(kinder, u);
    case 'image':
    case 'attachment':
    case 'video':
    case 'embed':
      return inline([k], u);
    default:
      if (kinder.length && kinder.every((c) => c.type === 'text' || istInline(c.type))) return inline(kinder, u);
      if (kinder.length) {
        u.add(k.type);
        return bloecke(kinder, einzug, u).join('\n\n');
      }
      if (k.type !== 'doc') u.add(k.type);
      return '';
  }
}

function istInline(t: string): boolean {
  return ['text', 'br', 'image', 'mention', 'emoji', 'math_inline', 'attachment', 'video', 'embed'].includes(t);
}

function liste(items: PmKnoten[], marke: (i: number, item: PmKnoten) => string, einzug: string, u: Set<string>): string {
  return items
    .map((item, i) => {
      const m = marke(i, item);
      const innen = bloecke(item.content ?? [], einzug + ' '.repeat(m.length), u);
      const [erste = '', ...rest] = innen;
      const zeilen = [einzug + m + erste.split('\n').join('\n' + einzug + ' '.repeat(m.length))];
      for (const r of rest) {
        const istListe = /^\s*([*-]|\d+\.) /.test(r);
        zeilen.push(istListe ? r : einzug + ' '.repeat(m.length) + r.split('\n').join('\n' + einzug + ' '.repeat(m.length)));
      }
      return zeilen.join('\n');
    })
    .join('\n');
}

function tabelle(zeilen: PmKnoten[], u: Set<string>): string {
  const reihen = zeilen.map((tr) => (tr.content ?? []).map((zelle) => bloecke(zelle.content ?? [], '', u).join(' ').replace(/\n+/g, ' ').replace(/\|/g, '\\|')));
  if (!reihen.length) return '';
  const breite = Math.max(...reihen.map((r) => r.length));
  const fuell = (r: string[]) => [...r, ...Array(breite - r.length).fill('')];
  const kopf = fuell(reihen[0]!);
  const out = [`| ${kopf.join(' | ')} |`, `|${kopf.map(() => '---').join('|')}|`];
  for (const r of reihen.slice(1)) out.push(`| ${fuell(r).join(' | ')} |`);
  return out.join('\n');
}

function inline(knoten: PmKnoten[], u: Set<string>): string {
  let out = '';
  for (const k of knoten) {
    switch (k.type) {
      case 'text':
        out += markiere(k.text ?? '', k.marks ?? []);
        break;
      case 'br':
        out += '\\\n';
        break;
      case 'image':
        out += `![${s(k.attrs?.['alt'])}](${s(k.attrs?.['src'])})`;
        break;
      case 'attachment':
        out += `[${s(k.attrs?.['title']) || 'Anhang'}](${s(k.attrs?.['href'])})`;
        break;
      case 'video':
        out += `[${s(k.attrs?.['title']) || 'Video'}](${s(k.attrs?.['src'])})`;
        break;
      case 'embed':
        out += `[${s(k.attrs?.['href'])}](${s(k.attrs?.['href'])})`;
        break;
      case 'mention': {
        const typ = s(k.attrs?.['type']);
        const label = s(k.attrs?.['label']);
        const modell = s(k.attrs?.['modelId']);
        if (typ === 'document') out += `[${label}](/doc/${modell})`;
        else if (typ === 'collection') out += `[${label}](/collection/${modell})`;
        else if (k.attrs?.['href']) out += `@[${label}](${s(k.attrs['href'])})`;
        else out += `@${label}`;
        break;
      }
      case 'emoji':
        out += s(k.attrs?.['data-name']) ? `:${s(k.attrs?.['data-name'])}:` : '';
        break;
      case 'math_inline':
        out += `$${(k.content ?? []).map((c) => c.text ?? '').join('')}$`;
        break;
      default:
        u.add(k.type);
        out += inline(k.content ?? [], u);
    }
  }
  return out;
}

function markiere(text: string, marks: NonNullable<PmKnoten['marks']>): string {
  let t = text;
  const hat = (n: string) => marks.find((m) => m.type === n);
  if (hat('code_inline')) t = '`' + t + '`';
  else {
    if (hat('strikethrough')) t = `~~${t}~~`;
    if (hat('em')) t = `*${t}*`;
    if (hat('strong')) t = `**${t}**`;
    if (hat('highlight')) t = `==${t}==`;
  }
  const link = hat('link');
  if (link) t = `[${t}](${s(link.attrs?.['href'])})`;
  return t;
}
