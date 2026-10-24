import { describe, expect, it } from 'vitest';
import { bildeAbschnitte } from '../src/abschnitte.js';
import { parseMarkdown, stringifyMarkdown } from '../src/util.js';

describe('Abschnittsbildung', () => {
  const datei = stringifyMarkdown({ titel: 'Test', gruppe: 'x' }, '# Haupt\n\nEinleitung.\n\n## Teil A\n\nText A eins.\nText A zwei.\n\n### Unter A\n\nTief.\n\n## Teil B\n\n```\n# kein Titel im Code\n```\nEnde B.\n');
  const p = parseMarkdown(datei);
  const ab = bildeAbschnitte(p.text, p.kopfZeilen, 'Test');
  const zeilen = datei.split('\n');

  it('trennt an Überschriften mit Überschriftenpfad', () => {
    expect(ab.map((a) => a.abschnitt)).toEqual(['Haupt', 'Haupt › Teil A', 'Haupt › Teil A › Unter A', 'Haupt › Teil B']);
  });

  it('Zeilenbereiche beziehen sich auf die ganze Datei inkl. Kopf', () => {
    for (const a of ab) {
      expect(zeilen.slice(a.von - 1, a.bis).join('\n')).toBe(a.text);
    }
    expect(zeilen[ab[1]!.von - 1]).toBe('## Teil A');
  });

  it('Überschriften in Code-Blöcken zählen nicht', () => {
    expect(ab[3]!.text).toContain('# kein Titel im Code');
  });

  it('lange Abschnitte werden auf ~1.200 Zeichen geteilt, mit kleinem Überlapp', () => {
    const absaetze = Array.from({ length: 30 }, (_, i) => `Absatz ${i + 1}: ${'Wort '.repeat(18 + (i % 5))}Ende.`);
    const text = `# Lang\n\n${absaetze.join('\n\n')}\n`;
    const teile = bildeAbschnitte(text, 0, 'Lang');
    expect(teile.length).toBeGreaterThan(2);
    for (const t of teile) expect(t.text.length).toBeLessThanOrEqual(1200);
    // Überlapp: letzter Absatz eines Teils steht am Anfang des nächsten
    const letzter = teile[0]!.text.split('\n\n').pop()!;
    expect(teile[1]!.text.startsWith(letzter)).toBe(true);
    // Zeilen bleiben korrekt
    const z = text.split('\n');
    for (const t of teile) expect(z.slice(t.von - 1, t.bis).join('\n')).toContain(t.text.split('\n\n')[0]!);
  });

  it('reine Überschriften ohne Inhalt bilden keinen Abschnitt', () => {
    const t = bildeAbschnitte('# Nur Titel\n\n## Wirklich\n\nInhalt.\n', 0, 'X');
    expect(t.map((a) => a.abschnitt)).toEqual(['Nur Titel › Wirklich']);
  });
});
