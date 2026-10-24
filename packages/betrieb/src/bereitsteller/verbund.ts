/**
 * Verbund: der Leitstand hat genau einen Bereitsteller; dieser verteilt nach Host. Geteilte Hosts → je ein
 * Docker-Bereitsteller (eine Engine je Host), eigene Maschinen (Host-ID `m-…`, vom Leitstand vergeben) → Hetzner.
 * Ein Stufenwechsel zwischen zwei Docker-Hosts läuft über die Engine API (Archiv, Prüfsumme). Geteilt ↔ Eigene
 * Maschine braucht den Export der Instanz und einen Import am Ziel; bis server/cli das liefern, scheitert der Schritt
 * `paket_bauen` bzw. `uebertragen` ehrlich, und der Rückbau löscht den neuen Server wieder.
 */
import type { Auftrag, Bereitsteller, Grenzen, Modus, SchrittErgebnis, Wechselauftrag } from './typ.js';
import { STANDARD_SCHRITTE, WECHSEL_SCHRITTE } from './typ.js';
import { DockerBereitsteller } from './docker.js';
import { HetznerBereitsteller } from './hetzner.js';
import type { Beispiel, Stufe } from '../typen.js';

export class VerbundBereitsteller implements Bereitsteller {
  readonly name = 'verbund';
  readonly schritte = STANDARD_SCHRITTE;
  readonly wechselSchritte = WECHSEL_SCHRITTE;
  /** Wird nach dem Bau des Leitstands gesetzt: `(id) => leitstand.instanz(id).host`. */
  hostVon: (id: string) => string = () => { throw new Error('VerbundBereitsteller.hostVon nicht gesetzt'); };

  constructor(readonly geteilt: Record<string, DockerBereitsteller>, readonly eigen: HetznerBereitsteller | null = null) {
    for (const d of Object.values(geteilt)) if (!d.o.ziel) d.o.ziel = (h) => this.geteilt[h] ?? null;
  }
  schritteFuer(s: Stufe) { return s === 'eigen' && this.eigen ? this.eigen.schritte : this.schritte; }
  mitglied(host: string): Bereitsteller {
    if (host.startsWith('m-')) { if (!this.eigen) throw new Error('Kein Hetzner-Bereitsteller eingerichtet'); return this.eigen; }
    const d = this.geteilt[host];
    if (!d) throw new Error(`Kein Docker-Bereitsteller für Host ${host}`);
    return d;
  }
  private fuer(id: string) { return this.mitglied(this.hostVon(id)); }

  schritt(name: string, a: Auftrag): Promise<SchrittErgebnis> { return this.mitglied(a.host).schritt(name, a); }
  status(id: string) { return this.fuer(id).status(id); }
  modus(id: string, m: Modus) { return this.fuer(id).modus(id, m); }
  grenzen(id: string, g: Grenzen) { return this.fuer(id).grenzen(id, g); }
  egress(id: string, h: string[]) { return this.fuer(id).egress(id, h); }
  export(id: string, art: 'umzugspaket' | 'okf') { return this.fuer(id).export(id, art); }
  beispiel(id: string, a: 'laden' | 'entfernen', s: Beispiel | null) { return this.fuer(id).beispiel(id, a, s); }
  einladung(id: string, mail: string) { return this.fuer(id).einladung(id, mail); }
  loeschen(id: string) { return this.fuer(id).loeschen(id); }
  async hostLast(host: string) { const m = this.mitglied(host); return m.hostLast ? m.hostLast(host) : null; }
  async wartung() { return this.eigen ? this.eigen.wartung() : []; }

  /** Docker-Bereitsteller einer Seite des Wechsels: geteilter Host direkt, eigene Maschine über den Tunnel. */
  private docker(host: string, id: string): DockerBereitsteller {
    const m = this.mitglied(host);
    if (m instanceof DockerBereitsteller) return m;
    if (m instanceof HetznerBereitsteller) return m.maschine(id);
    throw new Error('Kein Docker-Weg zu diesem Host');
  }
  /** Umzugspaket zwischen Ausgabe und Einspielen; nur im Speicher, Passphrase nie auf Platte des Leitstands. */
  private unterwegs = new Map<string, { name: string; inhalt: Buffer; sha256: string; passphrase: string }>();

  async wechselSchritt(name: string, w: Wechselauftrag): Promise<{ meldung?: string; ergebnis?: Record<string, string | number> }> {
    const von = this.mitglied(w.von.host), nach = this.mitglied(w.nach.host);
    if (von instanceof DockerBereitsteller && nach instanceof DockerBereitsteller) return von.wechselSchritt(name, w);
    // Geteilt ↔ Eigene Maschine: Umzugspaket der Instanz (age, Passphrase), Transport über die Engine API durch den Tunnel
    const quelle = () => this.docker(w.von.host, w.id), ziel = () => this.docker(w.nach.host, w.id);
    const a = { id: w.id, subdomain: w.subdomain, paket: w.paket, region: w.region, stufe: w.nach.stufe, admin_mail: null, ki_vorlage: 'mock' as const, beispiel: null, host: w.nach.host, konto_token: '' };
    switch (name) {
      case 'ziel_bereitstellen': {
        const meld: string[] = [];
        // DNS erst beim Umschalten, sonst ginge Verkehr an eine leere Maschine
        if (nach instanceof HetznerBereitsteller) for (const s of ['server_anlegen', 'warten_auf_rueckruf', 'tunnel_aufbauen']) { const r = await nach.maschineSchritt(s, a); if (r.meldung) meld.push(r.meldung); }
        const r = await ziel().schritt('volume_anlegen', a);
        if (r.meldung) meld.push(r.meldung);
        return { meldung: meld.join(' · ') };
      }
      case 'alt_nur_lesen': await quelle().modus(w.id, 'nur_lesen'); return {};
      case 'paket_bauen': {
        const ex = await quelle().client(w.id).exportVoll('umzugspaket');
        if (!ex.datei || !ex.passphrase) throw new Error('Export ohne Datei oder Passphrase');
        const d = await quelle().dateiHolen(w.id, ex.datei);
        if (d.sha256 !== ex.sha256) throw new Error(`Prüfsumme an der Quelle weicht ab (${d.sha256.slice(0, 12)}… statt ${ex.sha256.slice(0, 12)}…)`);
        const tar = (await import('./docker.js')).tarDatei(d.tar);
        this.unterwegs.set(w.id, { name: ex.datei.split('/').pop()!, inhalt: tar.inhalt, sha256: ex.sha256, passphrase: ex.passphrase });
        return { ergebnis: { bytes: ex.bytes, sha256: ex.sha256 } };
      }
      case 'uebertragen': {
        const u = this.unterwegs.get(w.id);
        if (!u) throw new Error('kein Paket unterwegs');
        const am = await ziel().dateienAblegen(w.id, [{ name: u.name, inhalt: u.inhalt, modus: 0o400 }, { name: '.import-passphrase', inhalt: Buffer.from(u.passphrase), modus: 0o400 }]);
        if (am[u.name] !== u.sha256) throw new Error('Prüfsumme am Ziel weicht ab');
        return { meldung: `${u.inhalt.length} Bytes übertragen, Prüfsumme am Ziel gleich` };
      }
      case 'einspielen': {
        const u = this.unterwegs.get(w.id);
        if (!u) throw new Error('kein Paket unterwegs');
        const z = ziel();
        await z.anlegen(a, { KERN_IMPORT_PAKET: `/daten-export/${u.name}`, KERN_IMPORT_PASSPHRASE_DATEI: '/daten-export/.import-passphrase' });
        await z.o.engine.containerStarten(z.name_(w.id));
        const m = await z.warteGesund(w.id);
        await z.dateiEntfernen(w.id, '/daten-export/.import-passphrase');
        return { meldung: `${m}, Passphrase am Ziel gelöscht` };
      }
      case 'pruefen': {
        const u = this.unterwegs.get(w.id);
        if (!u) throw new Error('kein Paket unterwegs');
        const b = await ziel().client(w.id).pruefbericht();
        if (!b.bestanden) throw new Error(`Prüfbericht am Ziel nicht bestanden (${b.pruefbericht_sha256.slice(0, 12)}…)`);
        const amZiel = (await ziel().dateiHolen(w.id, `/daten-export/${u.name}`)).sha256;
        await ziel().dateiEntfernen(w.id, `/daten-export/${u.name}`);
        this.unterwegs.delete(w.id);
        return { ergebnis: { alt: u.sha256, neu: amZiel, pruefbericht_sha256: b.pruefbericht_sha256 }, meldung: `Prüfbericht bestanden ${b.pruefbericht_sha256.slice(0, 16)}…` };
      }
      case 'umschalten':
        if (nach instanceof HetznerBereitsteller) return { meldung: await nach.dnsSetzen(w.id, w.subdomain) };
        if (von instanceof HetznerBereitsteller) { await von.o.api.dnsLoeschen(von.o.zone, w.subdomain, 'A'); await von.o.api.dnsLoeschen(von.o.zone, w.subdomain, 'AAAA'); return { meldung: 'eigener DNS-Eintrag entfernt, Wildcard des geteilten Hosts gilt' }; }
        return {};
      case 'alt_anhalten': { const q = quelle(); await q.o.engine.containerStoppen(q.name_(w.id)); return { meldung: 'alte Instanz angehalten (Rückfallebene 7 Tage)' }; }
      default: return {};
    }
  }
  async wechselRueckbau(w: Wechselauftrag) {
    const von = this.mitglied(w.von.host), nach = this.mitglied(w.nach.host);
    if (von instanceof DockerBereitsteller && nach instanceof DockerBereitsteller) return von.wechselRueckbau(w);
    this.unterwegs.delete(w.id);
    if (nach instanceof HetznerBereitsteller) await nach.wechselRueckbau(w);
    else await this.docker(w.nach.host, w.id).loeschenNurZiel(w.id);
    await this.docker(w.von.host, w.id).modus(w.id, 'normal').catch(() => undefined);
  }
  altLoeschen(id: string, host: string) { return this.mitglied(host).altLoeschen(id, host); }
}
