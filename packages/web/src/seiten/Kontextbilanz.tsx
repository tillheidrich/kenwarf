import type { ComponentChildren } from 'preact';
import { api } from '../api';
import type { KiStatus, Kontextbilanz } from '../api/types';
import { datum } from '../lib/datum';
import { useLaden } from '../lib/laden';
import { PRODUKT } from '../produkt';
import { Icon } from '../ui/Icon';
import { Fehlerhinweis, KnopfLink, Laedt } from '../ui/teile';

// CONTRACT v1.4 Abschnitt 9: Kontextbilanz, zugleich der Wert-Bericht.
// Gemessen wird ohne Beobachten: Zahlen aus Dateien, git, Eingang und Tageszählern, keine Fragen, keine Personen.
// Die Gruppen folgen den Stufen aus Tills Leitgedanken (05:36). Stufe 4 ist Fahrplan und wird nicht als Zahl behauptet.

export const KI_STATUS_TEXT: Record<KiStatus, { text: string; art: 'ok' | 'warn' | '' }> = {
  ohne_ki: { text: 'ohne KI', art: '' },
  ungeprueft: { text: 'noch nicht geprüft', art: 'warn' },
  geprueft: { text: 'geprüft', art: 'ok' },
  unter_schwelle: { text: 'unter der Schwelle', art: 'warn' },
};

function zahl(n: number | null | undefined) {
  return n === null || n === undefined ? '–' : n.toLocaleString('de-DE');
}
function anteil(n: number | null) {
  return n === null ? '–' : `${Math.round(n * 100)} %`;
}
function dauer(sek: number) {
  const m = Math.floor(sek / 60);
  const s = sek % 60;
  return m ? `${m} min ${s} s` : `${s} s`;
}

function Wert({ zahl: z, text, ton }: { zahl: string; text: string; ton?: 'warn' | 'ok' }) {
  return (
    <div class={`bilanz-wert${ton ? ` bilanz-wert--${ton}` : ''}`}>
      <dt>{text}</dt>
      <dd class={/^[\d.,\s%/–]+$/.test(z) ? 'mono' : 'bilanz-text'}>{z}</dd>
    </div>
  );
}

function Stufe({ nr, titel, satz, children }: { nr: string; titel: string; satz: string; children: ComponentChildren }) {
  return (
    <section class="bilanz-stufe" aria-labelledby={`bs-${nr}`}>
      <header class="bilanz-stufe-kopf">
        <span class="mono bilanz-nr" aria-hidden="true">
          {nr}
        </span>
        <div>
          <h3 id={`bs-${nr}`} class="bilanz-titel">
            {titel}
          </h3>
          <p class="meta-klein">{satz}</p>
        </div>
      </header>
      <dl class="bilanz-werte">{children}</dl>
    </section>
  );
}

export function KontextbilanzInhalt() {
  const r = useLaden(() => api.kontextbilanz(), []);
  if (r.laedt) return <Laedt />;
  if (r.fehler || !r.daten) return <Fehlerhinweis text={r.fehler ?? ''} nochmal={r.neu} />;
  const b: Kontextbilanz = r.daten;
  const ki = KI_STATUS_TEXT[b.pruefbank.kiStatus];
  const gefragt = b.antworten.belegt + b.antworten.stehtNichtDrin;
  return (
    <div class="bilanz">
      <p class="bilanz-satz">
        Was euer Kontext wert ist, in Zahlen aus euren eigenen Dateien. {PRODUKT} zählt nur Summen: keine Fragen, keine Namen, nichts verlässt diese Instanz.
      </p>
      <Stufe nr="01" titel="Erfasst" satz="Was drinsteht">
        <Wert zahl={zahl(b.bestand.artikel)} text="Artikel" />
        <Wert zahl={zahl(b.bestand.quellen)} text="Quellen" />
        <Wert zahl={zahl(b.bestand.fakten)} text="Fakten" />
        <Wert zahl={zahl(b.bestand.entscheidungen)} text="Entscheidungen" />
      </Stufe>
      <Stufe nr="02" titel="Weiß Bescheid" satz={`Fragen vom ${datum(b.antworten.zeitraum.von)} bis ${datum(b.antworten.zeitraum.bis)}`}>
        <Wert zahl={zahl(b.antworten.belegt)} text="mit Beleg beantwortet" ton="ok" />
        <Wert zahl={zahl(b.antworten.stehtNichtDrin)} text="„steht nicht drin“" />
        <Wert zahl={gefragt ? `${Math.round((b.antworten.belegt / gefragt) * 100)} %` : '–'} text="Anteil belegt" />
        <Wert zahl={b.ersteBelegteAntwort ? dauer(b.ersteBelegteAntwort.sekundenSeitStart) : '–'} text="bis zur ersten belegten Antwort" />
      </Stufe>
      <Stufe nr="03" titel="Bemerkt" satz="Was aufgefallen ist, bevor es jemand suchen musste">
        <Wert zahl={zahl(b.bemerkt.befundeOffen)} text="Befunde offen" ton={b.bemerkt.befundeOffen ? 'warn' : undefined} />
        <Wert zahl={zahl(b.bemerkt.befundeErledigt)} text="Befunde erledigt" />
        <Wert zahl={zahl(b.bemerkt.vorAblaufGemeldet)} text="Fristen vor Ablauf gemeldet" />
        <Wert zahl={zahl(b.bemerkt.abgelaufeneFristen)} text="Fristen abgelaufen" ton={b.bemerkt.abgelaufeneFristen ? 'warn' : undefined} />
        <Wert zahl={zahl(b.luecken)} text="Lücken (mehrfach gefragt, steht nicht drin)" />
      </Stufe>
      <Stufe nr="··" titel="Gepflegt" satz="Damit der Stand stimmt">
        <Wert zahl={`${zahl(b.pflege.mitVerantwortlich)} / ${zahl(b.bestand.artikel)}`} text="Artikel mit Verantwortlichen" />
        <Wert zahl={`${zahl(b.pflege.mitPruefdatum)} / ${zahl(b.bestand.artikel)}`} text="mit Prüfdatum" />
        <Wert zahl={zahl(b.pflege.faellig)} text="Prüfung fällig" ton={b.pflege.faellig ? 'warn' : undefined} />
        <Wert zahl={zahl(b.eingang.offen)} text="Vorschläge offen" />
        <Wert zahl={zahl(b.eingang.freigegebenSeit)} text="freigegeben" />
      </Stufe>
      <Stufe nr="05" titel="Kontextschicht" satz="Wer außer euch mit diesem Wissen arbeitet">
        <Wert zahl={zahl(b.anbindungen.verbundeneApps)} text="verbundene Apps" />
        <Wert zahl={zahl(b.anbindungen.agentenZugaenge)} text="Agenten-Zugänge" />
        <Wert zahl={ki.text} text={`KI${b.pruefbank.modell ? ` (${b.pruefbank.modell})` : ''}`} ton={ki.art || undefined} />
        <Wert zahl={anteil(b.pruefbank.belegtreue)} text="Belegtreue im letzten Prüflauf" />
      </Stufe>
      <Stufe nr="06" titel="Bleibt" satz="Mitnehmbar, auch ohne uns">
        <Wert zahl={b.ausstieg.letzteProbe ? datum(b.ausstieg.letzteProbe) : 'noch nie'} text="letzte Ausstiegsprobe" />
        <Wert zahl={b.ausstieg.bestanden === null ? '–' : b.ausstieg.bestanden ? 'bestanden' : 'nicht bestanden'} text="Ergebnis" ton={b.ausstieg.bestanden ? 'ok' : b.ausstieg.bestanden === false ? 'warn' : undefined} />
      </Stufe>
      <p class="meta-klein">Stufe 4 („arbeitet zu“) steht auf dem Fahrplan und wird hier erst gezählt, wenn es sie gibt. Stand {datum(b.stand)}.</p>
    </div>
  );
}

/** Karte „Dein Kontext“ in Heute (nur Freigeber und Admins). Drei Zahlen, ein Link. */
export function KontextKarte() {
  const r = useLaden(() => api.kontextbilanz(), []);
  if (!r.daten) return null;
  const b = r.daten;
  return (
    <section class="kontext-karte" aria-labelledby="kk-titel">
      <div class="kontext-karte-kopf">
        <h2 id="kk-titel" class="abschnitt-titel">
          Dein Kontext
        </h2>
        <KnopfLink klein art="leise" href="#/einstellungen/kontext" iconRechts="pfeil">
          Kontextbilanz
        </KnopfLink>
      </div>
      <dl class="kontext-zahlen">
        <div>
          <dt>Artikel und Quellen</dt>
          <dd class="mono">{(b.bestand.artikel + b.bestand.quellen).toLocaleString('de-DE')}</dd>
        </div>
        <div>
          <dt>mit Beleg beantwortet</dt>
          <dd class="mono">{b.antworten.belegt.toLocaleString('de-DE')}</dd>
        </div>
        <div>
          <dt>bemerkt, offen</dt>
          <dd class="mono">{b.bemerkt.befundeOffen.toLocaleString('de-DE')}</dd>
        </div>
      </dl>
      {b.pruefbank.kiStatus === 'ungeprueft' || b.pruefbank.kiStatus === 'unter_schwelle' ? (
        <p class="meta-klein">
          <Icon name="warnung" groesse={14} /> KI {KI_STATUS_TEXT[b.pruefbank.kiStatus].text}. <a href="#/einstellungen/ki">Prüfen</a>
        </p>
      ) : null}
    </section>
  );
}
