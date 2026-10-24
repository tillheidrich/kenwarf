import { describe, expect, it } from 'vitest';
import { prosemirrorZuMarkdown, type PmKnoten } from '../src/index.js';

const t = (text: string, marks?: PmKnoten['marks']): PmKnoten => ({ type: 'text', text, ...(marks ? { marks } : {}) });
const p = (...c: PmKnoten[]): PmKnoten => ({ type: 'paragraph', content: c });

describe('prosemirrorZuMarkdown', () => {
  it('setzt Überschriften, Marken, Listen, Aufgaben, Zitat, Code, Hinweis und Tabelle', () => {
    const doc: PmKnoten = {
      type: 'doc',
      content: [
        { type: 'heading', attrs: { level: 2 }, content: [t('Palette')] },
        p(t('Kobalt', [{ type: 'strong' }]), t(' ist '), t('#2055b3', [{ type: 'code_inline' }]), t(', siehe '), t('Logo', [{ type: 'link', attrs: { href: '/doc/logo-rHFg9XVVVU' } }])),
        { type: 'bullet_list', content: [{ type: 'list_item', content: [p(t('eins'))] }, { type: 'list_item', content: [p(t('zwei')), { type: 'bullet_list', content: [{ type: 'list_item', content: [p(t('zwei-a'))] }] }] }] },
        { type: 'ordered_list', attrs: { order: 3 }, content: [{ type: 'list_item', content: [p(t('drei'))] }] },
        { type: 'checkbox_list', content: [{ type: 'checkbox_item', attrs: { checked: true }, content: [p(t('erledigt'))] }, { type: 'checkbox_item', attrs: { checked: false }, content: [p(t('offen'))] }] },
        { type: 'blockquote', content: [p(t('Zitat'))] },
        { type: 'code_fence', attrs: { language: 'js' }, content: [t('const a = 1;')] },
        { type: 'container_notice', attrs: { style: 'warning' }, content: [p(t('Achtung'))] },
        {
          type: 'table',
          content: [
            { type: 'tr', content: [{ type: 'th', content: [p(t('Name'))] }, { type: 'th', content: [p(t('Hex'))] }] },
            { type: 'tr', content: [{ type: 'td', content: [p(t('Kobalt'))] }, { type: 'td', content: [p(t('a|b'))] }] },
          ],
        },
        { type: 'hr' },
        p({ type: 'mention', attrs: { type: 'user', label: 'Till', modelId: 'u1' } }, t(' und '), { type: 'mention', attrs: { type: 'document', label: 'Farbe', modelId: 'd1' } }),
        p({ type: 'image', attrs: { src: '/api/attachments.redirect?id=x', alt: 'Bild' } }),
        { type: 'attachment', attrs: { href: '/api/attachments.redirect?id=y', title: 'handbuch.pdf', size: 1 } },
        { type: 'unbekannt_neu', content: [p(t('Rest'))] },
      ],
    };
    const u = new Set<string>();
    const md = prosemirrorZuMarkdown(doc, u);
    expect(md).toBe(
      [
        '## Palette',
        '**Kobalt** ist `#2055b3`, siehe [Logo](/doc/logo-rHFg9XVVVU)',
        '* eins\n* zwei\n  * zwei-a',
        '3. drei',
        '- [x] erledigt\n- [ ] offen',
        '> Zitat',
        '```js\nconst a = 1;\n```',
        ':::warning\nAchtung\n:::',
        '| Name | Hex |\n|---|---|\n| Kobalt | a\\|b |',
        '---',
        '@Till und [Farbe](/doc/d1)',
        '![Bild](/api/attachments.redirect?id=x)',
        '[handbuch.pdf](/api/attachments.redirect?id=y)',
        'Rest',
      ].join('\n\n') + '\n',
    );
    expect([...u]).toEqual(['unbekannt_neu']);
  });
});
