import { ApiFehler } from './types';
import type { KernApi, PruefErgebnis, TokenScope, User, ZugangsToken } from './types';
import { apiPfad } from '../lib/pfade';

const BASIS = 'api';

/** Relativ zur Seite, damit die App auch unter einem Unterpfad läuft (base: './'). */
function url(p: string): string {
  return `${BASIS}/${p.replace(/^\//, '')}`;
}

const FEHLERTEXT: Record<number, string> = {
  400: 'Die Eingabe passt nicht. Bitte prüf die Felder.',
  401: 'Du bist nicht mehr angemeldet.',
  403: 'Dafür fehlen dir die Rechte.',
  404: 'Das gibt es nicht (mehr).',
  409: 'Jemand anderes hat das gerade geändert. Lade die Seite neu.',
  413: 'Die Datei ist zu groß.',
  423: 'Gerade ist alles nur lesbar. Export und Anmelden gehen weiter.',
  500: 'Auf dem Server ist etwas schiefgegangen.',
  502: 'Der Server antwortet gerade nicht.',
  503: 'Der Server ist gerade nicht erreichbar.',
};

async function anfrage<T>(methode: string, p: string, body?: unknown): Promise<T> {
  const headers: Record<string, string> = { 'x-kern': '1', accept: 'application/json' };
  let payload: BodyInit | undefined;
  if (body instanceof FormData) payload = body;
  else if (body !== undefined) {
    headers['content-type'] = 'application/json';
    payload = JSON.stringify(body);
  }
  let res: Response;
  try {
    res = await fetch(url(p), { method: methode, headers, body: payload, credentials: 'same-origin' });
  } catch {
    throw new ApiFehler(0, 'Keine Verbindung zum Server. Bist du online?');
  }
  if (res.status === 204) return undefined as T;
  const text = await res.text();
  let daten: unknown = null;
  try {
    daten = text ? JSON.parse(text) : null;
  } catch {
    daten = null;
  }
  if (!res.ok) {
    const meldung =
      (daten && typeof daten === 'object' && 'fehler' in daten && typeof (daten as { fehler: unknown }).fehler === 'string'
        ? (daten as { fehler: string }).fehler
        : null) ??
      (daten && typeof daten === 'object' && 'error' in daten && typeof (daten as { error: unknown }).error === 'string'
        ? (daten as { error: string }).error
        : null) ??
      FEHLERTEXT[res.status] ??
      `Fehler ${res.status}`;
    if (res.status === 423) dispatchEvent(new CustomEvent('kern:nur-lesen'));
    if (res.status === 403 && daten && typeof daten === 'object' && (daten as { code?: unknown }).code === 'passwort_aendern') {
      dispatchEvent(new CustomEvent('kern:passwort-aendern'));
    }
    throw new ApiFehler(res.status, meldung);
  }
  return daten as T;
}

/** Server kann `User` direkt oder `{ user }` / `{ ich }` liefern; beides wird akzeptiert. */
function alsUser(d: unknown): User {
  if (d && typeof d === 'object') {
    const o = d as Record<string, unknown>;
    if ('user' in o && o.user) return o.user as User;
    if ('ich' in o && o.ich) return o.ich as User;
  }
  return d as User;
}

function qs(o: Record<string, string | undefined>): string {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(o)) if (v) p.set(k, v);
  const s = p.toString();
  return s ? `?${s}` : '';
}

/** F1 hat zwischen `scope` und `scopes` gewechselt; beides wird gelesen. */
function alsToken(d: unknown): ZugangsToken {
  const o = (d ?? {}) as Record<string, unknown>;
  const sc = (Array.isArray(o.scopes) ? o.scopes : Array.isArray(o.scope) ? o.scope : []) as string[];
  const scopes = sc.map((x) => (x.startsWith('kern:') ? x : x === 'schreiben' ? 'kern:vorschlagen' : x === 'admin' ? 'kern:verwalten' : `kern:${x}`)) as TokenScope[];
  return { ...(o as unknown as ZugangsToken), bezeichnung: String(o.bezeichnung ?? 'Zugang'), scopes };
}

export const httpApi: KernApi = {
  async login(name, passwort) {
    return alsUser(await anfrage('POST', 'login', { name, passwort }));
  },
  async logout() {
    await anfrage('POST', 'logout');
  },
  async ich() {
    try {
      return alsUser(await anfrage('GET', 'ich'));
    } catch (e) {
      if (e instanceof ApiFehler && e.status === 401) return null;
      throw e;
    }
  },
  wissen: (gruppe) => anfrage('GET', `wissen${qs({ gruppe })}`),
  artikel: (pfad) => anfrage('GET', `wissen/${apiPfad(pfad, 'wissen')}`),
  verlauf: (pfad) => anfrage('GET', `wissen/${apiPfad(pfad, 'wissen')}/verlauf`),
  quellen: (sammlung) => anfrage('GET', `quellen${qs({ sammlung })}`),
  quelle: (pfad) => anfrage('GET', `quellen/${apiPfad(pfad, 'quellen')}`),
  originalUrl: (pfad) => url(`quellen/${apiPfad(pfad, 'quellen')}/original`),
  suche: (q, opt = {}) => anfrage('GET', `suche${qs({ q, reichweite: opt.reichweite, sammlung: opt.sammlung })}`),
  frage: (frage, opt = {}) => anfrage('POST', 'frage', { frage, ...opt }),
  hinzufuegen(e) {
    const f = new FormData();
    f.set('art', e.art);
    f.set('sammlung', e.sammlung);
    f.set('sichtbarkeit', e.sichtbarkeit);
    if (e.titel) f.set('titel', e.titel);
    if (e.inhalt) f.set('inhalt', e.inhalt);
    if (e.url) f.set('url', e.url);
    if (e.beobachten) f.set('beobachten', 'true');
    if (e.datei) f.set('datei', e.datei, e.dateiname ?? (e.datei instanceof File ? e.datei.name : 'aufnahme.webm'));
    return anfrage('POST', 'hinzufuegen', f);
  },
  eingang: () => anfrage('GET', 'eingang'),
  entscheide: (id, e) => anfrage('POST', `eingang/${encodeURIComponent(id)}`, e),
  vorschlag: (v) => anfrage('POST', 'vorschlag', v),
  briefing: (seit) => anfrage('GET', `briefing${qs({ seit })}`),
  faellig: () => anfrage('GET', 'faellig'),
  fakten: (f = {}) => anfrage('GET', `fakten${qs(f)}`),
  async pruefen() {
    // Server kann Befund[] oder { befunde, vorschlaege } liefern
    const d = await anfrage<unknown>('POST', 'pruefen', {});
    if (Array.isArray(d)) return { befunde: d as PruefErgebnis['befunde'], vorschlaege: d.length };
    const o = (d ?? {}) as Partial<PruefErgebnis> & { vorschlaege?: unknown };
    const befunde = Array.isArray(o.befunde) ? o.befunde : [];
    const v = Array.isArray(o.vorschlaege) ? o.vorschlaege.length : typeof o.vorschlaege === 'number' ? o.vorschlaege : befunde.length;
    return { befunde, vorschlaege: v };
  },
  datenweg: () => anfrage('GET', 'datenweg'),
  heute: () => anfrage('GET', 'heute'),
  async gelesen(e) {
    // Lesestand ist nur für einen selbst; Fehler hier dürfen das Lesen nie stören
    try {
      await anfrage('POST', 'gelesen', e);
    } catch {
      /* egal */
    }
  },
  lesen: () => anfrage('GET', 'lesen'),
  speichereLesen: (e) => anfrage('PUT', 'lesen', e),
  lesebilanz: () => anfrage('GET', 'lesebilanz'),
  neueAnsicht: (e) => anfrage('POST', 'ansichten', e),
  einschaetzung: (e) => anfrage('POST', 'einschaetzung', e),
  meldeFehler: (f) => anfrage('POST', 'fehler', f),
  importieren(e) {
    const f = new FormData();
    f.set('art', e.art);
    f.set('sammlung', e.sammlung);
    f.set('sichtbarkeit', e.sichtbarkeit);
    if (e.pfad) f.set('pfad', e.pfad);
    if (e.datei) f.set('datei', e.datei, e.datei.name);
    return anfrage('POST', 'importieren', f);
  },
  einstellungen: () => anfrage('GET', 'einstellungen'),
  speichereEinstellungen: (e) => anfrage('PUT', 'einstellungen', e),
  benutzer: () => anfrage('GET', 'benutzer'),
  legeBenutzerAn: (b) => anfrage('POST', 'benutzer', b),
  async setzePasswortZurueck(id) {
    return anfrage('POST', `benutzer/${encodeURIComponent(id)}/passwort-zuruecksetzen`, {});
  },
  async widerrufeTokensVon(id) {
    await anfrage('DELETE', `benutzer/${encodeURIComponent(id)}/tokens`);
  },
  async aenderePasswort(alt, neu) {
    await anfrage('POST', 'ich/passwort', { alt, neu });
  },
  async abmeldenUeberall() {
    const d = await anfrage<{ tokensWiderrufen?: number }>('POST', 'ich/abmelden-ueberall', {});
    return { tokensWiderrufen: d?.tokensWiderrufen ?? 0 };
  },
  geraete: () => anfrage('GET', 'ich/geraete'),
  async meldeGeraetAb(id) {
    await anfrage('DELETE', `ich/geraete/${encodeURIComponent(id)}`);
  },
  async tokens() {
    const d = await anfrage<unknown[]>('GET', 'ich/tokens');
    return (Array.isArray(d) ? d : []).map(alsToken);
  },
  async legeTokenAn(e) {
    const d = await anfrage<{ token: string; eintrag: unknown; hinweis?: string }>('POST', 'ich/tokens', e);
    return { token: d.token, eintrag: alsToken(d.eintrag), hinweis: d.hinweis };
  },
  async widerrufeToken(id) {
    await anfrage('DELETE', `ich/tokens/${encodeURIComponent(id)}`);
  },
  // v1.4 (CONTRACT Nachtrag v1.4, Abschnitte 3.5, 4.1, 5.2, 6.3, 7, 8, 9)
  async einrichtung() {
    try {
      return await anfrage('GET', 'einrichtung');
    } catch (e) {
      if (e instanceof ApiFehler && (e.status === 404 || e.status === 403)) return null;
      throw e;
    }
  },
  einrichtungKi: (e) => anfrage('PUT', 'einrichtung/ki', e),
  async einrichtungBeispiel(aktion) {
    await anfrage('POST', 'einrichtung/beispiel', { aktion });
  },
  async einrichtungFertig() {
    await anfrage('POST', 'einrichtung/fertig', {});
  },
  async speichereKiSchluessel(anbieter, schluessel) {
    await anfrage('PUT', 'einstellungen/ki-schluessel', { anbieter, schluessel });
  },
  kiZurueck: () => anfrage('POST', 'einstellungen/ki/zurueck', {}),
  pruefbankLauf: () => anfrage('POST', 'pruefbank/lauf', {}),
  async pruefbank() {
    try {
      return await anfrage('GET', 'pruefbank');
    } catch (e) {
      if (e instanceof ApiFehler && e.status === 404) return null;
      throw e;
    }
  },
  async konto() {
    try {
      return await anfrage('GET', 'konto');
    } catch (e) {
      // 404 = Selbstbetrieb (kein Leitstand), 403 = kein Admin: Bereich ausblenden
      if (e instanceof ApiFehler && (e.status === 404 || e.status === 403)) return null;
      throw e;
    }
  },
  kontoAktion: (a, body) => anfrage('POST', `konto/${a}`, body ?? {}),
  starteExport: (art, passphrase) => anfrage('POST', 'export', passphrase ? { art, passphrase } : { art }),
  exportStand: (id) => anfrage('GET', `export/${encodeURIComponent(id)}`),
  async starteAusstiegsprobe() {
    await anfrage('POST', 'ausstiegsprobe', {});
  },
  async ausstiegsprobe() {
    try {
      return await anfrage('GET', 'ausstiegsprobe');
    } catch (e) {
      if (e instanceof ApiFehler && e.status === 404) return null;
      throw e;
    }
  },
  async apps() {
    const d = await anfrage<unknown[]>('GET', 'ich/apps');
    return Array.isArray(d) ? (d.map((x) => ({ ...(x as object), scopes: alsToken(x).scopes })) as never) : [];
  },
  async trenneApp(clientId) {
    await anfrage('DELETE', `ich/apps/${encodeURIComponent(clientId)}`);
  },
  kontextbilanz: () => anfrage('GET', 'kontextbilanz'),
};
