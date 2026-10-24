import { describe, expect, it } from 'vitest';
import { ansichtZuHtml } from './ansicht';

// Text genau so, wie core `ansichtText` ihn schreibt (Heute, Zusammenfassung).
const AUS_CORE = [
  '# Zusammenfassung 2026-10-24',
  '',
  'Seit 2026-10-17: 1 Änderungen für dich, 1 Punkte zu entscheiden, 0 unsicher. 2 weitere Punkte darfst du ignorieren.',
  '',
  '## Zu entscheiden',
  '',
  '- [P-1a2b3c4d] Vorschlag: Lieferzeit Beschläge auf vier Wochen {ampel: rot, grund: "Frist in deiner Zuständigkeit"} [^b1]',
  '',
  '## Was sich für dich ändert',
  '',
  '- [P-9f8e7d6c] Lieferantenliste 2026 ersetzt April {ampel: gelb, grund: "Neu seit <gestern>"} [^b1] [^b2]',
  '- [P-00000000] Hobelmesser alle 40 Stunden [^b2]',
  '',
  '[^b1]: wissen/ablaeufe/material-bestellen.md, Zeilen 45–45: „Beschläge brauchen vier Wochen“',
  '[^b2]: quellen/lieferanten.md, Zeilen 3–4: „Stand Oktober“',
  '',
].join('\n');

describe('Ansicht aus core darstellen (Heute, Briefing)', () => {
  const html = ansichtZuHtml(AUS_CORE);

  it('zeigt keine Rohmarkierungen', () => {
    expect(html).not.toContain('{ampel');
    expect(html).not.toContain('[^');
    expect(html).not.toMatch(/\[P-[0-9a-f]+\]/);
    expect(html).not.toContain('grund:');
  });

  it('macht aus der Ampel eine Marke mit Grund', () => {
    expect(html).toContain('lese-ampel lese-ampel--rot');
    expect(html).toContain('Ja, heute lesen');
    expect(html).toContain('Frist in deiner Zuständigkeit');
    expect(html).toContain('lese-ampel lese-ampel--gelb');
  });

  it('nummeriert Fußnoten und listet die Belege einmal am Ende', () => {
    expect(html.match(/class="fussnote fussnote--inline" title=/g)?.length).toBe(4);
    expect(html).toContain('<ol class="ansicht-belege">');
    expect(html).toContain('material-bestellen.md, Zeilen 45–45');
    expect(html.match(/<li><span class="fussnote/g)?.length).toBe(2);
  });

  it('lässt den Titel weg (die Karte hat eine eigene Überschrift) und behält Abschnitte', () => {
    expect(html).not.toContain('Zusammenfassung 2026-10-24');
    expect(html).toContain('<h2>Zu entscheiden</h2>');
  });

  it('bleibt sicher: Grund und Belegtext werden maskiert', () => {
    expect(html).toContain('Neu seit &lt;gestern&gt;');
    expect(ansichtZuHtml('- x {ampel: rot, grund: "<img src=x onerror=alert(1)>"}')).not.toContain('<img');
  });

  it('lässt gewöhnliches Markdown unverändert', () => {
    expect(ansichtZuHtml('Im Eingang warten **3** Vorschläge.')).toBe('<p>Im Eingang warten <strong>3</strong> Vorschläge.</p>\n');
  });
});
