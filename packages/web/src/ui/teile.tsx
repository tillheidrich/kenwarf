import type { ComponentChildren, JSX } from 'preact';
import { useEffect, useId, useRef } from 'preact/hooks';
import { Icon, type IconName } from './Icon';
import type { Ampel } from '../lib/datum';

type KnopfArt = 'primaer' | 'sekundaer' | 'leise' | 'gefahr';

export function Knopf({
  art = 'sekundaer',
  icon,
  iconRechts,
  laedt,
  klein,
  children,
  klasse = '',
  ...rest
}: {
  art?: KnopfArt;
  icon?: IconName;
  iconRechts?: IconName;
  laedt?: boolean;
  klein?: boolean;
  klasse?: string;
  children?: ComponentChildren;
} & Omit<JSX.ButtonHTMLAttributes<HTMLButtonElement>, 'icon'>) {
  return (
    <button
      type="button"
      {...rest}
      class={`knopf knopf--${art}${klein ? ' knopf--klein' : ''}${laedt ? ' laedt' : ''} ${klasse}`}
      aria-busy={laedt ? 'true' : undefined}
      disabled={rest.disabled || laedt}
    >
      {icon && <Icon name={icon} groesse={18} />}
      {children && <span>{children}</span>}
      {iconRechts && (
        <span class="knopf-insel" aria-hidden="true">
          <Icon name={iconRechts} groesse={16} />
        </span>
      )}
    </button>
  );
}

export function KnopfLink({
  art = 'sekundaer',
  icon,
  iconRechts,
  klein,
  children,
  klasse = '',
  ...rest
}: { art?: KnopfArt; icon?: IconName; iconRechts?: IconName; klein?: boolean; klasse?: string; children?: ComponentChildren } & Omit<JSX.AnchorHTMLAttributes<HTMLAnchorElement>, 'icon'>) {
  return (
    <a {...rest} class={`knopf knopf--${art}${klein ? ' knopf--klein' : ''} ${klasse}`}>
      {icon && <Icon name={icon} groesse={18} />}
      {children && <span>{children}</span>}
      {iconRechts && (
        <span class="knopf-insel" aria-hidden="true">
          <Icon name={iconRechts} groesse={16} />
        </span>
      )}
    </a>
  );
}

/** Auswahl aus wenigen Werten als echte Radio-Gruppe (Tastatur und Screenreader ohne Zusatzarbeit). */
export function Segment<T extends string>({
  name,
  legende,
  wert,
  optionen,
  aendern,
  klasse = '',
  versteckteLegende,
}: {
  name: string;
  legende: string;
  wert: T;
  optionen: { wert: T; text: string; icon?: IconName; hinweis?: string }[];
  aendern: (w: T) => void;
  klasse?: string;
  versteckteLegende?: boolean;
}) {
  return (
    <fieldset class={`segment ${klasse}`}>
      <legend class={versteckteLegende ? 'sr-only' : 'feld-label'}>{legende}</legend>
      <div class="segment-reihe">
        {optionen.map((o) => (
          <label key={o.wert} class={`segment-option${o.wert === wert ? ' aktiv' : ''}`} title={o.hinweis}>
            <input type="radio" name={name} value={o.wert} checked={o.wert === wert} onChange={() => aendern(o.wert)} />
            {o.icon && <Icon name={o.icon} groesse={16} />}
            <span>{o.text}</span>
          </label>
        ))}
      </div>
    </fieldset>
  );
}

export function Feld({
  label,
  hilfe,
  fehler,
  children,
  id,
  pflicht,
}: {
  label: string;
  hilfe?: string;
  fehler?: string | null;
  children: (p: { id: string; 'aria-describedby'?: string; 'aria-invalid'?: 'true' | undefined }) => ComponentChildren;
  id?: string;
  pflicht?: boolean;
}) {
  const auto = useId();
  const fid = id ?? `f${auto}`;
  const hid = hilfe ? `${fid}-hilfe` : '';
  const eid = fehler ? `${fid}-fehler` : '';
  const beschr = [hid, eid].filter(Boolean).join(' ') || undefined;
  return (
    <div class={`feld${fehler ? ' feld--fehler' : ''}`}>
      <label class="feld-label" for={fid}>
        {label}
        {pflicht && <span class="feld-pflicht"> (Pflicht)</span>}
      </label>
      {children({ id: fid, 'aria-describedby': beschr, 'aria-invalid': fehler ? 'true' : undefined })}
      {hilfe && (
        <p class="feld-hilfe" id={hid}>
          {hilfe}
        </p>
      )}
      {fehler && (
        <p class="feld-fehler" id={eid}>
          <Icon name="warnung" groesse={16} /> {fehler}
        </p>
      )}
    </div>
  );
}

export function Leer({
  icon = 'info',
  titel,
  children,
  aktion,
}: {
  icon?: IconName;
  titel: string;
  children?: ComponentChildren;
  aktion?: ComponentChildren;
}) {
  return (
    <div class="leer">
      <div class="leer-zeichen" aria-hidden="true">
        <Icon name={icon} groesse={22} />
      </div>
      <h2 class="leer-titel">{titel}</h2>
      {children && <div class="leer-text">{children}</div>}
      {aktion && <div class="leer-aktion">{aktion}</div>}
    </div>
  );
}

export function Fehlerhinweis({ text, nochmal, titel = 'Das hat nicht geklappt.' }: { text: string; nochmal?: () => void; titel?: string }) {
  return (
    <div class="hinweis hinweis--fehler" role="alert">
      <Icon name="warnung" groesse={20} />
      <div>
        <p class="hinweis-titel">{titel}</p>
        <p>{text}</p>
      </div>
      {nochmal && (
        <Knopf klein onClick={nochmal} icon="verlauf">
          Nochmal
        </Knopf>
      )}
    </div>
  );
}

export function Hinweis({ icon = 'info', titel, children, art = 'info' }: { icon?: IconName; titel?: string; children?: ComponentChildren; art?: 'info' | 'warnung' }) {
  return (
    <div class={`hinweis hinweis--${art}`}>
      <Icon name={icon} groesse={20} />
      <div>
        {titel && <p class="hinweis-titel">{titel}</p>}
        {children}
      </div>
    </div>
  );
}

export function Skelett({ zeilen = 3, breit }: { zeilen?: number; breit?: boolean }) {
  return (
    <div class="skelett" aria-hidden="true">
      {Array.from({ length: zeilen }, (_, i) => (
        <span key={i} style={{ width: breit ? '100%' : `${92 - ((i * 17) % 38)}%` }} />
      ))}
    </div>
  );
}

export function Laedt({ text = 'Wird geladen' }: { text?: string }) {
  return (
    <div class="laedt-block" role="status">
      <span class="sr-only">{text} …</span>
      <Skelett zeilen={4} />
    </div>
  );
}

export function AmpelMarke({ ampel, kurz }: { ampel: Ampel; kurz?: boolean }) {
  return (
    <span class={`ampel ampel--${ampel.stufe}`} title={ampel.erklaerung}>
      <span class="ampel-punkt" aria-hidden="true" />
      <span>{ampel.wort}</span>
      {!kurz && ampel.erklaerung && <span class="sr-only">. {ampel.erklaerung}</span>}
    </span>
  );
}

export function Chip({ children, icon, art = '' }: { children: ComponentChildren; icon?: IconName; art?: string }) {
  return (
    <span class={`chip ${art ? `chip--${art}` : ''}`}>
      {icon && <Icon name={icon} groesse={14} />}
      {children}
    </span>
  );
}

/** Modaler Dialog über das native <dialog>: Fokusfalle, Escape und Hintergrund-Sperre gibt es vom Browser. */
export function Dialog({
  offen,
  schliessen,
  titel,
  children,
  fuss,
  breit,
  beschreibung,
}: {
  offen: boolean;
  schliessen: () => void;
  titel: string;
  children: ComponentChildren;
  fuss?: ComponentChildren;
  breit?: boolean;
  beschreibung?: string;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const tid = useId();
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (offen && !d.open) d.showModal();
    if (!offen && d.open) d.close();
  }, [offen]);
  return (
    <dialog
      ref={ref}
      class={`dialog${breit ? ' dialog--breit' : ''}`}
      aria-labelledby={`d${tid}`}
      onClose={schliessen}
      onCancel={(e) => {
        e.preventDefault();
        schliessen();
      }}
      onClick={(e) => {
        if (e.target === ref.current) schliessen();
      }}
    >
      <div class="dialog-innen">
        <header class="dialog-kopf">
          <h2 id={`d${tid}`}>{titel}</h2>
          <button type="button" class="symbol-knopf" onClick={schliessen} aria-label="Schließen">
            <Icon name="schliessen" />
          </button>
        </header>
        {beschreibung && <p class="dialog-beschreibung">{beschreibung}</p>}
        <div class="dialog-rumpf">{offen && children}</div>
        {fuss && <footer class="dialog-fuss">{fuss}</footer>}
      </div>
    </dialog>
  );
}

export function Seitenkopf({
  titel,
  unterzeile,
  aktion,
  oberzeile,
  ohneId,
}: {
  ohneId?: boolean;
  titel: string;
  unterzeile?: ComponentChildren;
  aktion?: ComponentChildren;
  oberzeile?: ComponentChildren;
}) {
  return (
    <header class="seitenkopf">
      <div class="seitenkopf-text">
        {oberzeile && <p class="oberzeile">{oberzeile}</p>}
        <h1 tabIndex={-1} id={ohneId ? undefined : 'seitentitel'}>
          {titel}
        </h1>
        {unterzeile && <p class="unterzeile">{unterzeile}</p>}
      </div>
      {aktion && <div class="seitenkopf-aktion">{aktion}</div>}
    </header>
  );
}

export function Taste({ children }: { children: ComponentChildren }) {
  return <kbd class="taste">{children}</kbd>;
}
