import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { LATEST_PROTOCOL_VERSION, SUPPORTED_PROTOCOL_VERSIONS } from '@modelcontextprotocol/sdk/types.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { z } from 'zod';
import type { KernLike, User } from './types.js';
import { leseQuelle } from './kern-laden.js';
import { artikelPfad, pruefeRelPfad, quellenPfad } from './pfade.js';
import { KernFehler, keineRechte, nichtGefunden, statusAusFehler } from './fehler.js';
import { darf, engereReichweite, inReichweite, pruefeZiel } from './rechte.js';
import { sammelEntscheiden } from './sammel.js';
import type { Scope } from './zugang.js';

export interface McpOptionen {
  /** Scopes des Tokens. Fehlt die Angabe, gelten alle (nur für Tests und lokales stdio). */
  scopes?: Scope[];
  /** Wird vor jeder KI-Frage aufgerufen (Raten- und Kostenlimit), wirft bei Überschreitung. */
  vorFrage?: () => void | Promise<void>;
  /** 4.1 Weg „ohne“ oder „app“: kern_frage antwortet ohne KI (wörtliche Auszüge). */
  ohneKiWeg?: boolean;
  /** Modus nur_lesen: Schreibwerkzeuge 423, Fragen ohne KI. */
  nurLesen?: boolean;
  /** D-L13: Kennzeichnung der Antwort (ki_erzeugt, modell). */
  kennzeichne?: <T extends object>(a: T) => T;
  ohneKi?: (frage: string, reichweite?: 'ich' | 'team' | 'betrieb', sammlung?: string) => Promise<object>;
  produktName?: string;
  /** Name des Agenten (OAuth: client_name/client_id), für die Kennzeichnung von Vorschlägen. */
  agent?: string | null;
  /** v1.4 6.3: Reichweite des Zugangs (Einschränkung, nie Erweiterung); gilt für Suche, Frage, Kontext, Gedächtnis. */
  reichweite?: 'ich' | 'team' | 'betrieb' | null;
}

/** Welcher Scope für welches Werkzeug nötig ist. */
export const TOOL_SCOPE: Record<(typeof MCP_TOOLS)[number], Scope> = {
  kern_suche: 'kern:lesen', kern_lese: 'kern:lesen', kern_fakten: 'kern:lesen', kern_eingang: 'kern:lesen',
  kern_briefing: 'kern:lesen', kern_frage: 'kern:fragen', kern_vorschlag: 'kern:vorschlagen',
  kern_kontext: 'kern:lesen', kern_wegweiser: 'kern:lesen', kern_gedaechtnis: 'kern:lesen',
  kern_sammelfreigabe: 'kern:freigeben',
};

export const MCP_TOOLS = ['kern_suche', 'kern_lese', 'kern_frage', 'kern_fakten', 'kern_vorschlag', 'kern_eingang', 'kern_briefing', 'kern_kontext', 'kern_wegweiser', 'kern_gedaechtnis', 'kern_sammelfreigabe'] as const;

/**
 * MCP-Protokollversion (v1.4 6.1, Entscheidung offen bei Till): SDK 1.32.2 kennt höchstens 2025-11-25.
 * 2026-07-28 wird nicht von Hand gebaut. Clients mit 2026-07-28 fallen sauber zurück:
 * - `initialize` mit 2026-07-28: das SDK antwortet mit der neuesten unterstützten Version (2025-11-25), der Client entscheidet.
 * - `server/discover` (2026-07-28): JSON-RPC -32601 mit `data.supportedVersions`, damit der Client `initialize` nutzt.
 * - andere Anfragen mit Header `MCP-Protocol-Version: 2026-07-28`: 400 mit `data.supportedVersions` (Spezifikation:
 *   unbekannte Version → 400), ohne dass vorher Rechte geprüft oder Daten gelesen werden.
 */
export const MCP_VERSIONEN: readonly string[] = SUPPORTED_PROTOCOL_VERSIONS;
export const MCP_NEUESTE = LATEST_PROTOCOL_VERSION;

export async function pruefeProtokollversion(req: Request): Promise<Response | null> {
  if (req.method !== 'POST') return null;
  const kopf = req.headers.get('mcp-protocol-version');
  let roh: unknown = null;
  try { roh = await req.clone().json(); } catch { return null; }
  const liste = Array.isArray(roh) ? roh : [roh];
  const daten = { supportedVersions: [...MCP_VERSIONEN], empfohlen: MCP_NEUESTE, hinweis: 'MCP 2026-07-28 wird von diesem Server noch nicht angeboten; bitte mit initialize und 2025-11-25 verbinden.' };
  const json = (body: unknown, status: number) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  const ersteId = (liste[0] as { id?: unknown } | null)?.id ?? null;
  if (liste.some((r) => (r as { method?: unknown } | null)?.method === 'server/discover')) {
    return json({ jsonrpc: '2.0', id: ersteId, error: { code: -32601, message: 'Methode server/discover wird hier nicht angeboten (MCP 2025-11-25).', data: daten } }, 200);
  }
  const istInit = liste.some((r) => (r as { method?: unknown } | null)?.method === 'initialize');
  if (kopf !== null && !MCP_VERSIONEN.includes(kopf) && !istInit) {
    return json({ jsonrpc: '2.0', id: ersteId, error: { code: -32000, message: `Bad Request: Unsupported protocol version: ${kopf.slice(0, 40)}`, data: daten } }, 400);
  }
  return null;
}

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
  const rw = (r?: 'ich' | 'team' | 'betrieb') => engereReichweite(r, opt.reichweite);
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
  }, async (a) => sicher(async () => { brauche('kern_suche'); return kern.suche(user, a.anfrage, { reichweite: rw(a.reichweite), sammlung: a.sammlung, limit: a.limit ?? 10 }); }));

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
    // v1.4 6.3: außerhalb der Reichweite des Zugangs wie nicht vorhanden.
    const sichtbar = <T extends { kopf: Record<string, unknown> }>(x: T): T => {
      const sb = String(x.kopf.sichtbarkeit ?? 'betrieb');
      const bes = String(x.kopf.besitzer ?? x.kopf.erfasst_von ?? '');
      if (!inReichweite(user, sb, bes, opt.reichweite)) throw nichtGefunden();
      return x;
    };
    if (roh.startsWith('quellen/')) {
      const p = quellenPfad(roh);
      if (!p) throw nichtGefunden();
      return sichtbar(await leseQuelle(kern, user, p));
    }
    const p = artikelPfad(roh);
    if (!p) throw nichtGefunden();
    return sichtbar(await kern.leseArtikel(user, p));
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
      if ((opt.nurLesen || opt.ohneKiWeg) && opt.ohneKi) antwort = await opt.ohneKi(a.frage, rw(a.reichweite), a.sammlung);
      else {
        await opt.vorFrage?.();
        const roh = await kern.frage(user, a.frage, { reichweite: rw(a.reichweite), sammlung: a.sammlung });
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
    description: 'Legt einen Änderungsvorschlag für einen Artikel in den Eingang. Es wird nichts direkt geschrieben: Ein Mensch mit Freigaberecht prüft und gibt frei oder lehnt ab. Braucht die Rolle "autor". Für reine Ergänzungen "nachtrag" nehmen: dann ist "neu" nur der Text, der unten angehängt wird.',
    inputSchema: {
      art: z.enum(['neu', 'aenderung', 'loeschung', 'nachtrag']).describe('"neu" für einen neuen Artikel, "aenderung" für eine Überarbeitung, "loeschung" zum Entfernen, "nachtrag" zum Anhängen an einen bestehenden Artikel.'),
      ziel: z.string().min(1).max(1024).describe('Zielpfad des Artikels unter wissen/, z. B. "wissen/betrieb/urlaub.md".'),
      neu: z.string().max(200_000).describe('Vollständiger neuer Dateiinhalt (Markdown mit YAML-Kopf). Bei "loeschung" leer. Bei "nachtrag" nur der anzuhängende Text.'),
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
    const agent = opt.agent ? { agent: opt.agent } : undefined;
    if (a.art === 'nachtrag') {
      if (typeof kern.nachtrag !== 'function') throw new KernFehler(501, 'Nachträge kommen mit core (v1.4.1 U10).', 'nicht_verfuegbar');
      return kern.nachtrag(user, { ziel, text: a.neu, grund }, agent);
    }
    return kern.schlageVor(user, { art: a.art, ziel, neu: a.neu, alt: a.alt ?? null, grund }, agent);
  }));

  // v1.4.1 U10: Sammelfreigabe. Nur Zugänge eines Menschen (ohne Agent) mit Rolle freigeber/admin; Agenten geben nie frei.
  s.registerTool('kern_sammelfreigabe', {
    title: 'Vorschläge gesammelt entscheiden',
    description: 'Gibt offene Vorschläge mit gleichem Grund, gleicher Quelle, gleichem Absender oder aus einer ID-Liste gesammelt frei oder lehnt sie ab. Braucht den Scope kern:freigeben (eigenes Token eines Freigebers, nie Agent oder OAuth). Regeln (wissen/_regeln/) gehen nur über die Weboberfläche.',
    inputSchema: {
      aktion: z.enum(['freigeben', 'ablehnen']),
      ids: z.array(z.string().regex(/^[A-Za-z0-9_-]{1,100}$/)).max(500).optional(),
      grund: z.string().max(2000).optional(),
      quelle: z.string().max(1024).optional(),
      von: z.string().max(200).optional(),
      art: z.enum(['neu', 'aenderung', 'loeschung', 'nachtrag']).optional(),
      begruendung: z.string().max(2000).optional(),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async (a) => sicher(async () => {
    brauche('kern_sammelfreigabe');
    if (opt.agent) throw keineRechte('Agenten-Zugänge geben nie frei. Bitte im Eingang der Weboberfläche entscheiden.');
    if (opt.nurLesen) throw new KernFehler(423, 'Diese Instanz ist gerade nur lesbar.', 'nur_lesen');
    // v1.4.2: Regeln (wissen/_regeln/) nur über die Weboberfläche, auch für Admins.
    return sammelEntscheiden(kern, user, { ids: a.ids, grund: a.grund, quelle: a.quelle, von: a.von, art: a.art }, { aktion: a.aktion, begruendung: a.begruendung }, { ohneRegeln: true });
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

  // v1.4 8.3: kleinste belegte Menge für ein fremdes Modell, Rechte wie kern_suche.
  s.registerTool('kern_kontext', {
    title: 'Kontextpaket für eine Aufgabe',
    description: 'Liefert die kleinste belegte Menge an Abschnitten (mit Zitat, Stand, Gültigkeit) und Fakten zu einer Frage oder einem Thema, innerhalb eines Token-Budgets. Nur, was der Benutzer sehen darf. Belege beim Weitergeben nicht weglassen.',
    inputSchema: {
      frage: z.string().max(2000).optional().describe('Worum es geht, als Frage.'),
      thema: z.string().max(200).optional().describe('Oder ein Thema, z. B. "Urlaub".'),
      budget: z.number().int().min(200).max(64000).optional().describe('Höchstzahl Tokens (geschätzt Zeichen/4), Standard 4000.'),
      mit_fakten: z.boolean().optional().describe('Fakten mitliefern, Standard ja.'),
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, async (a) => {
    try {
      brauche('kern_kontext');
      if (!a.frage && !a.thema) throw new KernFehler(400, 'frage oder thema angeben.');
      if (typeof kern.kontextpaket !== 'function') throw new KernFehler(501, 'Das Kontextpaket kommt mit core (v1.4 8.3).');
      const p = { ki_erzeugt: false, modell: null, ...(await kern.kontextpaket(user, { frage: a.frage, thema: a.thema, budgetTokens: a.budget ?? 4000, mitFakten: a.mit_fakten ?? true, ...(opt.reichweite ? { reichweite: opt.reichweite } : {}) })) };
      return { ...ok(p), structuredContent: p as Record<string, unknown> };
    } catch (e) {
      const { status, meldung } = statusAusFehler(e);
      return { isError: true, content: [{ type: 'text' as const, text: `Fehler ${status}: ${meldung}` }] };
    }
  });

  // v1.4 8.6: Wegweiser (index.md der Wurzel und von wissen/, nach Rechten gefiltert).
  s.registerTool('kern_wegweiser', {
    title: 'Wegweiser durch das Wissen',
    description: 'Zeigt, welche Bereiche und Artikel es gibt (Inhaltsverzeichnis nach Rechten des Benutzers). Zuerst aufrufen, wenn unklar ist, wo etwas steht.',
    inputSchema: {},
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, async () => sicher(async () => { brauche('kern_wegweiser'); return { text: await wegweiser(kern, user) }; }));

  // v1.4 8.5 (E1): Gedächtnis-Adapter, Befehle wie das Claude-Memory-Tool. view braucht kern:lesen, alles andere
  // kern:vorschlagen; Änderungen unter /memories/wissen werden Vorschläge, /memories/notizen sind eigene Arbeitsnotizen.
  s.registerTool('kern_gedaechtnis', {
    title: 'Gedächtnis (Memory-Tool-Befehle)',
    description: 'Dateibefehle unter /memories: /memories/wissen/… liest das Wissen (Änderungen werden Vorschläge, ein Mensch gibt frei), /memories/notizen/… sind eigene Arbeitsnotizen. Befehle: view, create, str_replace, insert, delete, rename.',
    inputSchema: {
      command: z.enum(['view', 'create', 'str_replace', 'insert', 'delete', 'rename']),
      path: z.string().max(1024).optional(),
      file_text: z.string().max(200_000).optional(),
      old_str: z.string().max(200_000).optional(),
      new_str: z.string().max(200_000).optional(),
      insert_line: z.number().int().min(0).optional(),
      insert_text: z.string().max(200_000).optional(),
      view_range: z.array(z.number().int()).length(2).optional(),
      old_path: z.string().max(1024).optional(),
      new_path: z.string().max(1024).optional(),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  }, async (a) => {
    try {
      brauche('kern_gedaechtnis');
      if (a.command !== 'view') {
        if (opt.scopes && !opt.scopes.includes('kern:vorschlagen')) throw new KernFehler(403, 'Schreiben im Gedächtnis braucht den Scope kern:vorschlagen.', 'keine_rechte');
        if (opt.nurLesen) throw new KernFehler(423, 'Diese Instanz ist gerade nur lesbar.', 'nur_lesen');
      }
      if (typeof kern.gedaechtnis !== 'function') throw new KernFehler(501, 'Der Gedächtnis-Adapter kommt mit core (v1.4 8.5).');
      const befehl = Object.fromEntries(Object.entries(a).filter(([, v]) => v !== undefined));
      const r = await kern.gedaechtnis(user, befehl, { ...(opt.agent ? { agent: opt.agent } : {}), reichweite: opt.reichweite ?? null });
      // Memory-Tool: Text wie die Referenzimplementierung; ok:false → is_error, damit das Modell es als Fehler sieht.
      const ids = (r.vorschlaege ?? []).map((v) => v.id);
      return {
        content: [{ type: 'text' as const, text: r.text }],
        ...(r.ok ? {} : { isError: true }),
        ...(ids.length ? { structuredContent: { vorschlaege: ids } } : {}),
      };
    } catch (e) {
      const { status, meldung } = statusAusFehler(e);
      return { isError: true, content: [{ type: 'text' as const, text: `Fehler ${status}: ${meldung}` }] };
    }
  });

  // v1.4 8.6: Ressourcen index.md und REGELN.md (nach Rechten gefiltert, N1).
  const lesenErlaubt = () => { if (opt.scopes && !opt.scopes.includes('kern:lesen')) throw new KernFehler(403, 'Dem Token fehlt der Scope kern:lesen.', 'keine_rechte'); };
  s.registerResource('index', 'kern://index.md', { title: 'Inhaltsverzeichnis', description: 'Wegweiser durch Wissen und Quellen (nach Rechten).', mimeType: 'text/markdown' }, async (uri) => {
    lesenErlaubt();
    return { contents: [{ uri: uri.href, mimeType: 'text/markdown', text: await wegweiser(kern, user) }] };
  });
  s.registerResource('regeln', 'kern://wissen/_regeln/REGELN.md', { title: 'Regeln des Betriebs', description: 'Verbindliche Regeln (wissen/_regeln/REGELN.md).', mimeType: 'text/markdown' }, async (uri) => {
    lesenErlaubt();
    let text = 'Keine Regeln hinterlegt.';
    try { text = (await kern.leseArtikel(user, 'wissen/_regeln/REGELN.md')).text; } catch { /* fehlt oder nicht sichtbar */ }
    return { contents: [{ uri: uri.href, mimeType: 'text/markdown', text }] };
  });

  return s;
}

/** Wegweiser: index.md aus core (nach Rechten), sonst eine Liste der sichtbaren Artikel je Gruppe. */
export async function wegweiser(kern: KernLike, user: User): Promise<string> {
  if (typeof kern.ordnerIndex === 'function') {
    const teile = [await kern.ordnerIndex(user, ''), await kern.ordnerIndex(user, 'wissen')].filter(Boolean);
    return teile.join('\n\n');
  }
  const je = new Map<string, string[]>();
  for (const a of await kern.listeWissen(user)) {
    const g = String(a.kopf.gruppe ?? 'allgemein');
    je.set(g, [...(je.get(g) ?? []), `- ${a.kopf.titel} (${a.pfad})`]);
  }
  return ['# Wegweiser', ...[...je.entries()].sort().map(([g, l]) => `## ${g}\n${l.join('\n')}`)].join('\n\n');
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
