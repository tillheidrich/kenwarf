import type { KernLike, ProviderConfig, User } from './types.js';
import type { ServerConfig } from './config.js';
import { bauProvider, leseKernYaml, schreibeKernYaml } from './config.js';
import type { Geheimnisse } from './geheimnisse.js';
import type { Abruf } from './egress.js';

/**
 * v1.4 4.1, 5.1, 8.2: KI-Block in `kern.yaml` (`ki:`): Anbieter ohne Schlüssel, dazu `weg`, `voreinstellung`,
 * `status` (KiStatus) und `vorher` (letzte Anbieterkonfiguration ohne Schlüssel, Rückweg).
 * Ein Anbieterwechsel setzt immer `ungeprueft`; erst ein bestandener Prüfbank-Lauf setzt `geprueft`.
 */
export type KiWeg = 'hd_test' | 'eigener_schluessel' | 'app' | 'ohne';
export type KiStatus = 'ohne_ki' | 'ungeprueft' | 'geprueft' | 'unter_schwelle';
export interface KiBlock {
  art?: string; url?: string; chatModell?: string; embedModell?: string; anbieter?: string;
  weg?: KiWeg; voreinstellung?: string | null; status?: KiStatus; vorher?: KiBlock | null;
  [k: string]: unknown;
}

const OHNE_SCHLUESSEL = new Set(['apiKey', 'schluessel', 'vorher']);

/** Kopie ohne Schlüssel und ohne verschachteltes `vorher` (für den Rückweg). */
export function ohneGeheimnis(k: KiBlock | undefined | null): KiBlock | null {
  if (!k || typeof k !== 'object') return null;
  return Object.fromEntries(Object.entries(k).filter(([n, v]) => !OHNE_SCHLUESSEL.has(n) && v !== undefined)) as KiBlock;
}

export class KiVerwaltung {
  constructor(private kern: KernLike, private config: ServerConfig, private geheimnisse: Geheimnisse) {}

  /** KI-Block aus kern.yaml (`ki` oder älter `provider`). */
  lies(): KiBlock {
    const y = leseKernYaml(this.config.dataDir);
    const k = (y.ki ?? y.provider ?? {}) as KiBlock;
    return typeof k === 'object' && k ? k : {};
  }
  /** Betreiber hat den Anbieter per Umgebung festgelegt: dann ändert die Instanz ihn nicht. */
  get festDurchUmgebung(): boolean { return !!this.config.umgebung.KERN_PROVIDER; }

  weg(): KiWeg | null {
    const k = this.lies();
    if (k.weg) return k.weg;
    return this.config.kern.provider.art === 'mock' ? null : 'eigener_schluessel';
  }
  status(): KiStatus {
    const k = this.lies();
    if (k.status) return k.status;
    const w = this.weg();
    return this.config.kern.provider.art === 'mock' || w === 'ohne' || w === 'app' ? 'ohne_ki' : 'ungeprueft';
  }
  /** Fragen ohne KI beantworten (Weg „ohne“ oder „app“: die App bringt ihr eigenes Modell mit). */
  ohneKi(): boolean { const w = this.weg(); return w === 'ohne' || w === 'app'; }

  ansicht() {
    const k = this.lies();
    return { status: this.status(), weg: this.weg(), voreinstellung: k.voreinstellung ?? (typeof k.anbieter === 'string' ? k.anbieter : null), vorher: !!k.vorher };
  }

  /** Provider-Konfiguration aus einem KI-Block (wie beim Start). */
  provider(k: KiBlock): ProviderConfig {
    const w: string[] = [];
    return bauProvider(k as Record<string, unknown>, this.config.umgebung, w, {
      modus: this.config.modus, anbieter: this.config.anbieter, geheimnis: (n) => this.geheimnisse.hole(n) ?? undefined,
    });
  }

  /**
   * Schreibt den KI-Block (über core mit Commit, sonst direkt) und wendet den Anbieter an.
   * Gibt zurück, ob der Wechsel sofort wirkt (core.setzeProvider) oder erst nach einem Neustart.
   */
  async speichere(u: User, neu: KiBlock): Promise<{ sofort: boolean }> {
    const sauber = Object.fromEntries(Object.entries(neu).filter(([n, v]) => n !== 'apiKey' && n !== 'schluessel' && v !== undefined)) as KiBlock;
    if (typeof this.kern.speichereEinstellungen === 'function') {
      const y = leseKernYaml(this.config.dataDir);
      await this.kern.speichereEinstellungen(u, { ki: sauber, ...(y.provider !== undefined ? { provider: undefined } : {}) });
    } else {
      const y = leseKernYaml(this.config.dataDir);
      y.ki = sauber;
      delete y.provider;
      schreibeKernYaml(this.config.dataDir, y);
    }
    const p = this.provider(sauber);
    const vorher = this.config.kern.provider;
    this.config.kern.provider = p;
    if (typeof this.kern.setzeProvider === 'function') {
      await this.kern.setzeProvider(p);
      return { sofort: true };
    }
    // Ohne Laufzeitwechsel in core bleibt der alte Anbieter bis zum Neustart aktiv; Anzeige soll das ehrlich sagen.
    this.config.kern.provider = vorher;
    return { sofort: false };
  }

  /** Nur den Prüfstatus setzen (nach einem Prüfbank-Lauf), ohne Anbieterwechsel. */
  async setzeStatus(u: User, status: KiStatus): Promise<void> {
    const k = this.lies();
    if (k.status === status) return;
    const neu = { ...k, status };
    if (typeof this.kern.speichereEinstellungen === 'function') await this.kern.speichereEinstellungen(u, { ki: neu });
    else { const y = leseKernYaml(this.config.dataDir); y.ki = neu; delete y.provider; schreibeKernYaml(this.config.dataDir, y); }
  }
}

/** Ergebnis „Verbindung testen“. */
export interface VerbindungsTest { ok: boolean; meldung: string }

/**
 * Prüft eine Anbieterverbindung mit einem leichten Abruf (Modellliste), über den Egress-Proxy.
 * Nie den Schlüssel oder die volle Adresse in die Meldung.
 */
export async function testeVerbindung(p: ProviderConfig, abruf: Abruf): Promise<VerbindungsTest> {
  if (p.art === 'mock') return { ok: true, meldung: 'Ohne KI: Suche und wörtliche Auszüge mit Fundstelle.' };
  const host = (u: string) => { try { return new URL(u).host; } catch { return 'die Adresse'; } };
  try {
    if (p.art === 'ollama') {
      const r = await abruf(`${p.url.replace(/\/+$/, '')}/api/tags`, { headers: { accept: 'application/json' } });
      if (!r.ok) return { ok: false, meldung: `Der Ollama-Server unter ${host(p.url)} antwortet mit HTTP ${r.status}.` };
      const d = (await r.json().catch(() => ({}))) as { models?: { name?: string }[] };
      const namen = (d.models ?? []).map((m) => String(m.name ?? ''));
      const fehlt = [p.chatModell, p.embedModell].filter((m) => m && !namen.some((n) => n === m || n.startsWith(`${m}:`)));
      if (fehlt.length) return { ok: false, meldung: `Erreichbar, aber diese Modelle sind dort nicht geladen: ${fehlt.join(', ')}. Mit „ollama pull <name>“ laden.` };
      return { ok: true, meldung: `Verbunden mit Ollama (${host(p.url)}).` };
    }
    if (p.art === 'openai') {
      const r = await abruf(`${p.url.replace(/\/+$/, '')}/models`, { headers: { accept: 'application/json', ...(p.apiKey ? { authorization: `Bearer ${p.apiKey}` } : {}) } });
      if (r.status === 401 || r.status === 403) return { ok: false, meldung: `${host(p.url)} lehnt den Schlüssel ab (HTTP ${r.status}).` };
      if (!r.ok) return { ok: false, meldung: `${host(p.url)} antwortet mit HTTP ${r.status}.` };
      return { ok: true, meldung: `Verbunden mit ${host(p.url)}.` };
    }
    const r = await abruf('https://api.anthropic.com/v1/models', { headers: { 'x-api-key': p.apiKey, 'anthropic-version': '2023-06-01', accept: 'application/json' } });
    if (r.status === 401 || r.status === 403) return { ok: false, meldung: `api.anthropic.com lehnt den Schlüssel ab (HTTP ${r.status}).` };
    if (!r.ok) return { ok: false, meldung: `api.anthropic.com antwortet mit HTTP ${r.status}.` };
    return { ok: true, meldung: 'Verbunden mit api.anthropic.com.' };
  } catch (e) {
    const zeit = (e as Error)?.name === 'TimeoutError' || (e as Error)?.name === 'AbortError';
    const url = p.art === 'anthropic' ? 'https://api.anthropic.com' : p.url;
    return { ok: false, meldung: zeit ? `${host(url)} antwortet nicht innerhalb von 10 Sekunden.` : `${host(url)} ist von diesem Server aus nicht erreichbar.` };
  }
}
