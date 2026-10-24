import { useEffect, useMemo, useState } from 'preact/hooks';
import { PRODUKT } from '../produkt';
import { api } from '../api';
import type { Artikel, PruefErgebnis } from '../api/types';
import { useApp, darf } from '../kontext';
import { ampel, datum, relativ } from '../lib/datum';
import { filtere } from '../lib/finden';
import { fehlerText, useLaden } from '../lib/laden';
import { href, type Route } from '../lib/router';
import { artikelHtml, fundstelleHref } from '../lib/artikel';
import { artikelPfadAusRoute, artikelRoute, sichtbarkeitText } from '../lib/pfade';
import { zeilenText } from '../lib/fundstelle';
import { Icon } from '../ui/Icon';
import { AmpelMarke, Chip, Dialog, Feld, Fehlerhinweis, Knopf, KnopfLink, Laedt, Leer, Seitenkopf, Skelett } from '../ui/teile';
import { FaktenTabelle } from '../ui/FaktenTabelle';

function gruppiere(liste: Artikel[]): [string, Artikel[]][] {
  const m = new Map<string, Artikel[]>();
  for (const a of liste) {
    const g = a.kopf.gruppe || 'Ohne Gruppe';
    if (!m.has(g)) m.set(g, []);
    m.get(g)!.push(a);
  }
  for (const l of m.values()) l.sort((x, y) => x.pfad.localeCompare(y.pfad, 'de', { numeric: true }));
  return [...m.entries()];
}

function WissenNav({ liste, laedt, aktivPfad, filter }: { liste: Artikel[]; laedt: boolean; aktivPfad: string; filter: string }) {
  const { ich } = useApp();
  const [q, setQ] = useState('');
  const mein = liste.filter((a) => a.kopf.sichtbarkeit === 'ich' && a.kopf.besitzer === ich.id);
  const betrieb = liste.filter((a) => !(a.kopf.sichtbarkeit === 'ich' && a.kopf.besitzer === ich.id));
  const faellig = liste.filter((a) => ampel(a.kopf.pruefen_bis).stufe === 'ueberfaellig');
  const gefiltert = q ? filtere(betrieb, q, (a) => `${a.kopf.titel} ${a.kopf.kurzfassung} ${a.kopf.gruppe}`) : betrieb;
  const gruppen = gruppiere(gefiltert);

  const Eintrag = ({ a }: { a: Artikel }) => {
    const amp = ampel(a.kopf.pruefen_bis);
    const istAktiv = a.pfad === aktivPfad;
    return (
      <li>
        <a href={href(artikelRoute(a.pfad))} class={`nav-artikel${istAktiv ? ' aktiv' : ''}`} aria-current={istAktiv ? 'page' : undefined}>
          <span class="nav-artikel-titel">{a.kopf.titel}</span>
          <span class="nav-artikel-meta">
            {a.kopf.status === 'veraltet' ? 'Veraltet' : a.kopf.status === 'entwurf' ? 'Entwurf' : 'Artikel'} · {a.kopf.fundstellen.length}{' '}
            {a.kopf.fundstellen.length === 1 ? 'Fundstelle' : 'Fundstellen'}
            {(amp.stufe === 'ueberfaellig' || amp.stufe === 'bald') && (
              <span class={`ampel-punkt ampel-punkt--${amp.stufe}`} title={amp.wort}>
                <span class="sr-only">, {amp.wort}</span>
              </span>
            )}
          </span>
        </a>
      </li>
    );
  };

  return (
    <nav class="wissen-nav" aria-label="Artikel">
      <h2 class="abschnitt-titel nur-mobil wissen-nav-titel">Alle Artikel</h2>
      <div class="wissen-nav-suche">
        <label for="wissen-filter" class="sr-only">
          Artikel filtern
        </label>
        <Icon name="suche" groesse={18} />
        <input
          id="wissen-filter"
          type="search"
          class="eingabe eingabe--klein"
          placeholder={`${liste.length} Artikel durchsuchen`}
          value={q}
          onInput={(e) => setQ((e.target as HTMLInputElement).value)}
        />
      </div>
      <ul class="wissen-nav-schnell">
        <li>
          <a href={href('wissen')} class={`nav-schnell${!aktivPfad && !filter ? ' aktiv' : ''}`} aria-current={!aktivPfad && !filter ? 'page' : undefined}>
            <Icon name="wissen" groesse={18} /> Übersicht
          </a>
        </li>
        <li>
          <a href={href('wissen', { filter: 'mein' })} class={`nav-schnell${filter === 'mein' ? ' aktiv' : ''}`} aria-current={filter === 'mein' ? 'page' : undefined}>
            <Icon name="person" groesse={18} /> Mein Bereich <span class="zahl">{mein.length}</span>
          </a>
        </li>
        <li>
          <a href={href('wissen', { filter: 'faellig' })} class={`nav-schnell${filter === 'faellig' ? ' aktiv' : ''}`} aria-current={filter === 'faellig' ? 'page' : undefined}>
            <Icon name="uhr" groesse={18} /> Fällig
            {faellig.length > 0 && <span class="zahl zahl--warn">{faellig.length}</span>}
          </a>
        </li>
      </ul>
      {laedt && !liste.length && <Skelett zeilen={8} />}
      {gruppen.map(([g, l]) => (
        <details key={g} class="wissen-gruppe" open>
          <summary>
            <span>{g}</span>
            <span class="zahl">{l.length}</span>
          </summary>
          <ul>
            {l.map((a) => (
              <Eintrag key={a.pfad} a={a} />
            ))}
          </ul>
        </details>
      ))}
      {q && !gruppen.length && <p class="klein-text nav-leer">Kein Artikel passt zu „{q}“.</p>}
      {darf.vorschlagen(ich) && (
        <a href={href('hinzufuegen', { art: 'text' })} class="nav-neu">
          <Icon name="neu" groesse={18} /> Neues Wissen aufschreiben
        </a>
      )}
    </nav>
  );
}

function ArtikelKarte({ a }: { a: Artikel }) {
  const amp = ampel(a.kopf.pruefen_bis);
  return (
    <li>
      <a class="artikel-karte" href={href(artikelRoute(a.pfad))}>
        <span class="artikel-karte-gruppe">{a.kopf.gruppe}</span>
        <span class="artikel-karte-titel">{a.kopf.titel}</span>
        <span class="artikel-karte-kurz">{a.kopf.kurzfassung}</span>
        <span class="artikel-karte-fuss">
          <AmpelMarke ampel={amp} kurz />
          <span class="mono">Stand {datum(a.kopf.stand)}</span>
        </span>
      </a>
    </li>
  );
}

function Uebersicht({ liste, laedt, fehler, neu, filter }: { liste: Artikel[]; laedt: boolean; fehler: string | null; neu: () => void; filter: string }) {
  const { ich, melde, ladeZaehler } = useApp();
  const [pruefung, setPruefung] = useState<PruefErgebnis | null>(null);
  const [prueftLauf, setPrueftLauf] = useState(false);
  const faellig = liste.filter((a) => ampel(a.kopf.pruefen_bis).stufe === 'ueberfaellig');
  const bald = liste.filter((a) => ampel(a.kopf.pruefen_bis).stufe === 'bald');
  const veraltet = liste.filter((a) => a.kopf.status === 'veraltet');
  const neueste = liste.filter((a) => a.kopf.sichtbarkeit !== 'ich').sort((x, y) => y.kopf.stand.localeCompare(x.kopf.stand)).slice(0, 4);
  const mein = liste.filter((a) => a.kopf.sichtbarkeit === 'ich' && a.kopf.besitzer === ich.id);

  const pruefen = async () => {
    setPrueftLauf(true);
    try {
      const e = await api.pruefen();
      setPruefung(e);
      ladeZaehler();
      melde(e.vorschlaege ? `Prüflauf fertig: ${e.vorschlaege} ${e.vorschlaege === 1 ? 'Vorschlag liegt' : 'Vorschläge liegen'} im Eingang.` : 'Prüflauf fertig, nichts gefunden.', 'ok', e.vorschlaege ? { text: 'Zum Eingang', href: '#/eingang' } : undefined);
    } catch (e) {
      melde(fehlerText(e), 'fehler');
    } finally {
      setPrueftLauf(false);
    }
  };

  const titel = filter === 'mein' ? 'Mein Bereich' : filter === 'faellig' ? 'Fällig' : 'Wissen';
  const unter =
    filter === 'mein'
      ? 'Notizen und Artikel, die nur du siehst.'
      : filter === 'faellig'
        ? 'Artikel, deren Prüftermin überschritten ist oder bald kommt.'
        : 'Freigegebene Artikel. Jede Aussage hat eine Fundstelle.';

  return (
    <div class="wissen-start">
      <Seitenkopf
        titel={titel}
        unterzeile={unter}
        aktion={
          darf.freigeben(ich) && !filter ? (
            <Knopf icon="schild" laedt={prueftLauf} onClick={pruefen}>
              Prüflauf starten
            </Knopf>
          ) : undefined
        }
      />
      {fehler && <Fehlerhinweis text={fehler} nochmal={neu} />}
      {laedt && !liste.length && <Laedt />}
      {pruefung && (
        <section class="karte pruef-ergebnis" aria-labelledby="pruef-titel">
          <h2 id="pruef-titel">Ergebnis des Prüflaufs</h2>
          {pruefung.befunde.length ? (
            <ul class="befunde">
              {pruefung.befunde.map((b, i) => (
                <li key={i} class={`befund befund--${b.schwere ?? 'hinweis'}`}>
                  <Icon name={b.schwere === 'hinweis' ? 'info' : 'warnung'} groesse={18} />
                  <span>
                    {b.text} {b.pfad && <a href={href(artikelRoute(b.pfad))}>Artikel öffnen</a>}
                  </span>
                </li>
              ))}
            </ul>
          ) : (
            <p>Keine Widersprüche, nichts abgelaufen, keine kaputten Fundstellen.</p>
          )}
          {pruefung.vorschlaege > 0 && (
            <KnopfLink art="primaer" href="#/eingang" iconRechts="pfeil">
              {pruefung.vorschlaege} {pruefung.vorschlaege === 1 ? 'Vorschlag' : 'Vorschläge'} im Eingang ansehen
            </KnopfLink>
          )}
        </section>
      )}

      {filter === 'mein' && (
        mein.length ? (
          <ul class="artikel-gitter">{mein.map((a) => <ArtikelKarte key={a.pfad} a={a} />)}</ul>
        ) : (
          !laedt && (
            <Leer icon="person" titel="Dein Bereich ist noch leer" aktion={<KnopfLink art="primaer" href={href('hinzufuegen', { art: 'text', sicht: 'ich' })} iconRechts="pfeil">Notiz anlegen</KnopfLink>}>
              <p>Hier landet alles, was du mit „Nur ich“ speicherst. Das Team sieht es nicht.</p>
            </Leer>
          )
        )
      )}

      {filter === 'faellig' && (
        faellig.length + bald.length ? (
          <ul class="artikel-gitter">{[...faellig, ...bald].map((a) => <ArtikelKarte key={a.pfad} a={a} />)}</ul>
        ) : (
          !laedt && <Leer icon="haken" titel="Nichts fällig"><p>Alle Artikel sind innerhalb ihres Prüftermins.</p></Leer>
        )
      )}

      {!filter && liste.length > 0 && (
        <>
          <dl class="kennzahlen">
            <div>
              <dt>Artikel</dt>
              <dd>{liste.length}</dd>
            </div>
            <div class={faellig.length ? 'warn' : ''}>
              <dt>Überfällig</dt>
              <dd>{faellig.length}</dd>
            </div>
            <div>
              <dt>Bald prüfen</dt>
              <dd>{bald.length}</dd>
            </div>
            <div>
              <dt>Veraltet</dt>
              <dd>{veraltet.length}</dd>
            </div>
          </dl>
          {faellig.length > 0 && (
            <section aria-labelledby="w-faellig">
              <h2 id="w-faellig" class="abschnitt-titel">Prüftermin überschritten</h2>
              <ul class="artikel-gitter">{faellig.map((a) => <ArtikelKarte key={a.pfad} a={a} />)}</ul>
            </section>
          )}
          <section aria-labelledby="w-neu" class="abschnitt-zuletzt">
            <h2 id="w-neu" class="abschnitt-titel">Zuletzt geändert</h2>
            <ul class="artikel-gitter">{neueste.map((a) => <ArtikelKarte key={a.pfad} a={a} />)}</ul>
          </section>
        </>
      )}
      {!filter && !laedt && !fehler && !liste.length && (
        <Leer icon="wissen" titel="Noch kein Wissen da" aktion={<KnopfLink art="primaer" href="#/hinzufuegen" iconRechts="pfeil">Erstes Dokument hinzufügen</KnopfLink>}>
          <p>Leg Dokumente, Notizen oder Webseiten ab. {PRODUKT} schlägt daraus Artikel vor, die du im Eingang freigibst.</p>
        </Leer>
      )}
    </div>
  );
}

function Verlauf({ pfad }: { pfad: string }) {
  const v = useLaden(() => api.verlauf(pfad), [pfad]);
  if (v.laedt) return <Skelett zeilen={2} />;
  if (v.fehler) return <Fehlerhinweis text={v.fehler} nochmal={v.neu} />;
  if (!v.daten?.length) return <p class="klein-text">Noch keine Änderungen aufgezeichnet.</p>;
  return (
    <ol class="verlauf">
      {v.daten.map((e) => (
        <li key={e.commit + e.am}>
          <span class="verlauf-punkt" aria-hidden="true" />
          <div>
            <p class="verlauf-grund">{e.grund}</p>
            <p class="verlauf-meta">
              {e.von} · {relativ(e.am)} · <span class="mono">{e.commit.slice(0, 7)}</span>
            </p>
          </div>
        </li>
      ))}
    </ol>
  );
}

function AenderungVorschlagen({ a, offen, schliessen }: { a: Artikel; offen: boolean; schliessen: () => void }) {
  const { melde, ladeZaehler } = useApp();
  const [text, setText] = useState(a.text);
  const [grund, setGrund] = useState('');
  const [fehler, setFehler] = useState<{ grund?: string; text?: string; allgemein?: string }>({});
  const [laedt, setLaedt] = useState(false);
  useEffect(() => {
    if (offen) {
      setText(a.text);
      setGrund('');
      setFehler({});
    }
  }, [offen, a.pfad]);

  const senden = async (e: Event) => {
    e.preventDefault();
    const f: typeof fehler = {};
    if (text.trim() === a.text.trim()) f.text = 'Du hast am Text noch nichts geändert.';
    if (!grund.trim()) f.grund = 'Schreib kurz, warum. Das hilft der Person, die freigibt.';
    setFehler(f);
    if (f.text || f.grund) return;
    setLaedt(true);
    try {
      await api.vorschlag({ art: 'aenderung', ziel: a.pfad, alt: a.text, neu: text, grund: grund.trim() });
      ladeZaehler();
      melde('Dein Vorschlag liegt jetzt im Eingang.', 'ok', { text: 'Ansehen', href: '#/eingang' });
      schliessen();
    } catch (err) {
      setFehler({ allgemein: fehlerText(err) });
    } finally {
      setLaedt(false);
    }
  };

  return (
    <Dialog
      offen={offen}
      schliessen={schliessen}
      titel="Änderung vorschlagen"
      breit
      beschreibung="Dein Vorschlag geht in den Eingang. Erst wenn jemand ihn freigibt, ändert sich der Artikel."
    >
      <form onSubmit={senden} class="formular" noValidate>
        <Feld label={`Text von „${a.kopf.titel}“`} fehler={fehler.text} hilfe="Markdown: ## für Überschriften, - für Listen, **fett**.">
          {(p) => <textarea {...p} class="eingabe eingabe--text" rows={14} value={text} onInput={(e) => setText((e.target as HTMLTextAreaElement).value)} />}
        </Feld>
        <Feld label="Warum?" pflicht fehler={fehler.grund}>
          {(p) => (
            <textarea {...p} class="eingabe" rows={2} placeholder="Zum Beispiel: Die Lieferzeit hat sich geändert." value={grund} onInput={(e) => setGrund((e.target as HTMLTextAreaElement).value)} />
          )}
        </Feld>
        {fehler.allgemein && <Fehlerhinweis text={fehler.allgemein} />}
        <div class="knopf-reihe knopf-reihe--ende">
          <Knopf art="leise" onClick={schliessen}>
            Abbrechen
          </Knopf>
          <Knopf art="primaer" type="submit" laedt={laedt} iconRechts="pfeil">
            In den Eingang legen
          </Knopf>
        </div>
      </form>
    </Dialog>
  );
}

function ArtikelAnsicht({ pfad }: { pfad: string }) {
  const { ich } = useApp();
  const r = useLaden(() => api.artikel(pfad), [pfad]);
  const [vorschlagen, setVorschlagen] = useState(false);
  const html = useMemo(() => (r.daten ? artikelHtml(r.daten.text, r.daten.pfad, r.daten.kopf.fundstellen) : ''), [r.daten]);

  if (r.laedt && !r.daten)
    return (
      <div class="artikel">
        <Laedt text="Artikel wird geladen" />
      </div>
    );
  if (r.fehler || !r.daten)
    return (
      <div class="artikel">
        <Seitenkopf titel={r.status === 404 ? 'Artikel nicht gefunden' : 'Artikel nicht geladen'} />
        <Fehlerhinweis text={r.fehler ?? 'Unbekannter Fehler'} nochmal={r.status === 404 ? undefined : r.neu} />
        <p>
          <a href="#/wissen">Zur Übersicht</a>
        </p>
      </div>
    );
  const a = r.daten;
  const k = a.kopf;
  const amp = ampel(k.pruefen_bis);
  const geprueft = k.verified?.[0];
  const istRegel = a.pfad.startsWith('wissen/_regeln/');

  return (
    <article class="artikel" aria-labelledby="seitentitel">
      <a href="#/wissen" class="zurueck-link nur-mobil">
        <Icon name="zurueck" groesse={18} /> Alle Artikel
      </a>
      <header class="artikel-kopf">
        <p class="oberzeile">
          <a href={href('wissen')}>Wissen</a> <span aria-hidden="true">/</span> {k.gruppe}
        </p>
        <h1 id="seitentitel" tabIndex={-1}>
          {k.titel}
        </h1>
        <div class="chip-reihe">
          {k.status === 'veraltet' && (
            <Chip art="warn" icon="warnung">
              Veraltet
            </Chip>
          )}
          {k.status === 'entwurf' && <Chip icon="stift">Entwurf</Chip>}
          <Chip icon={k.sichtbarkeit === 'ich' ? 'schloss' : k.sichtbarkeit === 'betrieb' ? 'betrieb' : 'team'}>{sichtbarkeitText(k.sichtbarkeit)}</Chip>
          {k.type && k.type !== 'Artikel' && <Chip>{k.type}</Chip>}
          {k.generated && <Chip icon="info">Von KI entworfen</Chip>}
          {istRegel && <Chip icon="schloss">Regel</Chip>}
        </div>
        {istRegel && !darf.verwalten(ich) && <p class="klein-text">Regeln ändert nur ein Admin. Wenn hier etwas nicht stimmt, sag Bescheid.</p>}
        {(istRegel ? darf.verwalten(ich) : darf.vorschlagen(ich)) && (
          <div class="artikel-aktionen">
            <Knopf icon="stift" onClick={() => setVorschlagen(true)}>
              Änderung vorschlagen
            </Knopf>
          </div>
        )}
      </header>

      {k.status === 'veraltet' && (
        <div class="hinweis hinweis--warnung">
          <Icon name="warnung" groesse={20} />
          <div>
            <p class="hinweis-titel">Dieser Artikel ist als veraltet markiert.</p>
            <p>Er bleibt lesbar, aber verlass dich nicht darauf. Frag {k.verantwortlich}, was heute gilt.</p>
          </div>
        </div>
      )}

      <dl class="artikel-meta">
        <div>
          <dt>Stand</dt>
          <dd class="mono">{datum(k.stand)}</dd>
        </div>
        <div>
          <dt>Verantwortlich</dt>
          <dd>{k.verantwortlich}</dd>
        </div>
        <div>
          <dt>Prüftermin</dt>
          <dd>
            <AmpelMarke ampel={amp} />
            {k.pruefen_bis && <span class="mono meta-klein"> {datum(k.pruefen_bis)}</span>}
          </dd>
        </div>
        <div>
          <dt>Geprüft</dt>
          <dd>
            {geprueft ? (
              <>
                von {geprueft.by} <span class="meta-klein">am {datum(geprueft.at)}</span>
                {k.verified && k.verified.length > 1 && <span class="meta-klein"> und {k.verified.length - 1} weiteren</span>}
              </>
            ) : (
              <span class="leise">noch nicht</span>
            )}
          </dd>
        </div>
      </dl>

      <section class="kurzfassung" aria-labelledby="kurz-titel">
        <h2 id="kurz-titel" class="kurzfassung-titel">
          Kurzfassung
        </h2>
        <p>{k.kurzfassung}</p>
      </section>

      <div class="prosa" dangerouslySetInnerHTML={{ __html: html }} />

      {k.fakten && k.fakten.length > 0 && (
        <section class="artikel-abschnitt" aria-labelledby="fakten-titel">
          <h2 id="fakten-titel" class="abschnitt-titel">
            Fakten aus diesem Artikel
          </h2>
          <FaktenTabelle fakten={k.fakten} fundstellen={k.fundstellen} beschriftung={`Fakten aus ${k.titel}`} />
        </section>
      )}

      <section class="artikel-abschnitt" aria-labelledby="fs-titel">
        <h2 id="fs-titel" class="abschnitt-titel">
          Fundstellen
        </h2>
        {k.fundstellen.length ? (
          <ol class="fundstellen">
            {k.fundstellen.map((f, i) => (
              <li key={i}>
                <span class="beleg-nummer" aria-hidden="true">
                  {i + 1}
                </span>
                <div>
                  <a href={fundstelleHref(f)} class="fundstelle-link">
                    {f.abschnitt}
                  </a>
                  <p class="fundstelle-ort mono">
                    {f.quelle} · {zeilenText(f.zeilen)}
                  </p>
                </div>
              </li>
            ))}
          </ol>
        ) : (
          <p class="klein-text">Dieser Artikel nennt keine Fundstellen. Antworten daraus gelten als unbelegt.</p>
        )}
      </section>

      <details class="artikel-abschnitt verlauf-block">
        <summary class="abschnitt-titel">
          <Icon name="verlauf" groesse={18} /> Verlauf
        </summary>
        <Verlauf pfad={a.pfad} />
      </details>

      <AenderungVorschlagen a={a} offen={vorschlagen} schliessen={() => setVorschlagen(false)} />
    </article>
  );
}

export function Wissen({ route }: { route: Route }) {
  const { artikelListe, ladeArtikelListe } = useApp();
  const liste = useLaden(() => api.wissen(), []);
  const pfad = artikelPfadAusRoute(route.rest);
  const filter = route.query.get('filter') ?? '';
  useEffect(() => {
    if (liste.daten && liste.daten.length !== artikelListe.length) ladeArtikelListe();
  }, [liste.daten]);
  const daten = liste.daten ?? [];
  return (
    <div class={`seite seite--wissen${pfad ? ' hat-artikel' : ''}${filter ? ' hat-filter' : ''}`}>
      <WissenNav liste={daten} laedt={liste.laedt} aktivPfad={pfad} filter={filter} />
      <div class="wissen-inhalt">
        {pfad ? <ArtikelAnsicht pfad={pfad} /> : <Uebersicht liste={daten} laedt={liste.laedt} fehler={liste.fehler} neu={liste.neu} filter={filter} />}
      </div>
    </div>
  );
}
