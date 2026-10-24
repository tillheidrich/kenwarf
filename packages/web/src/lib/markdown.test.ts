import { describe, expect, it } from 'vitest';
import { klartext, loeseLink, markdownZuHtml, sichereUrl } from './markdown';

describe('markdown', () => {
  it('zeigt rohes HTML als Text', () => {
    const html = markdownZuHtml('Hallo <script>alert(1)</script> <img src=x onerror=alert(1)>');
    expect(html).not.toContain('<script');
    expect(html).not.toContain('<img');
    expect(html).toContain('&lt;script&gt;');
  });
  it('lässt keine javascript:-Links durch', () => {
    expect(markdownZuHtml('[klick](javascript:alert(1))')).not.toContain('href');
    expect(sichereUrl('data:text/html,x')).toBeNull();
    expect(sichereUrl('https://example.org')).toBe('https://example.org');
  });
  it('biegt relative .md-Links auf App-Ansichten um', () => {
    expect(loeseLink('../vorlagen/33-textbausteine-mails.md', 'wissen/ablaeufe/18-reklamation.md')).toBe('#/wissen/vorlagen/33-textbausteine-mails.md');
    expect(markdownZuHtml('[x](https://a.de)')).toContain('rel="noopener noreferrer"');
  });
  it('senkt h1 auf h2 ab und macht Tabellen scrollbar', () => {
    const h = markdownZuHtml('# Titel\n\n| a | b |\n|---|---|\n| 1 | 2 |');
    expect(h).toContain('<h2');
    expect(h).toContain('class="tabelle"');
  });
  it('macht Klartext', () => {
    expect(klartext('## Kopf\n\n**fett** und [Link](x.md)')).toBe('Kopf fett und Link');
  });
});
