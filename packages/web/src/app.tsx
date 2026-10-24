import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { useApp, darf } from './kontext';
import { useRoute, geheZu } from './lib/router';
import { FolgenErkenner, istEingabe, istMac } from './lib/tasten';
import { Icon, type IconName } from './ui/Icon';
import { Dialog, Taste } from './ui/teile';
import { Befehlspalette } from './ui/Befehlspalette';
import { MOCK, api } from './api';
import type { Konto } from './api/types';
import { PRODUKT } from './produkt';
import { NurLesenLeiste, TestphaseLeiste } from './ui/TestphaseLeiste';
import { ErsteSchritte } from './seiten/ErsteSchritte';
import { Fragen } from './seiten/Fragen';
import { Wissen } from './seiten/Wissen';
import { Fakten } from './seiten/Fakten';
import { Dokumente } from './seiten/Dokumente';
import { Hinzufuegen } from './seiten/Hinzufuegen';
import { Eingang } from './seiten/Eingang';
import { Briefing } from './seiten/Briefing';
import { Heute } from './seiten/Heute';
import { Einstellungen } from './seiten/Einstellungen';
import { FundstelleSeite } from './seiten/Fundstelle';

export interface Bereich {
  id: string;
  text: string;
  icon: IconName;
  kuerzel: string;
  beschreibung: string;
}

export const BEREICHE: Bereich[] = [
  { id: 'heute', text: 'Heute', icon: 'heute', kuerzel: 'g t', beschreibung: 'Was sich getan hat und was auf dich wartet' },
  { id: 'fragen', text: 'Fragen', icon: 'fragen', kuerzel: 'g f', beschreibung: 'Frage stellen, Antwort mit Belegen' },
  { id: 'wissen', text: 'Wissen', icon: 'wissen', kuerzel: 'g w', beschreibung: 'Freigegebene Artikel lesen' },
  { id: 'fakten', text: 'Fakten', icon: 'fakten', kuerzel: 'g k', beschreibung: 'Preise, Fristen, Zuständigkeiten' },
  { id: 'dokumente', text: 'Dokumente', icon: 'dokumente', kuerzel: 'g d', beschreibung: 'Rohmaterial und Originale' },
  { id: 'hinzufuegen', text: 'Hinzufügen', icon: 'hinzufuegen', kuerzel: 'g h', beschreibung: 'Datei, Text, Webseite, Sprachnotiz' },
  { id: 'eingang', text: 'Eingang', icon: 'eingang', kuerzel: 'g e', beschreibung: 'Vorschläge prüfen und freigeben' },
  { id: 'einstellungen', text: 'Einstellungen', icon: 'einstellungen', kuerzel: 'g s', beschreibung: 'Betrieb, KI, Benutzer, Zugang, Export' },
];

const MOBIL_UNTEN = ['heute', 'fragen', 'hinzufuegen', 'eingang'];

function Marke({ betrieb }: { betrieb: string }) {
  return (
    <a href="#/heute" class="marke">
      <span class="marke-zeichen" aria-hidden="true" />
      <span class="marke-text">
        <span class="marke-name">{PRODUKT}</span>
        <span class="marke-betrieb">{betrieb}</span>
      </span>
    </a>
  );
}

/** v1.4 D-L14 / G1 L-2: „Quelltext dieser Version“ auf den Git-Tag. Version und Adresse kommen beim Bauen. */
function QuelltextLink() {
  const version = (import.meta.env.VITE_KERN_VERSION as string | undefined) || '0.1.0';
  const repo = import.meta.env.VITE_QUELLTEXT_URL as string | undefined;
  return repo ? (
    <a href={`${repo.replace(/\/$/, '')}/src/tag/v${version}`} rel="noopener">
      Quelltext dieser Version (v{version}, AGPL)
    </a>
  ) : (
    <span>
      {PRODUKT} v{version}, freie Software (AGPL)
    </span>
  );
}

function initialen(name: string) {
  return name
    .split(/\s+/)
    .map((t) => t[0])
    .slice(0, 2)
    .join('')
    .toUpperCase();
}

export function App() {
  const { ich, einstellungen, offen, abmelden } = useApp();
  const route = useRoute();
  const bereich = route.bereich || 'heute';
  const [palette, setPalette] = useState(false);
  const [hilfe, setHilfe] = useState(false);
  const [mehr, setMehr] = useState(false);
  const mac = useMemo(istMac, []);
  const hauptRef = useRef<HTMLElement>(null);
  const ersterLauf = useRef(true);
  const betrieb = einstellungen?.betrieb ?? 'Wissen';
  const [konto, setKonto] = useState<Konto | null>(null);
  const [nurLesen, setNurLesen] = useState(ich.modus === 'nur_lesen');

  // Konto (nur Admin, nur Managed) und Einrichtung nach dem Kauf (v1.4 3.5, 4.1)
  useEffect(() => {
    api.konto().then(setKonto, () => undefined);
    api.einrichtung().then(
      (e) => {
        if (e && e.schritt !== 'fertig' && (location.hash === '' || location.hash === '#/' || location.hash === '#/heute')) geheZu('start');
      },
      () => undefined,
    );
    const nl = () => setNurLesen(true);
    addEventListener('kern:nur-lesen', nl);
    return () => removeEventListener('kern:nur-lesen', nl);
  }, [ich.id]);
  const leseModus = nurLesen || (!!konto && ['test_abgelaufen', 'nur_lesen', 'umzug_laeuft'].includes(konto.status));

  // Fokus nach Seitenwechsel auf die Überschrift (Screenreader hören den neuen Titel)
  useEffect(() => {
    setMehr(false);
    if (ersterLauf.current) {
      ersterLauf.current = false;
      return;
    }
    const t = setTimeout(() => {
      const h = document.getElementById('seitentitel');
      if (h && !hauptRef.current?.contains(document.activeElement)) h.focus({ preventScroll: true });
      window.scrollTo({ top: 0 });
    }, 30);
    return () => clearTimeout(t);
  }, [bereich, route.rest]);

  // Tastenkürzel
  useEffect(() => {
    const kuerzel = [...BEREICHE.map((b) => ({ folge: b.kuerzel })), { folge: '/' }, { folge: '?' }];
    const erk = new FolgenErkenner(kuerzel);
    const f = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setPalette((p) => !p);
        return;
      }
      if (e.metaKey || e.ctrlKey || e.altKey || istEingabe(e.target) || document.querySelector('dialog[open]')) return;
      const treffer = erk.taste(e.key);
      if (!treffer) return;
      e.preventDefault();
      if (treffer === '/') {
        if (bereich !== 'fragen') geheZu('fragen');
        setTimeout(() => (document.getElementById('frage-eingabe') as HTMLTextAreaElement | null)?.focus(), 60);
      } else if (treffer === '?') setHilfe(true);
      else {
        const b = BEREICHE.find((x) => x.kuerzel === treffer);
        if (b) geheZu(b.id);
      }
    };
    addEventListener('keydown', f);
    return () => removeEventListener('keydown', f);
  }, [bereich]);

  const sichtbar = BEREICHE;

  const seite = (() => {
    switch (bereich) {
      case 'fragen':
        return <Fragen route={route} />;
      case 'wissen':
        return <Wissen route={route} />;
      case 'fakten':
        return <Fakten route={route} />;
      case 'dokumente':
        return <Dokumente route={route} />;
      case 'hinzufuegen':
        return <Hinzufuegen route={route} />;
      case 'eingang':
        return <Eingang route={route} />;
      case 'heute':
        return <Heute />;
      case 'briefing':
        return <Briefing />;
      case 'einstellungen':
        return <Einstellungen route={route} />;
      case 'start':
        return <ErsteSchritte />;
      case 'fundstelle':
        return <FundstelleSeite route={route} />;
      default:
        return (
          <div class="seite">
            <h1 id="seitentitel" tabIndex={-1}>
              Diese Seite gibt es nicht
            </h1>
            <p>
              <a href="#/fragen">Zurück zu Fragen</a>
            </p>
          </div>
        );
    }
  })();

  const zaehler = (id: string) =>
    id === 'eingang' && offen > 0 ? (
      <span class="zaehler" aria-label={`${offen} offen`}>
        {offen}
      </span>
    ) : null;

  const aktiv = (id: string) => bereich === id || (bereich === 'fundstelle' && id === 'wissen') || (bereich === 'briefing' && id === 'heute');

  return (
    <div class="rahmen">
      <a href="#hauptinhalt" class="sprungmarke" onClick={(e) => {
        e.preventDefault();
        document.getElementById('seitentitel')?.focus();
      }}>
        Zum Inhalt springen
      </a>

      {/* Seitenleiste ab Tablet quer */}
      <aside class="leiste" aria-label="Hauptnavigation">
        <Marke betrieb={betrieb} />
        <button type="button" class="suchfeld-knopf" onClick={() => setPalette(true)}>
          <Icon name="suche" groesse={18} />
          <span>Suchen</span>
          <span class="tasten">
            <Taste>{mac ? '⌘' : 'Strg'}</Taste>
            <Taste>K</Taste>
          </span>
        </button>
        <nav aria-label="Bereiche">
          <ul class="leiste-liste">
            {sichtbar.map((b) => (
              <li key={b.id}>
                <a href={`#/${b.id}`} class={`leiste-link${aktiv(b.id) ? ' aktiv' : ''}`} aria-current={aktiv(b.id) ? 'page' : undefined}>
                  <Icon name={b.icon} />
                  <span>{b.text}</span>
                  {zaehler(b.id)}
                </a>
              </li>
            ))}
          </ul>
        </nav>
        <div class="leiste-fuss">
          <a href="#/einstellungen/wissen" class="leiste-export">
            <Icon name="herunterladen" groesse={16} /> Wissen exportieren
          </a>
          {MOCK && (
            <p class="demo-plakette">
              <Icon name="info" groesse={16} /> Demo mit erfundenen Daten
            </p>
          )}
          <div class="ich">
            <span class="avatar" aria-hidden="true">
              {initialen(ich.name)}
            </span>
            <span class="ich-text">
              <span class="ich-name">{ich.name}</span>
              <span class="ich-rolle">{darf.verwalten(ich) ? 'Admin' : darf.freigeben(ich) ? 'Freigeber' : darf.vorschlagen(ich) ? 'Autor' : 'Leser'}</span>
            </span>
            <button type="button" class="symbol-knopf" onClick={() => setHilfe(true)} aria-label="Tastenkürzel anzeigen">
              <Icon name="tastatur" groesse={18} />
            </button>
            <button type="button" class="symbol-knopf" onClick={abmelden} aria-label="Abmelden">
              <Icon name="abmelden" groesse={18} />
            </button>
          </div>
          <p class="quelltext-fuss">
            <QuelltextLink />
          </p>
        </div>
      </aside>

      {/* Kopfzeile mobil */}
      <header class="kopf-mobil">
        <Marke betrieb={betrieb} />
        <button type="button" class="symbol-knopf symbol-knopf--gross" onClick={() => setPalette(true)} aria-label="Suchen oder springen">
          <Icon name="suche" groesse={22} />
        </button>
      </header>

      <main id="hauptinhalt" class="haupt" ref={hauptRef}>
        {leseModus ? <NurLesenLeiste k={konto} /> : konto && <TestphaseLeiste k={konto} />}
        {seite}
      </main>

      {/* Leiste unten mobil */}
      <nav class="unten" aria-label="Bereiche">
        <ul>
          {MOBIL_UNTEN.map((id) => {
            const b = BEREICHE.find((x) => x.id === id)!;
            return (
              <li key={id}>
                <a href={`#/${id}`} class={`unten-link${aktiv(id) ? ' aktiv' : ''}`} aria-current={aktiv(id) ? 'page' : undefined}>
                  <span class="unten-icon">
                    <Icon name={b.icon} groesse={22} />
                    {zaehler(id)}
                  </span>
                  <span>{b.text}</span>
                </a>
              </li>
            );
          })}
          <li>
            <button
              type="button"
              class={`unten-link${['wissen', 'fakten', 'dokumente', 'einstellungen'].includes(bereich) ? ' aktiv' : ''}`}
              aria-expanded={mehr}
              aria-controls="mehr-blatt"
              onClick={() => setMehr((m) => !m)}
            >
              <span class="unten-icon">
                <Icon name="menue" groesse={22} />
              </span>
              <span>Mehr</span>
            </button>
          </li>
        </ul>
      </nav>

      <Dialog offen={mehr} schliessen={() => setMehr(false)} titel="Mehr">
        <ul class="mehr-liste" id="mehr-blatt">
          {BEREICHE.filter((b) => !MOBIL_UNTEN.includes(b.id)).map((b) => (
            <li key={b.id}>
              <a href={`#/${b.id}`} class="mehr-link" onClick={() => setMehr(false)}>
                <Icon name={b.icon} />
                <span>
                  <span class="mehr-titel">{b.text}</span>
                  <span class="mehr-beschreibung">{b.beschreibung}</span>
                </span>
              </a>
            </li>
          ))}
        </ul>
        <a href="#/einstellungen/wissen" class="mehr-link" onClick={() => setMehr(false)}>
          <Icon name="herunterladen" />
          <span>
            <span class="mehr-titel">Wissen exportieren</span>
            <span class="mehr-beschreibung">Jederzeit, vollständig, offenes Format</span>
          </span>
        </a>
        <p class="quelltext-fuss">
          <QuelltextLink />
        </p>
        <div class="mehr-ich">
          <span>
            Angemeldet als <strong>{ich.name}</strong>
          </span>
          <button type="button" class="knopf knopf--leise knopf--klein" onClick={abmelden}>
            <Icon name="abmelden" groesse={18} /> <span>Abmelden</span>
          </button>
        </div>
      </Dialog>

      <Befehlspalette offen={palette} schliessen={() => setPalette(false)} />

      <Dialog offen={hilfe} schliessen={() => setHilfe(false)} titel="Tastenkürzel">
        <dl class="kuerzel-liste">
          <div>
            <dt>
              <Taste>{mac ? '⌘' : 'Strg'}</Taste> <Taste>K</Taste>
            </dt>
            <dd>Suchen und springen</dd>
          </div>
          <div>
            <dt>
              <Taste>/</Taste>
            </dt>
            <dd>Neue Frage stellen</dd>
          </div>
          {BEREICHE.map((b) => (
            <div key={b.id}>
              <dt>
                {b.kuerzel.split(' ').map((k) => (
                  <Taste key={k}>{k}</Taste>
                ))}
              </dt>
              <dd>Zu {b.text}</dd>
            </div>
          ))}
          <div>
            <dt>
              <Taste>?</Taste>
            </dt>
            <dd>Diese Hilfe</dd>
          </div>
          <div>
            <dt>
              <Taste>Esc</Taste>
            </dt>
            <dd>Fenster schließen</dd>
          </div>
        </dl>
        <p class="klein-text">Die Kürzel wirken nicht, solange du in einem Eingabefeld schreibst.</p>
      </Dialog>
    </div>
  );
}
