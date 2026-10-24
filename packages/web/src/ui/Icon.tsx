// Eigene Linien-Icons (24er Raster, 1,5 px Strich). Keine Icon-Bibliothek nötig.

const PFADE: Record<string, string> = {
  fragen: 'M4.5 6.5a2 2 0 0 1 2-2h11a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H11l-4.5 3.5V16.5h0a2 2 0 0 1-2-2z M9.5 9.2a2.5 2.5 0 1 1 3.2 2.4c-.5.2-.7.6-.7 1.1v.3 M12 15h.01',
  wissen: 'M4 5.5c2.7-1 5.3-1 8 .8 2.7-1.8 5.3-1.8 8-.8V19c-2.7-1-5.3-1-8 .8-2.7-1.8-5.3-1.8-8-.8z M12 6.3v13.5',
  fakten: 'M4 5h16v14H4z M4 10h16 M4 14.5h16 M10 10v9',
  dokumente: 'M7 3.5h6.5L18 8v12.5H7z M13.5 3.5V8H18 M9.5 12.5h6 M9.5 16h4',
  hinzufuegen: 'M12 5v14 M5 12h14',
  eingang: 'M4 13.5 6.5 5h11l2.5 8.5V19H4z M4 13.5h4.5l1 2h5l1-2H20',
  heute: 'M12 8.5a3.5 3.5 0 1 0 0 7 3.5 3.5 0 0 0 0-7z M12 3v2 M12 19v2 M3 12h2 M19 12h2 M5.6 5.6 7 7 M17 17l1.4 1.4 M5.6 18.4 7 17 M17 7l1.4-1.4',
  briefing: 'M5 4.5h14v15H5z M8 8.5h8 M8 12h8 M8 15.5h5',
  einstellungen:
    'M12 9.2a2.8 2.8 0 1 0 0 5.6 2.8 2.8 0 0 0 0-5.6z M19 12a7 7 0 0 0-.1-1.2l2-1.5-2-3.4-2.3.9a7 7 0 0 0-2-1.2L14.3 3h-4l-.4 2.6a7 7 0 0 0-2 1.2l-2.3-.9-2 3.4 2 1.5a7 7 0 0 0 0 2.4l-2 1.5 2 3.4 2.3-.9a7 7 0 0 0 2 1.2l.4 2.6h4l.4-2.6a7 7 0 0 0 2-1.2l2.3.9 2-3.4-2-1.5c.1-.4.1-.8.1-1.2z',
  suche: 'M10.5 4.5a6 6 0 1 0 0 12 6 6 0 0 0 0-12z M15 15l4.5 4.5',
  pfeil: 'M5 12h13 M13 7l5 5-5 5',
  zurueck: 'M19 12H6 M11 7l-5 5 5 5',
  extern: 'M8 16 16.5 7.5 M9.5 7.5h7v7',
  schliessen: 'M6 6l12 12 M18 6 6 18',
  menue: 'M4 7h16 M4 12h16 M4 17h16',
  mehr: 'M5.5 12h.01 M12 12h.01 M18.5 12h.01',
  mikro: 'M12 3.5a2.5 2.5 0 0 0-2.5 2.5v6a2.5 2.5 0 0 0 5 0V6A2.5 2.5 0 0 0 12 3.5z M6.5 11.5a5.5 5.5 0 0 0 11 0 M12 17v3.5',
  stopp: 'M7 7h10v10H7z',
  hochladen: 'M12 15.5V4.5 M7.5 9 12 4.5 16.5 9 M5 15v4.5h14V15',
  herunterladen: 'M12 4.5v11 M7.5 11l4.5 4.5 4.5-4.5 M5 19.5h14',
  web: 'M12 3.5a8.5 8.5 0 1 0 0 17 8.5 8.5 0 0 0 0-17z M3.5 12h17 M12 3.5c2.3 2.4 3.4 5.2 3.4 8.5s-1.1 6.1-3.4 8.5c-2.3-2.4-3.4-5.2-3.4-8.5S9.7 5.9 12 3.5z',
  text: 'M6 6.5V5h12v1.5 M12 5v14 M9.5 19h5',
  haken: 'M5 12.5l4.5 4.5L19 7.5',
  kreuz: 'M7 7l10 10 M17 7 7 17',
  kopieren: 'M9 9h10.5v10.5H9z M15 9V4.5H4.5V15H9',
  uhr: 'M12 4a8 8 0 1 0 0 16 8 8 0 0 0 0-16z M12 8v4.5l3 2',
  person: 'M12 4.5a3.5 3.5 0 1 0 0 7 3.5 3.5 0 0 0 0-7z M5 19.5c.8-3.3 3.6-5 7-5s6.2 1.7 7 5',
  team: 'M9 5.5a3 3 0 1 0 0 6 3 3 0 0 0 0-6z M3.5 18.5c.6-2.8 2.7-4.3 5.5-4.3s4.9 1.5 5.5 4.3 M16 6a2.6 2.6 0 0 1 0 5.2 M17 14.4c2 .4 3.2 1.8 3.6 4.1',
  betrieb: 'M4 20V9l5 3V9l5 3V5h6v15z M4 20h16 M15 15h2 M8 16h2',
  schloss: 'M6.5 11h11v8.5h-11z M8.5 11V8a3.5 3.5 0 0 1 7 0v3',
  auge: 'M2.5 12s3.5-6.5 9.5-6.5S21.5 12 21.5 12s-3.5 6.5-9.5 6.5S2.5 12 2.5 12z M12 9.5a2.5 2.5 0 1 0 0 5 2.5 2.5 0 0 0 0-5z',
  stift: 'M5 19l1-4.5L15.5 5 19 8.5 9.5 18z M13.5 7l3.5 3.5',
  verlauf: 'M4.5 12a7.5 7.5 0 1 0 2.2-5.3L4.5 9 M4.5 4.5V9H9 M12 8v4.5l3 1.5',
  warnung: 'M12 4 21 19.5H3z M12 10v4 M12 17h.01',
  info: 'M12 3.5a8.5 8.5 0 1 0 0 17 8.5 8.5 0 0 0 0-17z M12 11v5.5 M12 7.8h.01',
  abmelden: 'M14 4.5H5.5v15H14 M10 12h10 M16.5 8.5 20 12l-3.5 3.5',
  schild: 'M12 3.5 19 6v5.5c0 4.3-3 7.6-7 9-4-1.4-7-4.7-7-9V6z M9 12l2 2 4-4',
  filter: 'M4 6h16 M7 12h10 M10 18h4',
  ordner: 'M3.5 6.5h6l2 2h9v10.5h-17z',
  stern: 'M12 4l2.4 5 5.3.6-3.9 3.7 1 5.3L12 16l-4.8 2.6 1-5.3-3.9-3.7 5.3-.6z',
  tastatur: 'M3.5 7h17v10h-17z M7 10.5h.01 M10 10.5h.01 M13 10.5h.01 M16 10.5h.01 M8 14h8',
  pfeilRunter: 'M7 10l5 5 5-5',
  pfeilRechts: 'M10 7l5 5-5 5',
  neu: 'M12 4.5v15 M4.5 12h15',
  lampe: 'M9 18h6 M10 21h4 M12 3.5a6 6 0 0 0-3.5 10.9c.6.5 1 1.2 1 2V17h5v-.6c0-.8.4-1.5 1-2A6 6 0 0 0 12 3.5z',
};

export type IconName = keyof typeof PFADE | string;

export function Icon({ name, groesse = 20, klasse = '' }: { name: IconName; groesse?: number; klasse?: string }) {
  const d = PFADE[name] ?? PFADE.info;
  return (
    <svg
      class={`icon ${klasse}`}
      width={groesse}
      height={groesse}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="1.5"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {d.split(' M').map((p, i) => (
        <path key={i} d={i === 0 ? p : 'M' + p} />
      ))}
    </svg>
  );
}
