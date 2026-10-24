import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { z } from 'zod';
import type { KernLike, User } from './types.js';
import { leseQuelle } from './kern-laden.js';
import { artikelPfad, pruefeRelPfad, quellenPfad } from './pfade.js';
import { KernFehler, keineRechte, nichtGefunden, statusAusFehler } from './fehler.js';
import { darf, pruefeZiel } from './rechte.js';
import type { Scope } from './zugang.js';

export interface McpOptionen {
  /** Scopes des Tokens. Fehlt die Angabe, gelten alle (nur für Tests und lokales stdio). */
  scopes?: Scope[];
  /** Wird vor jeder KI-Frage aufgerufen (Raten- und Kostenlimit), wirft bei Überschreitung. */
  vorFrage?: () => void;
  /** Modus nur_lesen: Schreibwerkzeuge 423, Fragen ohne KI. */
  nurLesen?: boolean;
  /** D-L13: Kennzeichnung der Antwort (ki_erzeugt, modell). */
  kennzeichne?: <T extends object>(a: T) => T;
  ohneKi?: (frage: string, reichweite?: 'ich' | 'team' | 'betrieb', sammlung?: string) => Promise<object>;
  produktName?: string;
  /** Name des Agenten (OAuth: client_name/client_id), für die Kennzeichnung von Vorschlägen. */
  agent?: string | null;
}

/** Welcher Scope für welches Werkzeug nötig ist. */
export const TOOL_SCOPE: Record<(typeof MCP_TOOLS)[number], Scope> = {
  kern_suche: 'kern:lesen', kern_lese: 'kern:lesen', kern_fakten: 'kern:lesen', kern_eingang: 'kern:lesen',
  kern_briefing: 'kern:lesen', kern_frage: 'kern:fragen', kern_vorschlag: 'kern:vorschlagen',
};

export const MCP_TOOLS = ['kern_suche', 'kern_lese', 'kern_frage', 'kern_fakten', 'kern_vorschlag', 'kern_eingang', 'kern_briefing'] as const;

const reichweite = z.enum(['ich', 'team', 'betrieb']).optional()
  .describe('Wie weit gesucht wird: "ich" (nur eigene Einträge), "team" (eigene und Team), "betrieb" (alles, was du sehen darfst). Standard: betrieb.');
const sammlung = z.string().max(120).optional().describe('Nur in dieser Sammlung suchen, z. B. "angebote".');

type ToolErgebnis = { content: { type: 'text'; text: string }[]; isError?: boolean };

const ok = (daten: unknown): ToolErgebnis => ({ content: [{ type: 'text', text: JSON.stringify(daten, null, 2) }] });

async function sicher(fn: () => Promise<unknown>): Promise<ToolErgebnis> {
  try {
    return ok(await fn());
  } catch (e) {
    const { status, meldung } = statusAusFehler(e);
    return { isError: true, content: [{ type: 'text', text: `Fehler ${status}: ${meldung}` }] };
  }
}

/**
 * Baut für einen angemeldeten Benutzer einen MCP-Server mit den sechs Kern-Werkzeugen.
 * Kein Werkzeug schreibt ins Wissen. `kern_vorschlag` legt nur einen Vorschlag in den Eingang.
 */
export function bauMcpServer(kern: KernLike, user: User, version: string, opt: McpOptionen = {}): McpServer {
  // M5: Werkzeuge außerhalb der Scopes des Tokens antworten mit einem Fehler (403).
  const brauche = (tool: (typeof MCP_TOOLS)[number]) => {
    if (opt.scopes && !opt.scopes.includes(TOOL_SCOPE[tool])) throw new KernFehler(403, `Dem Token fehlt der Scope ${TOOL_SCOPE[tool]}.`, 'keine_rechte');
  };
  const s = new McpServer(
    { name: opt.produktName ?? 'kern', version },
    {
      instructions:
        'Kern ist das Firmenwissen dieses Betriebs. Antworten immer mit Fundstellen belegen. ' +
        'Du darfst nichts direkt ändern: Änderungen nur über kern_vorschlag, ein Mensch gibt sie im Eingang frei.',
    },
  );

  s.registerTool('kern_suche', {
    title: 'Im Wissen suchen',
    description: 'Durchsucht Artikel (wissen/) und Quellen (quellen/) per Volltext und Bedeutung. Liefert Treffer mit Pfad, Abschnitt, Zeilenbereich und Ausschnitt. Nur, was der Benutzer sehen darf.',
    inputSchema: {
      anfrage: z.string().min(1).max(500).describe('Suchbegriffe oder eine Frage in normaler Sprache.'),
      reichweite,
      sammlung,
      limit: z.number().int().min(1).max(50).optional().describe('Höchstzahl der Treffer, Standard 10.'),
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, async (a) => sicher(async () => { brauche('kern_suche'); return kern.suche(user, a.anfrage, { reichweite: a.reichweite, sammlung: a.sammlung, limit: a.limit ?? 10 }); }));

  s.registerTool('kern_lese', {
    title: 'Artikel oder Quelle lesen',
    description: 'Liest einen Artikel (Pfad beginnt mit "wissen/") oder eine Quelle (Pfad beginnt mit "quellen/") vollständig mit Kopfdaten. Pfade kommen aus kern_suche.',
    inputSchema: {
      pfad: z.string().min(1).max(1024).describe('Pfad relativ zum Datenordner, z. B. "wissen/betrieb/urlaub.md".'),
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, async (a) => sicher(async () => {
    brauche('kern_lese');
    const roh = pruefeRelPfad(a.pfad);
    if (!roh) throw nichtGefunden();
    if (roh.startsWith('quellen/')) {
      const p = quellenPfad(roh);
      if (!p) throw nichtGefunden();
      return leseQuelle(kern, user, p);
    }
    const p = artikelPfad(roh);
    if (!p) throw nichtGefunden();
    return kern.leseArtikel(user, p);
  }));

  s.registerTool('kern_frage', {
    title: 'Frage beantworten mit Belegen',
    description: 'Beantwortet eine Frage nur aus dem Wissen des Betriebs. Jeder Punkt der Antwort verweist auf Belege (Datei, Abschnitt, Zeilen, Zitat). Steht nichts drin, kommt status "steht_nicht_drin". Belege nicht weglassen, wenn du die Antwort weitergibst.',
    inputSchema: {
      frage: z.string().min(1).max(2000).describe('Die Frage in normaler Sprache.'),
      reichweite,
      sammlung,
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, async (a) => {
    try {
      brauche('kern_frage');
      let antwort: object;
      if (opt.nurLesen && opt.ohneKi) antwort = await opt.ohneKi(a.frage, a.reichweite, a.sammlung);
      else {
        opt.vorFrage?.();
        const roh = await kern.frage(user, a.frage, { reichweite: a.reichweite, sammlung: a.sammlung });
        antwort = opt.kennzeichne ? opt.kennzeichne(roh) : roh;
      }
      // D-L13: maschinenlesbar als structuredContent und im Text.
      return { ...ok(antwort), structuredContent: antwort as Record<string, unknown> };
    } catch (e) {
      const { status, meldung } = statusAusFehler(e);
      return { isError: true, content: [{ type: 'text' as const, text: `Fehler ${status}: ${meldung}` }] };
    }
  });

  s.registerTool('kern_fakten', {
    title: 'Fakten abfragen',
    description: 'Liefert einzelne belegte Fakten (Preise, Fristen, Zuständigkeiten, Kennzahlen, Kontakte, Regeln) mit Gültigkeitszeitraum und Fundstelle. Für genaue Werte besser als kern_frage.',
    inputSchema: {
      art: z.enum(['preis', 'frist', 'zustaendigkeit', 'kennzahl', 'kontakt', 'regel']).optional().describe('Nur Fakten dieser Art.'),
      gegenstand: z.string().max(200).optional().describe('Worum es geht, z. B. "Stundensatz Geselle". Teilwort genügt.'),
      gueltig_am: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe('Nur Fakten, die an diesem Tag gelten (JJJJ-MM-TT).'),
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, async (a) => sicher(async () => {
    brauche('kern_fakten');
    if (typeof kern.fakten !== 'function') throw new KernFehler(501, 'Diese core-Version kennt noch keine Faktenschicht.');
    return kern.fakten(user, { art: a.art, gegenstand: a.gegenstand, gueltigAm: a.gueltig_am });
  }));

  s.registerTool('kern_vorschlag', {
    title: 'Änderung vorschlagen',
    description: 'Legt einen Änderungsvorschlag für einen Artikel in den Eingang. Es wird nichts direkt geschrieben: Ein Mensch mit Freigaberecht prüft und gibt frei oder lehnt ab. Braucht die Rolle "autor".',
    inputSchema: {
      art: z.enum(['neu', 'aenderung', 'loeschung']).describe('"neu" für einen neuen Artikel, "aenderung" für eine Überarbeitung, "loeschung" zum Entfernen.'),
      ziel: z.string().min(1).max(1024).describe('Zielpfad des Artikels unter wissen/, z. B. "wissen/betrieb/urlaub.md".'),
      neu: z.string().max(200_000).describe('Vollständiger neuer Dateiinhalt (Markdown mit YAML-Kopf). Bei "loeschung" leer.'),
      alt: z.string().max(200_000).nullable().optional().describe('Bisheriger Inhalt, falls bekannt (für den Vergleich).'),
      grund: z.string().min(3).max(2000).describe('Warum die Änderung nötig ist, mit Bezug auf Quellen.'),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  }, async (a) => sicher(async () => {
    brauche('kern_vorschlag');
    if (opt.nurLesen) throw new KernFehler(423, 'Diese Instanz ist gerade nur lesbar.', 'nur_lesen');
    if (!darf(user, 'vorschlagen')) throw keineRechte('Vorschläge brauchen die Rolle "autor".');
    const ziel = artikelPfad(a.ziel);
    if (!ziel) throw nichtGefunden('Ungültiger Zielpfad.');
    pruefeZiel(ziel, user);
    // v1.2 (F9): Vorschläge über MCP stammen in der Regel von einer KI und werden gekennzeichnet.
    const marke = opt.agent ? `[über MCP, Agent ${opt.agent.slice(0, 80)}]` : '[über MCP]';
    const grund = a.grund.startsWith('[über MCP') ? a.grund : `${marke} ${a.grund}`;
    return kern.schlageVor(user, { art: a.art, ziel, neu: a.neu, alt: a.alt ?? null, grund });
  }));

  s.registerTool('kern_eingang', {
    title: 'Offene Vorschläge ansehen',
    description: 'Listet offene Vorschläge im Eingang (Freigeber sehen alle, andere ihre eigenen). Entscheiden geht nur in der Weboberfläche oder per CLI, nicht über MCP.',
    inputSchema: {},
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, async () => sicher(async () => { brauche('kern_eingang'); return kern.eingang(user); }));

  s.registerTool('kern_briefing', {
    title: 'Briefing',
    description: 'Kurzer Lagebericht (höchstens 300 Wörter): neue Quellen, offene Entscheidungen, fällige Artikel.',
    inputSchema: {
      seit: z.string().regex(/^\d{4}-\d{2}-\d{2}/).optional().describe('Datum (JJJJ-MM-TT), ab dem Neues zählt. Standard: letztes Briefing.'),
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, async (a) => sicher(async () => { brauche('kern_briefing'); return kern.briefing(user, a.seit); }));

  return s;
}

/** Bearbeitet eine MCP-Anfrage zustandslos: je Anfrage ein Server und ein Transport. */
export async function bearbeiteMcp(kern: KernLike, user: User, req: Request, version: string, opt: McpOptionen = {}): Promise<Response> {
  const server = bauMcpServer(kern, user, version, opt);
  const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  await server.connect(transport);
  try {
    return await transport.handleRequest(req);
  } finally {
    // Bei JSON-Antworten ist die Antwort vollständig; Server und Transport schließen.
    void transport.close().catch(() => {});
    void server.close().catch(() => {});
  }
}
