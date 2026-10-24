import { useEffect, useMemo, useRef } from 'preact/hooks';
import { api } from '../api';
import { useLaden } from '../lib/laden';
import { href, type Route } from '../lib/router';
import { findeBereich, zeilenText } from '../lib/fundstelle';
import { artikelRoute, bereichVon, dokumentRoute } from '../lib/pfade';
import { Icon } from '../ui/Icon';
import { Chip, Fehlerhinweis, KnopfLink, Laedt, Seitenkopf } from '../ui/teile';

/** Zeigt den Text einer Fundstelle mit Zeilennummern und markiert den belegten Bereich. */
export function FundstelleSeite({ route }: { route: Route }) {
  const pfad = route.query.get('pfad') ?? '';
  const von = Number(route.query.get('von') ?? 0);
  const bis = Number(route.query.get('bis') ?? von);
  const zitat = route.query.get('zitat') ?? undefined;
  const abschnitt = route.query.get('abschnitt') ?? '';
  const art = bereichVon(pfad);
  const r = useLaden(async () => {
    if (!pfad) throw new Error('Es fehlt die Angabe, welche Fundstelle gezeigt werden soll.');
    if (art === 'quellen') {
      const q = await api.quelle(pfad);
      return { titel: q.kopf.titel, text: q.text, unter: q.kopf.sammlung };
    }
    const a = await api.artikel(pfad);
    return { titel: a.kopf.titel, text: a.text, unter: a.kopf.gruppe };
  }, [pfad]);

  const bereich = useMemo(() => (r.daten ? findeBereich(r.daten.text, zitat, von ? [von, bis] : undefined) : null), [r.daten, zitat, von, bis]);
  const markRef = useRef<HTMLLIElement>(null);
  useEffect(() => {
    if (bereich?.von) setTimeout(() => markRef.current?.scrollIntoView({ block: 'center' }), 50);
  }, [bereich?.von]);

  const zurueck = (
    <button type="button" class="zurueck-link" onClick={() => history.back()}>
      <Icon name="zurueck" groesse={18} /> Zurück
    </button>
  );

  if (r.laedt)
    return (
      <div class="seite seite--schmal">
        {zurueck}
        <Laedt text="Fundstelle wird geladen" />
      </div>
    );
  if (r.fehler || !r.daten)
    return (
      <div class="seite seite--schmal">
        {zurueck}
        <Seitenkopf titel="Fundstelle nicht gefunden" />
        <Fehlerhinweis text={r.fehler ?? ''} nochmal={r.status === 404 ? undefined : r.neu} />
        <p class="klein-text">
          Vielleicht wurde die Datei umbenannt oder gelöscht. Ein Prüflauf findet solche kaputten Fundstellen.
        </p>
      </div>
    );

  const zeilen = r.daten.text.split('\n');
  const b = bereich!;
  const gefunden = b.quelle !== 'keine';
  return (
    <div class="seite seite--schmal">
      {zurueck}
      <Seitenkopf
        oberzeile={
          <>
            {art === 'quellen' ? 'Dokument' : 'Wissen'} · {r.daten.unter}
          </>
        }
        titel={r.daten.titel}
        unterzeile={abschnitt ? `Abschnitt „${abschnitt}“` : undefined}
        aktion={
          <KnopfLink href={href(art === 'quellen' ? dokumentRoute(pfad) : artikelRoute(pfad))} iconRechts="pfeil">
            {art === 'quellen' ? 'Ganzes Dokument' : 'Ganzer Artikel'}
          </KnopfLink>
        }
      />
      <div class="chip-reihe">
        {gefunden ? (
          <Chip icon="haken" art="ok">
            {zeilenText([b.von, b.bis])} {b.quelle === 'zitat' ? 'wörtlich gefunden' : 'laut Zeilenangabe'}
          </Chip>
        ) : (
          <Chip icon="warnung" art="warn">
            Stelle nicht gefunden
          </Chip>
        )}
        <Chip>
          <span class="mono">{pfad}</span>
        </Chip>
      </div>
      {!gefunden && (
        <p class="hinweis hinweis--warnung">
          <Icon name="warnung" groesse={20} />
          <span>Das Zitat steht nicht mehr so im Text. Vielleicht wurde die Datei inzwischen geändert. Der ganze Text steht unten.</span>
        </p>
      )}
      {b.quelle === 'zeilen' && zitat && (
        <p class="klein-text">Das Zitat steht nicht wörtlich im Text. Markiert sind die angegebenen Zeilen.</p>
      )}
      <figure class="quelltext-rahmen">
        <figcaption class="sr-only">
          Text von {r.daten.titel}. {gefunden ? `Belegt: ${zeilenText([b.von, b.bis])}.` : ''}
        </figcaption>
        <ol class="quelltext">
          {zeilen.map((z, i) => {
            const n = i + 1;
            const drin = gefunden && n >= b.von && n <= b.bis;
            const ueberschrift = /^#{1,6}\s/.test(z);
            return (
              <li key={i} ref={n === b.von ? markRef : undefined} class={`${drin ? 'belegt' : ''}${ueberschrift ? ' ueberschrift' : ''}`} value={n}>
                {drin && n === b.von && <span class="sr-only">Beginn der Fundstelle: </span>}
                <span class="zeile">{z || ' '}</span>
                {drin && n === b.bis && <span class="sr-only"> Ende der Fundstelle.</span>}
              </li>
            );
          })}
        </ol>
      </figure>
    </div>
  );
}
