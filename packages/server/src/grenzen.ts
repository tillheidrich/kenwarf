/**
 * Grenzen gegen Missbrauch: Ratenlimits, Sperre je Konto, Herkunfts-IP hinter einem Proxy.
 * Alles im Speicher (eine Instanz je Kunde, ein Prozess). Obergrenze der Schlüssel gegen Speicherwachstum.
 */

const MAX_SCHLUESSEL = 20_000;

function begrenze<K, V>(m: Map<K, V>) {
  while (m.size > MAX_SCHLUESSEL) {
    const erster = m.keys().next();
    if (erster.done) break;
    m.delete(erster.value);
  }
}

/** Gleitendes Fenster: höchstens `max` Ereignisse je `fensterMs` und Schlüssel. */
export class Fenster {
  private ereignisse = new Map<string, number[]>();
  constructor(private max: number, private fensterMs: number) {}

  /** Sekunden bis zum nächsten erlaubten Ereignis, 0 wenn frei. Zählt nicht. */
  wartezeit(schluessel: string): number {
    if (this.max <= 0) return 0;
    const jetzt = Date.now();
    const l = (this.ereignisse.get(schluessel) ?? []).filter((t) => t > jetzt - this.fensterMs);
    if (l.length) this.ereignisse.set(schluessel, l); else this.ereignisse.delete(schluessel);
    if (l.length < this.max) return 0;
    return Math.max(1, Math.ceil(((l[0] ?? jetzt) + this.fensterMs - jetzt) / 1000));
  }

  zaehle(schluessel: string): void {
    if (this.max <= 0) return;
    const l = this.ereignisse.get(schluessel) ?? [];
    l.push(Date.now());
    this.ereignisse.set(schluessel, l);
    begrenze(this.ereignisse);
  }

  /** Prüft und zählt in einem Schritt. Gibt die Wartezeit zurück (0 = erlaubt und gezählt). */
  nimm(schluessel: string): number {
    const w = this.wartezeit(schluessel);
    if (w === 0) this.zaehle(schluessel);
    return w;
  }

  zuruecksetzen(schluessel: string): void {
    this.ereignisse.delete(schluessel);
  }
}

/**
 * Sperre je Konto, unabhängig von der IP: nach `frei` Fehlversuchen wird gesperrt,
 * jede weitere Sperre doppelt so lang (Start `basisSek`, höchstens `maxSek`).
 * Erfolg setzt zurück, ein Admin kann entsperren. Gilt auch für Namen, die es nicht gibt.
 */
export class KontoSperre {
  private stand = new Map<string, { fehler: number; bis: number; letzter: number }>();
  constructor(private frei = 5, private basisSek = 60, private maxSek = 3600, private vergessenMs = 24 * 3600_000) {}

  private schluessel(name: string) { return name.trim().toLowerCase().normalize('NFC'); }

  gesperrt(name: string): number {
    const s = this.stand.get(this.schluessel(name));
    if (!s) return 0;
    const jetzt = Date.now();
    if (jetzt - s.letzter > this.vergessenMs) { this.stand.delete(this.schluessel(name)); return 0; }
    return s.bis > jetzt ? Math.ceil((s.bis - jetzt) / 1000) : 0;
  }

  fehlschlag(name: string): void {
    const k = this.schluessel(name);
    const jetzt = Date.now();
    const s = this.stand.get(k) ?? { fehler: 0, bis: 0, letzter: jetzt };
    s.fehler += 1;
    s.letzter = jetzt;
    if (s.fehler >= this.frei) {
      const stufe = s.fehler - this.frei;
      s.bis = jetzt + Math.min(this.maxSek, this.basisSek * 2 ** Math.min(stufe, 16)) * 1000;
    }
    this.stand.set(k, s);
    begrenze(this.stand);
  }

  zuruecksetzen(name: string): void {
    this.stand.delete(this.schluessel(name));
  }
}

/**
 * Herkunfts-IP. Ohne vertrauten Proxy die Socket-Adresse. Mit `hops` vertrauten Proxys der Eintrag,
 * den der äußerste eigene Proxy angehängt hat: von rechts gezählt der `hops`-te Eintrag von
 * `X-Forwarded-For`. Alles links davon setzt der Client selbst und zählt nicht.
 */
export function herkunftsIp(socketIp: string | undefined, xff: string | undefined, hops: number): string {
  const sock = socketIp || 'lokal';
  if (hops <= 0 || !xff) return sock;
  const teile = xff.split(',').map((s) => s.trim()).filter(Boolean);
  if (teile.length < hops) return sock;
  const ip = teile[teile.length - hops]!;
  return /^[0-9a-fA-F:.[\]]{2,64}$/.test(ip) ? ip : sock;
}
