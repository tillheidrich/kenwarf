import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { useApp } from '../kontext';
import { BEREICHE } from '../app';
import { filtere } from '../lib/finden';
import { geheZu } from '../lib/router';
import { artikelRoute } from '../lib/pfade';
import { Icon, type IconName } from './Icon';
import { Taste } from './teile';

interface Eintrag {
  id: string;
  gruppe: 'Frage' | 'Bereiche' | 'Artikel' | 'Aktionen';
  titel: string;
  unter?: string;
  icon: IconName;
  kuerzel?: string;
  los: () => void;
}

export function Befehlspalette({ offen, schliessen }: { offen: boolean; schliessen: () => void }) {
  const { artikelListe } = useApp();
  const ref = useRef<HTMLDialogElement>(null);
  const eingabe = useRef<HTMLInputElement>(null);
  const [q, setQ] = useState('');
  const [aktivIdx, setAktiv] = useState(0);

  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (offen && !d.open) {
      setQ('');
      setAktiv(0);
      d.showModal();
      setTimeout(() => eingabe.current?.focus(), 10);
    }
    if (!offen && d.open) d.close();
  }, [offen]);

  const eintraege = useMemo<Eintrag[]>(() => {
    const basis: Eintrag[] = [
      ...BEREICHE.map((b) => ({ id: `b-${b.id}`, gruppe: 'Bereiche' as const, titel: b.text, unter: b.beschreibung, icon: b.icon, kuerzel: b.kuerzel, los: () => geheZu(b.id) })),
      { id: 'a-datei', gruppe: 'Aktionen', titel: 'Datei hinzufügen', icon: 'hochladen', los: () => geheZu('hinzufuegen', { art: 'datei' }) },
      { id: 'a-text', gruppe: 'Aktionen', titel: 'Text oder Notiz hinzufügen', icon: 'text', los: () => geheZu('hinzufuegen', { art: 'text' }) },
      { id: 'a-web', gruppe: 'Aktionen', titel: 'Webseite hinzufügen und beobachten', icon: 'web', los: () => geheZu('hinzufuegen', { art: 'web' }) },
      { id: 'a-sprache', gruppe: 'Aktionen', titel: 'Sprachnotiz aufnehmen', icon: 'mikro', los: () => geheZu('hinzufuegen', { art: 'audio' }) },
      { id: 'a-faellig', gruppe: 'Aktionen', titel: 'Fällige Artikel zeigen', icon: 'uhr', los: () => geheZu('wissen', { filter: 'faellig' }) },
      { id: 'a-mcp', gruppe: 'Aktionen', titel: 'Zugang für KI-Werkzeuge (MCP)', icon: 'schloss', los: () => geheZu('einstellungen/zugang') },
      ...artikelListe.map((a) => ({
        id: `w-${a.pfad}`,
        gruppe: 'Artikel' as const,
        titel: a.kopf.titel,
        unter: a.kopf.gruppe,
        icon: 'wissen' as IconName,
        los: () => geheZu(artikelRoute(a.pfad)),
      })),
    ];
    const gefiltert = q.trim() ? filtere(basis, q, (e) => `${e.titel} ${e.unter ?? ''}`).slice(0, 12) : basis.filter((e) => e.gruppe !== 'Artikel');
    if (q.trim().length > 2)
      gefiltert[gefiltert.length && gefiltert[0].gruppe === 'Artikel' ? 'push' : 'unshift']({ id: 'frage', gruppe: 'Frage', titel: `„${q.trim()}“ fragen`, unter: 'Antwort mit Belegen aus eurem Wissen', icon: 'fragen', los: () => geheZu('fragen', { q: q.trim() }) });
    return gefiltert;
  }, [q, artikelListe]);

  useEffect(() => setAktiv(0), [q]);
  useEffect(() => {
    document.getElementById(`pe-${aktivIdx}`)?.scrollIntoView({ block: 'nearest' });
  }, [aktivIdx]);

  const waehle = (e: Eintrag) => {
    schliessen();
    setTimeout(e.los, 0);
  };

  const taste = (ev: KeyboardEvent) => {
    if (ev.key === 'ArrowDown') {
      ev.preventDefault();
      setAktiv((i) => Math.min(i + 1, eintraege.length - 1));
    } else if (ev.key === 'ArrowUp') {
      ev.preventDefault();
      setAktiv((i) => Math.max(i - 1, 0));
    } else if (ev.key === 'Enter') {
      ev.preventDefault();
      const e = eintraege[aktivIdx];
      if (e) waehle(e);
    }
  };

  let letzteGruppe = '';
  return (
    <dialog
      ref={ref}
      class="palette"
      aria-label="Suchen und springen"
      onClose={schliessen}
      onCancel={(e) => {
        e.preventDefault();
        schliessen();
      }}
      onClick={(e) => {
        if (e.target === ref.current) schliessen();
      }}
    >
      <div class="palette-innen">
        <div class="palette-eingabe">
          <Icon name="suche" />
          <input
            ref={eingabe}
            type="text"
            role="combobox"
            aria-expanded="true"
            aria-controls="palette-liste"
            aria-activedescendant={eintraege.length ? `pe-${aktivIdx}` : undefined}
            aria-autocomplete="list"
            aria-label="Suchbegriff oder Frage"
            placeholder="Artikel, Bereich oder Frage …"
            value={q}
            onInput={(e) => setQ((e.target as HTMLInputElement).value)}
            onKeyDown={taste}
            autocomplete="off"
            spellcheck={false}
          />
          <Taste>Esc</Taste>
        </div>
        <ul id="palette-liste" role="listbox" class="palette-liste" aria-label="Treffer">
          {eintraege.map((e, i) => {
            const kopf = e.gruppe !== letzteGruppe ? e.gruppe : null;
            letzteGruppe = e.gruppe;
            return (
              <li
                key={e.id}
                id={`pe-${i}`}
                role="option"
                aria-selected={i === aktivIdx}
                class={`palette-eintrag${i === aktivIdx ? ' aktiv' : ''}`}
                data-gruppe={kopf ?? undefined}
                onMouseMove={() => setAktiv(i)}
                onClick={() => waehle(e)}
              >
                <Icon name={e.icon} groesse={18} />
                <span class="palette-text">
                  <span class="palette-titel">{e.titel}</span>
                  {e.unter && <span class="palette-unter">{e.unter}</span>}
                </span>
                {e.kuerzel && (
                  <span class="palette-kuerzel" aria-hidden="true">
                    {e.kuerzel.split(' ').map((k) => (
                      <Taste key={k}>{k}</Taste>
                    ))}
                  </span>
                )}
              </li>
            );
          })}
          {!eintraege.length && <li class="palette-leer">Nichts gefunden. Schreib mindestens drei Buchstaben, dann kannst du es direkt als Frage stellen.</li>}
        </ul>
        <p class="palette-fuss" aria-hidden="true">
          <Taste>↑</Taste> <Taste>↓</Taste> auswählen · <Taste>Enter</Taste> öffnen
        </p>
      </div>
    </dialog>
  );
}
