/** Bausteine der Konsole (serverseitig gerendert mit hono/jsx, ohne Client-Framework). */
import type { Child } from 'hono/jsx';
import type { Instanz, InstanzStatus } from '../typen.js';
import { PRODUKTNAME, STATUS_TEXT } from '../typen.js';

export const fmt = {
  datum: (iso: string | null | undefined) => (iso ? new Date(iso).toLocaleDateString('de-DE', { timeZone: 'Europe/Berlin', day: '2-digit', month: '2-digit', year: 'numeric' }) : '–'),
  zeit: (iso: string | null | undefined) => (iso ? new Date(iso).toLocaleString('de-DE', { timeZone: 'Europe/Berlin', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : '–'),
  bytes: (n: number) => (n < 1024 ? `${n} B` : n < 1024 ** 2 ? `${(n / 1024).toFixed(1).replace('.', ',')} KB` : n < 1024 ** 3 ? `${(n / 1024 ** 2).toFixed(1).replace('.', ',')} MB` : `${(n / 1024 ** 3).toFixed(2).replace('.', ',')} GB`),
  euro: (cent: number) => `${(cent / 100).toLocaleString('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} €`,
  tage: (n: number | null) => (n === null ? '–' : n <= 0 ? 'heute' : n === 1 ? '1 Tag' : `${n} Tage`),
};

const TON: Record<InstanzStatus, 'gut' | 'neutral' | 'warn' | 'schlecht' | 'still'> = {
  angelegt: 'neutral', test: 'neutral', demo: 'neutral', aktiv: 'gut', zahlung_offen: 'warn', test_abgelaufen: 'warn', nur_lesen: 'warn',
  pausiert: 'still', umzug_laeuft: 'neutral', wechsel_laeuft: 'neutral', umgezogen: 'still', loeschung_geplant: 'schlecht', geloescht: 'still', fehler: 'schlecht',
};

export function StatusMarke({ s }: { s: InstanzStatus }) {
  return <span class={`marke marke--${TON[s]}`}><span class="marke-punkt" aria-hidden="true"></span>{STATUS_TEXT[s]}</span>;
}

/** Signatur der Konsole: das Gleis. Zeigt, wo eine Instanz in ihrem Lebenslauf steht und was als Nächstes kommt. */
export function Gleis({ i }: { i: Instanz }) {
  const pfad: { key: string; text: string; an: InstanzStatus[] }[] =
    i.herkunft.art === 'pitch' && (i.status === 'demo' || i.status === 'geloescht' || i.status === 'loeschung_geplant')
      ? [
          { key: 'angelegt', text: 'Angelegt', an: ['angelegt', 'fehler'] },
          { key: 'demo', text: 'Pitch läuft', an: ['demo', 'pausiert'] },
          { key: 'aufraeumen', text: 'Aufräumen', an: ['loeschung_geplant'] },
          { key: 'weg', text: 'Gelöscht', an: ['geloescht'] },
        ]
      : [
          { key: 'angelegt', text: 'Angelegt', an: ['angelegt', 'fehler'] },
          { key: 'test', text: 'Test', an: ['test', 'test_abgelaufen'] },
          { key: 'aktiv', text: 'Kunde', an: ['aktiv', 'zahlung_offen', 'nur_lesen', 'pausiert', 'wechsel_laeuft'] },
          { key: 'umzug', text: 'Umzug', an: ['umzug_laeuft', 'umgezogen'] },
          { key: 'ende', text: 'Ende', an: ['loeschung_geplant', 'geloescht'] },
        ];
  const pos = Math.max(0, pfad.findIndex((p) => p.an.includes(i.status === 'pausiert' && i.vorher ? i.vorher : i.status)));
  return (
    <ol class="gleis" aria-label="Lebenslauf der Instanz">
      {pfad.map((p, n) => (
        <li class={`gleis-halt ${n < pos ? 'ist-vorbei' : n === pos ? 'ist-jetzt' : ''}`} aria-current={n === pos ? 'step' : undefined}>
          <span class="gleis-punkt" aria-hidden="true"></span>
          <span class="gleis-text">{p.text}</span>
        </li>
      ))}
    </ol>
  );
}

/** Auslastungsbalken eines Hosts (Anteil 0..1, Ampel aus regeln.auslastungStufe). */
export function Balken({ anteil, ampel, label }: { anteil: number; ampel: 'ok' | 'warnung' | 'voll'; label: string }) {
  const pz = Math.min(100, Math.round(anteil * 100));
  return (
    <div class={`balken balken--${ampel}`} role="meter" aria-label={label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={pz}>
      <svg viewBox="0 0 100 6" preserveAspectRatio="none" aria-hidden="true" focusable="false">
        <rect class="balken-grund" x="0" y="0" width="100" height="6" />
        <rect class="balken-fuellung" x="0" y="0" width={String(pz)} height="6" />
        <line class="balken-marke" x1="70" x2="70" y1="0" y2="6" />
      </svg>
    </div>
  );
}

export function StufeMarke({ s }: { s: 'geteilt' | 'eigen' }) {
  return <span class={`stufe stufe--${s}`}>{s === 'eigen' ? 'Eigene Maschine' : 'Geteilt'}</span>;
}

export interface SeitenKontext { pfad: string; admin: string; csrf: string; meldung?: string | null; fehler?: string | null }

const NAV = [
  ['/heute', 'Heute'], ['/instanzen', 'Instanzen'], ['/hosts', 'Hosts'], ['/kunden', 'Konten'], ['/partner', 'Partner'], ['/abrechnung', 'Abrechnung'], ['/protokoll', 'Protokoll'], ['/schalter', 'Schalter'], ['/sicherheit', 'Sicherheit'],
] as const;

export function Seite({ k, titel, children, aktion }: { k: SeitenKontext; titel: string; children: Child; aktion?: Child }) {
  return (
    <html lang="de">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <meta name="robots" content="noindex, nofollow" />
        <title>{`${titel} · Leitstand ${PRODUKTNAME}`}</title>
        <link rel="stylesheet" href="/_k/stil.css" />
        <meta name="leitstand-csrf" content={k.csrf} />
        <script src="/_k/konsole.js" defer></script>
        <script src="/_k/passkey.js" defer></script>
      </head>
      <body>
        <a class="sprung" href="#inhalt">Zum Inhalt</a>
        <div class="rahmen">
          <header class="leiste">
            <a class="zeichen" href="/heute" aria-label="Leitstand Startseite">
              <span class="zeichen-quadrat" aria-hidden="true"></span>
              <span class="zeichen-text"><b>Leitstand</b><span>{PRODUKTNAME} Managed</span></span>
            </a>
            <nav class="nav" aria-label="Bereiche">
              {NAV.map(([href, text]) => (
                <a href={href} class={k.pfad.startsWith(href) ? 'nav-link ist-aktiv' : 'nav-link'} aria-current={k.pfad.startsWith(href) ? 'page' : undefined}>{text}</a>
              ))}
            </nav>
            <div class="leiste-fuss">
              <a class="knopf knopf--haupt knopf--voll" href="/instanzen/neu">Neue Instanz</a>
              <form method="post" action="/abmelden" class="abmelden">
                <input type="hidden" name="_csrf" value={k.csrf} />
                <span class="mono klein gedaempft">{k.admin}</span>
                <button class="link-knopf" type="submit">Abmelden</button>
              </form>
            </div>
          </header>
          <main id="inhalt" class="haupt">
            <div class="kopf">
              <h1>{titel}</h1>
              {aktion ? <div class="kopf-aktion">{aktion}</div> : null}
            </div>
            {k.meldung ? <p class="hinweis hinweis--gut" role="status">{k.meldung}</p> : null}
            {k.fehler ? <p class="hinweis hinweis--fehler" role="alert">{k.fehler}</p> : null}
            {children}
          </main>
        </div>
      </body>
    </html>
  );
}

export function Csrf({ k }: { k: SeitenKontext }) { return <input type="hidden" name="_csrf" value={k.csrf} />; }

export function Leer({ titel, text, link }: { titel: string; text: string; link?: { href: string; text: string } }) {
  return (
    <div class="leer">
      <p class="leer-titel">{titel}</p>
      <p class="leer-text">{text}</p>
      {link ? <a class="knopf" href={link.href}>{link.text}</a> : null}
    </div>
  );
}

export function Feld({ label, name, hilfe, children }: { label: string; name: string; hilfe?: string; children: Child }) {
  return (
    <div class="feld">
      <label for={name}>{label}</label>
      {children}
      {hilfe ? <p class="feld-hilfe" id={`${name}-hilfe`}>{hilfe}</p> : null}
    </div>
  );
}
