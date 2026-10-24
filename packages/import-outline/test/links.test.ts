import { describe, expect, it } from 'vitest';
import { schreibeLinksUm, sammleAnhangVerweise, urlIdAusPfad, type LinkKontext } from '../src/index.js';

const ctx = (extra: Partial<LinkKontext> = {}): LinkKontext => ({
  hosts: ['wiki.example.de'],
  basisUrl: 'https://wiki.example.de',
  vonPfad: 'wissen/marke/farbe.md',
  exportVerzeichnis: null,
  zielFuerDokument: (k) =>
    k.urlId === 'X9rpdJqkQo' || k.id === 'a0000004-aaaa-4bbb-8ccc-000000000005' || k.exportPfad === 'Marke/Start/Logo.md'
      ? k.urlId === 'X9rpdJqkQo' || k.id
        ? 'wissen/marke/farbe.md'
        : 'wissen/marke/logo.md'
      : k.urlId === 'LakKMNNe0H'
        ? 'wissen/produkte/produkt-treppe.md'
        : null,
  zielFuerSammlung: (k) => (k === 'MarkeAbc01' ? 'wissen/marke/index.md' : null),
  zielFuerAnhang: (k) => (k.id === 'a0000003-aaaa-4bbb-8ccc-000000000004' ? 'quellen/2026/handbuch.md' : k.exportPfad === 'Marke/uploads/a/b/handbuch.pdf' ? 'quellen/2026/handbuch.md' : null),
  ...extra,
});

describe('urlIdAusPfad', () => {
  it('liest urlId aus Slug-Adressen und UUIDs', () => {
    expect(urlIdAusPfad('https://wiki.example.de/doc/farbe-X9rpdJqkQo')).toBe('X9rpdJqkQo');
    expect(urlIdAusPfad('/doc/start-hier-projekt-kern-das-ai-brain-24102026-NesFXwTdEk#abschnitt')).toBe('NesFXwTdEk');
    expect(urlIdAusPfad('/doc/a0000004-aaaa-4bbb-8ccc-000000000005')).toBe('a0000004-aaaa-4bbb-8ccc-000000000005');
    expect(urlIdAusPfad('/collection/marke-MarkeAbc01')).toBeNull();
  });
});

describe('schreibeLinksUm', () => {
  it('macht aus vollen Wiki-Adressen relative Kern-Links, auch über Gruppen hinweg, mit Anker', () => {
    const r = schreibeLinksUm('Siehe [Farbe](https://wiki.example.de/doc/farbe-X9rpdJqkQo) und [Preise](https://wiki.example.de/doc/produkt-treppe-preise-LakKMNNe0H#treppe).', ctx({ vonPfad: 'wissen/marke/start.md' }));
    expect(r.text).toBe('Siehe [Farbe](./farbe.md) und [Preise](../produkte/produkt-treppe.md#treppe).');
    expect(r.aufgeloest).toHaveLength(2);
    expect(r.offen).toHaveLength(0);
  });

  it('löst /doc/<uuid> (Dokument-Erwähnung im Export) und Erwähnungen auf, Personen werden Text', () => {
    const md = 'Von @[Till Heidrich](mention://a1/user/a0000000-aaaa-4bbb-8ccc-000000000001), vgl. @[Farbe](mention://a2/document/a0000004-aaaa-4bbb-8ccc-000000000005) und [x](/doc/a0000004-aaaa-4bbb-8ccc-000000000005).';
    const r = schreibeLinksUm(md, ctx({ vonPfad: 'wissen/marke/start.md' }));
    expect(r.text).toBe('Von @Till Heidrich, vgl. [Farbe](./farbe.md) und [x](./farbe.md).');
    expect(r.erwaehnungen).toBe(2);
  });

  it('lässt unbekannte Wiki-Dokumente als absolute Adresse stehen und meldet sie', () => {
    const r = schreibeLinksUm('[Website live](https://wiki.example.de/doc/website-live-1DTaSFq5OS) und [rel](/doc/irgendwas-AbCdEfGhIj)', ctx());
    expect(r.text).toBe('[Website live](https://wiki.example.de/doc/website-live-1DTaSFq5OS) und [rel](https://wiki.example.de/doc/irgendwas-AbCdEfGhIj)');
    expect(r.offen.map((o) => o.ziel)).toEqual(['https://wiki.example.de/doc/website-live-1DTaSFq5OS', 'https://wiki.example.de/doc/irgendwas-AbCdEfGhIj']);
  });

  it('Anhänge: übernommene zeigen auf die Quelle, Bilder bleiben auf Outline und werden gemeldet', () => {
    const md = '![Palette](https://wiki.example.de/api/attachments.redirect?id=a0000003-aaaa-4bbb-8ccc-000000000004) ![Logo](/api/attachments.redirect?id=a0000002-aaaa-4bbb-8ccc-000000000003)';
    const r = schreibeLinksUm(md, ctx());
    expect(r.text).toBe('![Palette](../../quellen/2026/handbuch.md) ![Logo](https://wiki.example.de/api/attachments.redirect?id=a0000002-aaaa-4bbb-8ccc-000000000003)');
    expect(r.offen).toHaveLength(1);
  });

  it('löst relative Export-Links und den kaputten „host./Datei.md“-Fall aus dem Markdown-Export', () => {
    const c = ctx({ vonPfad: 'wissen/marke/start.md', exportVerzeichnis: 'Marke' });
    expect(schreibeLinksUm('[Logo](./Start/Logo.md) [PDF](uploads/a/b/handbuch.pdf)', c).text).toBe('[Logo](./logo.md) [PDF](../../quellen/2026/handbuch.md)');
    expect(schreibeLinksUm('[Logo](https://wiki.example.de./Start/Logo.md)', c).text).toBe('[Logo](./logo.md)');
    expect(schreibeLinksUm('[Logo](./Start/Logo%20Neu.md)', c).offen).toHaveLength(1);
  });

  it('Sammlungslinks zeigen auf die Übersicht der Gruppe; fremde Adressen bleiben', () => {
    const r = schreibeLinksUm('[Marke](https://wiki.example.de/collection/marke-branding-MarkeAbc01) [ext](https://example.org/doc/x-AbCdEfGhIj) [mail](mailto:a@b.de)', ctx());
    expect(r.text).toBe('[Marke](./index.md) [ext](https://example.org/doc/x-AbCdEfGhIj) [mail](mailto:a@b.de)');
  });

  it('Codeblöcke und Inline-Code bleiben unverändert, freistehende Wiki-Adressen werden verlinkt', () => {
    const md = 'Text `[a](https://wiki.example.de/doc/farbe-X9rpdJqkQo)`\n\n```md\n[a](https://wiki.example.de/doc/farbe-X9rpdJqkQo)\n```\n\nSeite steht: https://wiki.example.de/doc/farbe-X9rpdJqkQo.';
    const r = schreibeLinksUm(md, ctx({ vonPfad: 'wissen/marke/start.md' }));
    expect(r.text).toContain('`[a](https://wiki.example.de/doc/farbe-X9rpdJqkQo)`');
    expect(r.text).toContain('```md\n[a](https://wiki.example.de/doc/farbe-X9rpdJqkQo)\n```');
    expect(r.text).toContain('Seite steht: [https://wiki.example.de/doc/farbe-X9rpdJqkQo](./farbe.md).');
  });
});

describe('sammleAnhangVerweise', () => {
  it('unterscheidet Bilder und Dateilinks', () => {
    const v = sammleAnhangVerweise('![Bild](/api/attachments.redirect?id=a0000003-aaaa-4bbb-8ccc-000000000004) [handbuch.pdf](https://w/api/attachments.redirect?id=a0000001-aaaa-4bbb-8ccc-000000000002)');
    expect(v).toEqual([
      { id: 'a0000003-aaaa-4bbb-8ccc-000000000004', name: 'Bild', bild: true },
      { id: 'a0000001-aaaa-4bbb-8ccc-000000000002', name: 'handbuch.pdf', bild: false },
    ]);
  });
});
