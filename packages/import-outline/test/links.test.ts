import { describe, expect, it } from 'vitest';
import { schreibeLinksUm, sammleAnhangVerweise, urlIdAusPfad, type LinkKontext } from '../src/index.js';

const ctx = (extra: Partial<LinkKontext> = {}): LinkKontext => ({
  hosts: ['wiki.example.de'],
  basisUrl: 'https://wiki.example.de',
  vonPfad: 'wissen/marke/farbe.md',
  exportVerzeichnis: null,
  zielFuerDokument: (k) =>
    k.urlId === 'Xy12Ab34Cd' || k.id === 'abcdef12-3456-4789-8abc-def012345678' || k.exportPfad === 'Marke/Start/Logo.md'
      ? k.urlId === 'Xy12Ab34Cd' || k.id
        ? 'wissen/marke/farbe.md'
        : 'wissen/marke/logo.md'
      : k.urlId === 'Pr00000001'
        ? 'wissen/produkte/produkt-treppe.md'
        : null,
  zielFuerSammlung: (k) => (k === 'Mk56Ef78Gh' ? 'wissen/marke/index.md' : null),
  zielFuerAnhang: (k) => (k.id === '55555555-5555-4555-8555-555555555555' ? 'quellen/2026/handbuch.md' : k.exportPfad === 'Marke/uploads/a/b/handbuch.pdf' ? 'quellen/2026/handbuch.md' : null),
  ...extra,
});

describe('urlIdAusPfad', () => {
  it('liest urlId aus Slug-Adressen und UUIDs', () => {
    expect(urlIdAusPfad('https://wiki.example.de/doc/farbe-Xy12Ab34Cd')).toBe('Xy12Ab34Cd');
    expect(urlIdAusPfad('/doc/start-hier-Sh00000003#abschnitt')).toBe('Sh00000003');
    expect(urlIdAusPfad('/doc/ABCDEF12-3456-4789-8abc-def012345678')).toBe('abcdef12-3456-4789-8abc-def012345678');
    expect(urlIdAusPfad('/collection/marke-Mk56Ef78Gh')).toBeNull();
  });
});

describe('schreibeLinksUm', () => {
  it('macht aus vollen Wiki-Adressen relative Kern-Links, auch über Gruppen hinweg, mit Anker', () => {
    const r = schreibeLinksUm('Siehe [Farbe](https://wiki.example.de/doc/farbe-Xy12Ab34Cd) und [Preise](https://wiki.example.de/doc/preise-Pr00000001#treppe).', ctx({ vonPfad: 'wissen/marke/start.md' }));
    expect(r.text).toBe('Siehe [Farbe](./farbe.md) und [Preise](../produkte/produkt-treppe.md#treppe).');
    expect(r.aufgeloest).toHaveLength(2);
    expect(r.offen).toHaveLength(0);
  });

  it('löst /doc/<uuid> (Dokument-Erwähnung im Export) und Erwähnungen auf, Personen werden Text', () => {
    const md = 'Von @[Till Heidrich](mention://a1/user/33333333-3333-4333-8333-333333333333), vgl. @[Farbe](mention://a2/document/abcdef12-3456-4789-8abc-def012345678) und [x](/doc/abcdef12-3456-4789-8abc-def012345678).';
    const r = schreibeLinksUm(md, ctx({ vonPfad: 'wissen/marke/start.md' }));
    expect(r.text).toBe('Von @Till Heidrich, vgl. [Farbe](./farbe.md) und [x](./farbe.md).');
    expect(r.erwaehnungen).toBe(2);
  });

  it('lässt unbekannte Wiki-Dokumente als absolute Adresse stehen und meldet sie', () => {
    const r = schreibeLinksUm('[Website live](https://wiki.example.de/doc/website-live-Wl00000002) und [rel](/doc/irgendwas-AbCdEfGhIj)', ctx());
    expect(r.text).toBe('[Website live](https://wiki.example.de/doc/website-live-Wl00000002) und [rel](https://wiki.example.de/doc/irgendwas-AbCdEfGhIj)');
    expect(r.offen.map((o) => o.ziel)).toEqual(['https://wiki.example.de/doc/website-live-Wl00000002', 'https://wiki.example.de/doc/irgendwas-AbCdEfGhIj']);
  });

  it('Anhänge: übernommene zeigen auf die Quelle, Bilder bleiben auf Outline und werden gemeldet', () => {
    const md = '![Palette](https://wiki.example.de/api/attachments.redirect?id=55555555-5555-4555-8555-555555555555) ![Logo](/api/attachments.redirect?id=22222222-2222-4222-8222-222222222222)';
    const r = schreibeLinksUm(md, ctx());
    expect(r.text).toBe('![Palette](../../quellen/2026/handbuch.md) ![Logo](https://wiki.example.de/api/attachments.redirect?id=22222222-2222-4222-8222-222222222222)');
    expect(r.offen).toHaveLength(1);
  });

  it('löst relative Export-Links und den kaputten „host./Datei.md“-Fall aus dem Markdown-Export', () => {
    const c = ctx({ vonPfad: 'wissen/marke/start.md', exportVerzeichnis: 'Marke' });
    expect(schreibeLinksUm('[Logo](./Start/Logo.md) [PDF](uploads/a/b/handbuch.pdf)', c).text).toBe('[Logo](./logo.md) [PDF](../../quellen/2026/handbuch.md)');
    expect(schreibeLinksUm('[Logo](https://wiki.example.de./Start/Logo.md)', c).text).toBe('[Logo](./logo.md)');
    expect(schreibeLinksUm('[Logo](./Start/Logo%20Neu.md)', c).offen).toHaveLength(1);
  });

  it('Sammlungslinks zeigen auf die Übersicht der Gruppe; fremde Adressen bleiben', () => {
    const r = schreibeLinksUm('[Marke](https://wiki.example.de/collection/marke-branding-Mk56Ef78Gh) [ext](https://example.org/doc/x-AbCdEfGhIj) [mail](mailto:a@b.de)', ctx());
    expect(r.text).toBe('[Marke](./index.md) [ext](https://example.org/doc/x-AbCdEfGhIj) [mail](mailto:a@b.de)');
  });

  it('Codeblöcke und Inline-Code bleiben unverändert, freistehende Wiki-Adressen werden verlinkt', () => {
    const md = 'Text `[a](https://wiki.example.de/doc/farbe-Xy12Ab34Cd)`\n\n```md\n[a](https://wiki.example.de/doc/farbe-Xy12Ab34Cd)\n```\n\nSeite steht: https://wiki.example.de/doc/farbe-Xy12Ab34Cd.';
    const r = schreibeLinksUm(md, ctx({ vonPfad: 'wissen/marke/start.md' }));
    expect(r.text).toContain('`[a](https://wiki.example.de/doc/farbe-Xy12Ab34Cd)`');
    expect(r.text).toContain('```md\n[a](https://wiki.example.de/doc/farbe-Xy12Ab34Cd)\n```');
    expect(r.text).toContain('Seite steht: [https://wiki.example.de/doc/farbe-Xy12Ab34Cd](./farbe.md).');
  });
});

describe('sammleAnhangVerweise', () => {
  it('unterscheidet Bilder und Dateilinks', () => {
    const v = sammleAnhangVerweise('![Bild](/api/attachments.redirect?id=55555555-5555-4555-8555-555555555555) [handbuch.pdf](https://w/api/attachments.redirect?id=FEDCBA98-7654-4321-8FED-CBA987654321)');
    expect(v).toEqual([
      { id: '55555555-5555-4555-8555-555555555555', name: 'Bild', bild: true },
      { id: 'fedcba98-7654-4321-8fed-cba987654321', name: 'handbuch.pdf', bild: false },
    ]);
  });
});
