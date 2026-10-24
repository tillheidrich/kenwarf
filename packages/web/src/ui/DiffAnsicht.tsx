import { useMemo, useState } from 'preact/hooks';
import { klappeEin, wortDiff, zaehle, type Stueck } from '../lib/diff';
import { Segment } from './teile';

function StueckText({ s, seite }: { s: Stueck; seite?: 'alt' | 'neu' }) {
  if (s.art === 'gleich') return <span>{s.text}</span>;
  if (s.art === 'entfernt') {
    if (seite === 'neu') return null;
    return (
      <del class="diff-weg">
        <span class="sr-only">[entfernt: </span>
        {s.text}
        <span class="sr-only">]</span>
      </del>
    );
  }
  if (seite === 'alt') return null;
  return (
    <ins class="diff-neu">
      <span class="sr-only">[neu: </span>
      {s.text}
      <span class="sr-only">]</span>
    </ins>
  );
}

/** Vergleich alt/neu, wortgenau. „entfernt“ und „neu“ stehen als Wort dabei, nicht nur als Farbe. */
export function DiffAnsicht({ alt, neu, titelAlt = 'Bisher', titelNeu = 'Vorschlag' }: { alt: string; neu: string; titelAlt?: string; titelNeu?: string }) {
  const [modus, setModus] = useState<'text' | 'neben'>('text');
  const [offen, setOffen] = useState<Set<number>>(new Set());
  const stuecke = useMemo(() => wortDiff(alt, neu), [alt, neu]);
  const bloecke = useMemo(() => klappeEin(stuecke, 2), [stuecke]);
  const z = zaehle(stuecke);

  const zeige = (seite?: 'alt' | 'neu') =>
    bloecke.map((b, i) =>
      b.art === 'ausgelassen' && !offen.has(i) ? (
        <button key={i} type="button" class="diff-ausgelassen" onClick={() => setOffen(new Set([...offen, i]))}>
          {b.zeilen} unveränderte {b.zeilen === 1 ? 'Zeile' : 'Zeilen'} zeigen
        </button>
      ) : b.art === 'ausgelassen' ? (
        <span key={i}>{b.text}</span>
      ) : (
        b.stuecke.map((s, j) => <StueckText key={`${i}-${j}`} s={s} seite={seite} />)
      ),
    );

  return (
    <div class="diff">
      <div class="diff-kopf">
        <p class="diff-legende">
          <span class="diff-zahl diff-zahl--weg">
            <del class="diff-weg">entfernt</del> {z.entfernt} {z.entfernt === 1 ? 'Wort' : 'Wörter'}
          </span>
          <span class="diff-zahl diff-zahl--neu">
            <ins class="diff-neu">neu</ins> {z.neu} {z.neu === 1 ? 'Wort' : 'Wörter'}
          </span>
        </p>
        <Segment
          name={`diff-modus-${alt.length}-${neu.length}`}
          legende="Ansicht"
          versteckteLegende
          klasse="segment--klein"
          wert={modus}
          aendern={setModus}
          optionen={[
            { wert: 'text', text: 'Im Text' },
            { wert: 'neben', text: 'Nebeneinander' },
          ]}
        />
      </div>
      {modus === 'text' ? (
        <pre class="diff-text" tabIndex={0} aria-label="Vergleich im Text">
          {zeige()}
        </pre>
      ) : (
        <div class="diff-neben">
          <section aria-label={titelAlt}>
            <p class="diff-spalte-titel">{titelAlt}</p>
            <pre class="diff-text" tabIndex={0}>
              {alt ? zeige('alt') : <span class="leise">(gibt es noch nicht)</span>}
            </pre>
          </section>
          <section aria-label={titelNeu}>
            <p class="diff-spalte-titel">{titelNeu}</p>
            <pre class="diff-text" tabIndex={0}>
              {neu ? zeige('neu') : <span class="leise">(wird gelöscht)</span>}
            </pre>
          </section>
        </div>
      )}
    </div>
  );
}
