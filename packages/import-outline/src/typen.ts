/**
 * Einheitliche Zwischenform für alles, was aus Outline kommt (Export-ZIP, API, MCP-Abzug).
 * Jeder Leser liefert ein `OutlineBuendel`; Abbildung und Import kennen nur diese Form.
 */

export type BuendelArt = 'mcp-abzug' | 'markdown-zip' | 'okf-zip' | 'json-zip' | 'api';

/** Knoten der Dokumentstruktur einer Sammlung (Outline: NavigationNode). */
export interface OutlineKnoten {
  id: string;
  title: string;
  url: string;
  children: OutlineKnoten[];
}

export interface OutlineSammlung {
  id: string;
  urlId: string | null;
  url: string | null;
  name: string;
  beschreibung: string | null;
  /** Outline: null = privat (nur Mitglieder), 'read' bzw. 'read_write' = für den ganzen Arbeitsbereich. */
  permission: 'read' | 'read_write' | null;
  baum: OutlineKnoten[];
}

export interface OutlineDokument {
  /**
   * Stabiler Schlüssel für Wiederholungsläufe. Mit Outline-Kennung (API, JSON, MCP, OKF): die urlId bzw. id.
   * Beim reinen Markdown-ZIP gibt es keine Kennung, dann ist es der Pfad im Archiv.
   */
  schluessel: string;
  id: string | null;
  urlId: string | null;
  url: string | null;
  titel: string;
  icon: string | null;
  sammlungId: string;
  elternId: string | null;
  /** Pfad im Export-Archiv (nur ZIP-Leser), für relative Links. */
  exportPfad: string | null;
  markdown: string;
  erstelltAm: string | null;
  geaendertAm: string | null;
  veroeffentlichtAm: string | null;
  archiviertAm: string | null;
  autor: string | null;
  geaendertVon: string | null;
  revision: number | null;
  /** Lesbarer Pfad „Sammlung › Eltern › …“ ohne den eigenen Titel. */
  breadcrumb: string | null;
}

export interface OutlineAnhang {
  /** Outline-Kennung des Anhangs (aus /api/attachments.redirect?id=…), falls bekannt. */
  id: string | null;
  name: string;
  contentType: string | null;
  groesse: number | null;
  /** Pfad im Export-Archiv, falls aus einem ZIP. */
  exportPfad: string | null;
  /** Dokumente, die den Anhang verwenden (Schlüssel). */
  dokumente: string[];
  /** Lädt die Datei; null, wenn sie nicht erreichbar ist (z. B. MCP-Abzug ohne Download). */
  lade: (() => Promise<Buffer | null>) | null;
}

export interface OutlineKommentar {
  id: string;
  dokumentId: string;
  elternId: string | null;
  autor: string;
  erstelltAm: string;
  erledigtAm: string | null;
  text: string;
}

export interface OutlineBuendel {
  art: BuendelArt;
  /** z. B. https://wiki.example.org (ohne Schrägstrich am Ende); für Link-Erkennung und absolute Anhang-Adressen. */
  basisUrl: string | null;
  sammlungen: OutlineSammlung[];
  dokumente: OutlineDokument[];
  anhaenge: OutlineAnhang[];
  kommentare: OutlineKommentar[];
  /** Was der Leser nicht abbilden konnte (fehlende Dateien, unbekannte Knoten …). */
  warnungen: string[];
}

/** Outline-Kennungen: urlId hat 10 bis 15 Zeichen [A-Za-z0-9], id ist eine UUID. */
export const URL_ID = /^[A-Za-z0-9]{10,15}$/;
export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Liest die urlId aus einer Outline-Dokumentadresse (/doc/titel-slug-AbCdEf1234 oder /doc/<uuid>). */
export function urlIdAusPfad(pfad: string): string | null {
  const m = /\/doc\/([^/?#\s)]+)/.exec(pfad);
  if (!m) return null;
  const seg = decodeURIComponent(m[1]!);
  if (UUID.test(seg)) return seg.toLowerCase();
  const letzte = seg.split('-').pop() ?? '';
  return URL_ID.test(letzte) ? letzte : URL_ID.test(seg) ? seg : null;
}

export function datumTeil(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const m = /^(\d{4}-\d{2}-\d{2})/.exec(iso);
  return m ? m[1]! : null;
}
