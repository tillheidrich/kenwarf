import { useMemo, useState } from 'preact/hooks';
import { PRODUKT } from '../produkt';
import { api } from '../api';
import type { Quelle, QuellenArt } from '../api/types';
import { useApp, darf } from '../kontext';
import { useLaden } from '../lib/laden';
import { datum, relativ } from '../lib/datum';
import { filtere } from '../lib/finden';
import { markdownZuHtml } from '../lib/markdown';
import { href, type Route } from '../lib/router';
import { artikelRoute, dokumentPfadAusRoute, dokumentRoute, sichtbarkeitText } from '../lib/pfade';
import { Icon, type IconName } from '../ui/Icon';
import { Chip, Fehlerhinweis, KnopfLink, Laedt, Leer, Seitenkopf } from '../ui/teile';

export const ART: Record<QuellenArt, { text: string; icon: IconName }> = {
  datei: { text: 'Datei', icon: 'dokumente' },
  text: { text: 'Text', icon: 'text' },
  notiz: { text: 'Notiz', icon: 'stift' },
  web: { text: 'Webseite', icon: 'web' },
  audio: { text: 'Sprachnotiz', icon: 'mikro' },
};

function dateiTyp(q: Quelle): string {
  const m = /\.([a-z0-9]+)$/i.exec(q.kopf.herkunft);
  if (q.kopf.art === 'web') return 'Webseite';
  return m ? m[1].toUpperCase() : ART[q.kopf.art]?.text ?? q.kopf.art;
}

function Liste({ route }: { route: Route }) {
  const { ich } = useApp();
  const r = useLaden(() => api.quellen(), []);
  const [q, setQ] = useState('');
  const [sammlung, setSammlung] = useState(route.query.get('sammlung') ?? '');
  const [art, setArt] = useState('');
  const sammlungen = useMemo(() => [...new Set((r.daten ?? []).map((x) => x.kopf.sammlung))].sort(), [r.daten]);
  const liste = useMemo(() => {
    let l = r.daten ?? [];
    if (sammlung) l = l.filter((x) => x.kopf.sammlung === sammlung);
    if (art) l = l.filter((x) => x.kopf.art === art);
    if (q.trim()) l = filtere(l, q, (x) => `${x.kopf.titel} ${x.kopf.herkunft} ${x.kopf.sammlung}`);
    else l = [...l].sort((a, b) => b.kopf.erfasst_am.localeCompare(a.kopf.erfasst_am));
    return l;
  }, [r.daten, q, sammlung, art]);

  return (
    <div class="seite">
      <Seitenkopf
        titel="Dokumente"
        unterzeile="Das Rohmaterial: Dateien, Notizen, Webseiten und Sprachnotizen, unverändert abgelegt. Daraus entstehen die Artikel."
        aktion={
          darf.vorschlagen(ich) ? (
            <KnopfLink art="primaer" href="#/hinzufuegen" icon="hinzufuegen">
              Hinzufügen
            </KnopfLink>
          ) : undefined
        }
      />
      <form class="filterleiste" role="search" aria-label="Dokumente filtern" onSubmit={(e) => e.preventDefault()}>
        <div class="feld feld--kompakt feld--wachsen">
          <label class="feld-label" for="dok-q">
            Suchen
          </label>
          <div class="eingabe-mit-icon">
            <Icon name="suche" groesse={18} />
            <input id="dok-q" type="search" class="eingabe" placeholder="Titel oder Dateiname" value={q} onInput={(e) => setQ((e.target as HTMLInputElement).value)} />
          </div>
        </div>
        <div class="feld feld--kompakt">
          <label class="feld-label" for="dok-sammlung">
            Sammlung
          </label>
          <div class="auswahl">
            <select id="dok-sammlung" class="eingabe" value={sammlung} onChange={(e) => setSammlung((e.target as HTMLSelectElement).value)}>
              <option value="">Alle Sammlungen</option>
              {sammlungen.map((s) => (
                <option key={s}>{s}</option>
              ))}
            </select>
            <Icon name="pfeilRunter" groesse={16} klasse="auswahl-pfeil" />
          </div>
        </div>
        <div class="feld feld--kompakt">
          <label class="feld-label" for="dok-art">
            Art
          </label>
          <div class="auswahl">
            <select id="dok-art" class="eingabe" value={art} onChange={(e) => setArt((e.target as HTMLSelectElement).value)}>
              <option value="">Alle Arten</option>
              {Object.entries(ART).map(([k, v]) => (
                <option key={k} value={k}>
                  {v.text}
                </option>
              ))}
            </select>
            <Icon name="pfeilRunter" groesse={16} klasse="auswahl-pfeil" />
          </div>
        </div>
      </form>
      {r.laedt && !r.daten && <Laedt text="Dokumente werden geladen" />}
      {r.fehler && <Fehlerhinweis text={r.fehler} nochmal={r.neu} />}
      {r.daten &&
        (liste.length ? (
          <>
            <p class="treffer-zahl" role="status">
              {liste.length} {liste.length === 1 ? 'Dokument' : 'Dokumente'}
            </p>
            <ul class="dokument-liste">
              {liste.map((d) => (
                <li key={d.pfad}>
                  <a class="dokument-zeile" href={href(dokumentRoute(d.pfad))}>
                    <span class={`dokument-zeichen dokument-zeichen--${d.kopf.art}`} aria-hidden="true">
                      <Icon name={ART[d.kopf.art]?.icon ?? 'dokumente'} groesse={20} />
                    </span>
                    <span class="dokument-haupt">
                      <span class="dokument-titel">{d.kopf.titel}</span>
                      <span class="dokument-meta">
                        <span class="typ">{dateiTyp(d)}</span> · {d.kopf.sammlung} · {sichtbarkeitText(d.kopf.sichtbarkeit)}
                      </span>
                    </span>
                    <span class="dokument-rechts">
                      {d.kopf.beobachtet && (
                        <Chip icon="auge" art="akzent">
                          Beobachtet
                        </Chip>
                      )}
                      {d.kopf.ersetzt && <Chip icon="verlauf">Neue Fassung</Chip>}
                      <span class="mono dokument-datum">{datum(d.kopf.erfasst_am)}</span>
                    </span>
                  </a>
                </li>
              ))}
            </ul>
          </>
        ) : (
          <Leer
            icon="dokumente"
            titel={r.daten.length ? 'Nichts gefunden' : 'Noch keine Dokumente'}
            aktion={
              !r.daten.length && darf.vorschlagen(ich) ? (
                <KnopfLink art="primaer" href="#/hinzufuegen" iconRechts="pfeil">
                  Erstes Dokument hinzufügen
                </KnopfLink>
              ) : undefined
            }
          >
            <p>{r.daten.length ? 'Kein Dokument passt zu den Filtern.' : `Leg PDFs, Word-Dateien, Notizen oder Webseiten ab. ${PRODUKT} macht daraus Vorschläge für Artikel.`}</p>
          </Leer>
        ))}
    </div>
  );
}

function Detail({ pfad }: { pfad: string }) {
  const { artikelListe } = useApp();
  const r = useLaden(() => api.quelle(pfad), [pfad]);
  const html = useMemo(() => (r.daten ? markdownZuHtml(r.daten.text.replace(/^#\s+.*\n+/, ''), r.daten.pfad) : ''), [r.daten]);
  const nutzer = artikelListe.filter((a) => a.kopf.fundstellen.some((f) => f.quelle === pfad));
  if (r.laedt) return <div class="seite seite--schmal"><Laedt text="Dokument wird geladen" /></div>;
  if (r.fehler || !r.daten)
    return (
      <div class="seite seite--schmal">
        <Seitenkopf titel="Dokument nicht gefunden" />
        <Fehlerhinweis text={r.fehler ?? ''} nochmal={r.status === 404 ? undefined : r.neu} />
        <a href="#/dokumente">Zu allen Dokumenten</a>
      </div>
    );
  const k = r.daten.kopf;
  return (
    <div class="seite seite--schmal">
      <a href="#/dokumente" class="zurueck-link">
        <Icon name="zurueck" groesse={18} /> Alle Dokumente
      </a>
      <Seitenkopf
        oberzeile={`${ART[k.art]?.text ?? k.art} · ${k.sammlung}`}
        titel={k.titel}
        aktion={
          <KnopfLink href={api.originalUrl(pfad)} icon="herunterladen" target="_blank" rel="noopener" download>
            Original
          </KnopfLink>
        }
      />
      <dl class="artikel-meta">
        <div>
          <dt>Erfasst</dt>
          <dd>
            {relativ(k.erfasst_am)} <span class="meta-klein">von {k.erfasst_von}</span>
          </dd>
        </div>
        <div>
          <dt>Herkunft</dt>
          <dd class="umbruch">
            {/^https?:/.test(k.herkunft) ? (
              <a href={k.herkunft} target="_blank" rel="noopener noreferrer">
                {k.herkunft.replace(/^https?:\/\//, '')}
                <span class="sr-only"> (öffnet in neuem Tab)</span>
              </a>
            ) : (
              <span class="mono">{k.herkunft}</span>
            )}
          </dd>
        </div>
        <div>
          <dt>Wer darf lesen</dt>
          <dd>{sichtbarkeitText(k.sichtbarkeit)}</dd>
        </div>
        <div>
          <dt>Beobachtet</dt>
          <dd>{k.beobachtet ? 'Ja, Änderungen kommen als Vorschlag' : 'Nein'}</dd>
        </div>
      </dl>
      {k.ersetzt && (
        <p class="hinweis hinweis--info">
          <Icon name="verlauf" groesse={20} />
          <span>
            Diese Fassung ersetzt eine ältere (<span class="mono">{k.ersetzt}</span>). Die Suche nutzt nur noch diese.
          </span>
        </p>
      )}
      {nutzer.length > 0 && (
        <section class="artikel-abschnitt" aria-labelledby="dok-nutzer">
          <h2 id="dok-nutzer" class="abschnitt-titel">
            Wird belegt in {nutzer.length} {nutzer.length === 1 ? 'Artikel' : 'Artikeln'}
          </h2>
          <ul class="chip-reihe">
            {nutzer.map((a) => (
              <li key={a.pfad}>
                <a class="chip chip--link" href={href(artikelRoute(a.pfad))}>
                  <Icon name="wissen" groesse={14} /> {a.kopf.titel}
                </a>
              </li>
            ))}
          </ul>
        </section>
      )}
      <section class="artikel-abschnitt" aria-labelledby="dok-text">
        <h2 id="dok-text" class="abschnitt-titel">
          Text
        </h2>
        <div class="prosa prosa--dokument" dangerouslySetInnerHTML={{ __html: html }} />
      </section>
      <p class="klein-text mono umbruch">
        {pfad} · {k.hash.slice(0, 19)}…
      </p>
    </div>
  );
}

export function Dokumente({ route }: { route: Route }) {
  const pfad = dokumentPfadAusRoute(route.rest);
  return pfad ? <Detail pfad={pfad} /> : <Liste route={route} />;
}
