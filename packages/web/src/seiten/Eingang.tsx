import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { PRODUKT } from '../produkt';
import { api } from '../api';
import type { Vorschlag } from '../api/types';
import { useApp, darf } from '../kontext';
import { fehlerText, useLaden } from '../lib/laden';
import { datum, relativ } from '../lib/datum';
import { href, geheZu, type Route } from '../lib/router';
import { artikelRoute } from '../lib/pfade';
import { Icon } from '../ui/Icon';
import { Chip, Feld, Fehlerhinweis, Hinweis, Knopf, Laedt, Leer, Segment, Seitenkopf, Skelett } from '../ui/teile';
import { DiffAnsicht } from '../ui/DiffAnsicht';

const ART_TEXT: Record<Vorschlag['art'], string> = { neu: 'Neuer Artikel', aenderung: 'Änderung', loeschung: 'Löschen' };
const STATUS_TEXT: Record<Vorschlag['status'], string> = { offen: 'Offen', freigegeben: 'Freigegeben', abgelehnt: 'Abgelehnt', konflikt: 'Konflikt' };

function istRegel(v: Vorschlag) {
  return v.ziel.startsWith('wissen/_regeln/');
}

function zielName(v: Vorschlag, titel: Map<string, string>) {
  return titel.get(v.ziel) ?? (v.ziel.split('/').pop() ?? v.ziel).replace(/\.md$/, '').replace(/^\d+-/, '').replace(/-/g, ' ');
}

function Detail({ v, titel, entschieden }: { v: Vorschlag; titel: Map<string, string>; entschieden: (v: Vorschlag) => void }) {
  const { ich, melde, ladeZaehler, ladeArtikelListe } = useApp();
  const [modus, setModus] = useState<'ansicht' | 'aendern' | 'ablehnen'>('ansicht');
  const [text, setText] = useState(v.neu);
  const [begruendung, setBegruendung] = useState('');
  const [fehler, setFehler] = useState<string | null>(null);
  const [allgemein, setAllgemein] = useState<string | null>(null);
  const [laedt, setLaedt] = useState<string | null>(null);
  useEffect(() => {
    setModus('ansicht');
    setText(v.neu);
    setBegruendung('');
    setFehler(null);
    setAllgemein(null);
  }, [v.id, v.status]);

  // Bei Konflikt: heutigen Stand der Datei holen und gegen den Vorschlag vergleichen
  const aktuell = useLaden(async () => (v.status === 'konflikt' ? (await api.artikel(v.ziel)).text : null), [v.id, v.status]);

  const darfEntscheiden = istRegel(v) ? darf.verwalten(ich) : darf.freigeben(ich);
  const offen = v.status === 'offen' || v.status === 'konflikt';
  const name = zielName(v, titel);

  const entscheide = async (aktion: 'freigeben' | 'ablehnen' | 'aendern') => {
    if (aktion === 'ablehnen' && !begruendung.trim()) {
      setFehler('Bitte begründe die Ablehnung. Wer den Vorschlag gemacht hat, sieht die Begründung.');
      document.getElementById('ablehnen-grund')?.focus();
      return;
    }
    setLaedt(aktion);
    setAllgemein(null);
    try {
      const neu = await api.entscheide(v.id, {
        aktion,
        begruendung: aktion === 'ablehnen' ? begruendung.trim() : undefined,
        neuerText: aktion === 'aendern' ? text : undefined,
      });
      entschieden(neu);
      ladeZaehler();
      if (neu.status === 'konflikt') melde('Die Datei wurde inzwischen geändert. Bitte den neuen Vergleich prüfen.', 'info');
      else {
        ladeArtikelListe();
        melde(neu.status === 'abgelehnt' ? 'Abgelehnt. Die Begründung ist gespeichert.' : 'Freigegeben. Der Artikel ist aktualisiert und im Verlauf vermerkt.', 'ok', neu.status === 'freigegeben' && neu.art !== 'loeschung' ? { text: 'Artikel öffnen', href: href(artikelRoute(neu.ziel)) } : undefined);
      }
    } catch (e) {
      setAllgemein(fehlerText(e));
    } finally {
      setLaedt(null);
    }
  };

  return (
    <article class="vorschlag" aria-labelledby="seitentitel">
      <a href="#/eingang" class="zurueck-link nur-mobil">
        <Icon name="zurueck" groesse={18} /> Alle Vorschläge
      </a>
      <header class="vorschlag-kopf">
        <div class="chip-reihe">
          <Chip art={v.art === 'loeschung' ? 'warn' : 'akzent'}>{ART_TEXT[v.art]}</Chip>
          {v.status !== 'offen' && <Chip art={v.status === 'freigegeben' ? 'ok' : 'warn'} icon={v.status === 'freigegeben' ? 'haken' : v.status === 'konflikt' ? 'warnung' : 'kreuz'}>{STATUS_TEXT[v.status]}</Chip>}
          {istRegel(v) && <Chip icon="schloss">Regel, nur Admin</Chip>}
          {/^KI|Prüflauf/.test(v.von) && <Chip icon="info">Von KI vorgeschlagen</Chip>}
        </div>
        <h1 id="seitentitel" tabIndex={-1}>
          {name}
        </h1>
        <p class="vorschlag-meta">
          Nr. <span class="mono">{v.id.replace(/^v/, '')}</span> · von {v.von} · {relativ(v.erstellt)} ·{' '}
          {v.art !== 'neu' ? <a href={href(artikelRoute(v.ziel))}>Artikel ansehen</a> : <span class="mono">{v.ziel}</span>}
        </p>
      </header>

      <section class="grund" aria-label="Begründung des Vorschlags">
        <p class="grund-titel">Warum</p>
        <p>{v.grund}</p>
      </section>

      {v.status === 'konflikt' && (
        <Hinweis art="warnung" icon="warnung" titel="Die Datei wurde inzwischen geändert.">
          <p>
            Seit der Vorschlag gemacht wurde, hat jemand den Artikel bearbeitet, zum Beispiel direkt im Editor. {PRODUKT} überschreibt das nicht. Unten siehst du den heutigen Stand neben dem Vorschlag. Übernimm, was bleiben soll, über „Ändern“.
          </p>
        </Hinweis>
      )}

      <section aria-labelledby="diff-titel" class="vorschlag-diff">
        <h2 id="diff-titel" class="abschnitt-titel">
          {v.status === 'konflikt' ? 'Neuer Vergleich: heutiger Stand und Vorschlag' : 'Was sich ändert'}
        </h2>
        {v.status === 'konflikt' ? (
          aktuell.laedt ? (
            <Skelett zeilen={5} />
          ) : aktuell.fehler ? (
            <Fehlerhinweis text={aktuell.fehler} nochmal={aktuell.neu} />
          ) : (
            <DiffAnsicht alt={aktuell.daten ?? ''} neu={v.neu} titelAlt="Heute in der Datei" titelNeu="Vorschlag" />
          )
        ) : (
          <DiffAnsicht alt={v.alt ?? ''} neu={v.art === 'loeschung' ? '' : v.neu} />
        )}
      </section>

      {v.entscheidung && !offen && (
        <section class={`entscheidung entscheidung--${v.status}`} aria-label="Entscheidung">
          <Icon name={v.status === 'freigegeben' ? 'haken' : 'kreuz'} groesse={20} />
          <div>
            <p>
              <strong>{STATUS_TEXT[v.status]}</strong> von {v.entscheidung.von} am {datum(v.entscheidung.am)}
            </p>
            {v.entscheidung.begruendung && <p class="entscheidung-grund">„{v.entscheidung.begruendung}“</p>}
          </div>
        </section>
      )}

      {offen && !darfEntscheiden && (
        <Hinweis icon="schloss" titel={istRegel(v) ? 'Regeln gibt nur ein Admin frei.' : 'Freigeben dürfen Freigeber und Admins.'}>
          <p>Du siehst den Vorschlag zur Info. Sobald jemand entscheidet, steht es hier.</p>
        </Hinweis>
      )}

      {offen && darfEntscheiden && (
        <section class="entscheiden" aria-label="Entscheiden">
          {modus === 'aendern' && (
            <Feld label="Text, der übernommen wird" hilfe="Du kannst den Vorschlag vor dem Freigeben anpassen.">
              {(p) => <textarea {...p} class="eingabe eingabe--text" rows={12} value={text} onInput={(e) => setText((e.target as HTMLTextAreaElement).value)} />}
            </Feld>
          )}
          {modus === 'ablehnen' && (
            <Feld label="Warum lehnst du ab?" pflicht fehler={fehler} id="ablehnen-grund">
              {(p) => (
                <textarea
                  {...p}
                  class="eingabe"
                  rows={3}
                  placeholder="Zum Beispiel: Erst nach dem Jahresabschluss entscheiden."
                  value={begruendung}
                  onInput={(e) => {
                    setBegruendung((e.target as HTMLTextAreaElement).value);
                    if (fehler) setFehler(null);
                  }}
                />
              )}
            </Feld>
          )}
          {allgemein && <Fehlerhinweis text={allgemein} />}
          <div class="knopf-reihe">
            {modus === 'ansicht' && (
              <>
                {v.status !== 'konflikt' && (
                  <Knopf art="primaer" icon="haken" laedt={laedt === 'freigeben'} onClick={() => entscheide('freigeben')}>
                    Freigeben
                  </Knopf>
                )}
                <Knopf art={v.status === 'konflikt' ? 'primaer' : 'sekundaer'} icon="stift" onClick={() => setModus('aendern')}>
                  Ändern
                </Knopf>
                <Knopf art="gefahr" icon="kreuz" onClick={() => setModus('ablehnen')}>
                  Ablehnen
                </Knopf>
              </>
            )}
            {modus === 'aendern' && (
              <>
                <Knopf art="primaer" icon="haken" laedt={laedt === 'aendern'} onClick={() => entscheide('aendern')}>
                  Geändert freigeben
                </Knopf>
                <Knopf art="leise" onClick={() => setModus('ansicht')}>
                  Abbrechen
                </Knopf>
              </>
            )}
            {modus === 'ablehnen' && (
              <>
                <Knopf art="gefahr" icon="kreuz" laedt={laedt === 'ablehnen'} onClick={() => entscheide('ablehnen')}>
                  Ablehnung speichern
                </Knopf>
                <Knopf art="leise" onClick={() => setModus('ansicht')}>
                  Abbrechen
                </Knopf>
              </>
            )}
          </div>
          <p class="klein-text">Freigeben schreibt die Datei und legt einen Eintrag im Verlauf an, mit deinem Namen und dem Grund.</p>
        </section>
      )}
    </article>
  );
}

export function Eingang({ route }: { route: Route }) {
  const { ich, artikelListe, ladeZaehler, melde } = useApp();
  const r = useLaden(() => api.eingang(), []);
  const [filter, setFilter] = useState<'offen' | 'erledigt'>('offen');
  const [prueft, setPrueft] = useState(false);
  const titel = useMemo(() => new Map(artikelListe.map((a) => [a.pfad, a.kopf.titel])), [artikelListe]);
  const id = route.rest;
  const alle = r.daten ?? [];
  const offen = alle
    .filter((v) => v.status === 'offen' || v.status === 'konflikt')
    .sort((a, b) => (a.status === 'konflikt' ? 0 : 1) - (b.status === 'konflikt' ? 0 : 1) || a.erstellt.localeCompare(b.erstellt));
  const [grenze, setGrenze] = useState(3);
  const [alleZeigen, setAlleZeigen] = useState(false);
  useEffect(() => {
    api.lesen().then((l) => setGrenze(l.max_offene_vorschlaege), () => undefined);
  }, []);
  const erledigt = alle.filter((v) => v.status === 'freigegeben' || v.status === 'abgelehnt');
  const sichtbarOffen = alleZeigen ? offen : offen.slice(0, grenze);
  const wartend = offen.length - sichtbarOffen.length;
  const liste = filter === 'offen' ? sichtbarOffen : erledigt;
  const gewaehlt = alle.find((v) => v.id === id) ?? null;

  useEffect(() => {
    if (gewaehlt && (gewaehlt.status === 'freigegeben' || gewaehlt.status === 'abgelehnt') && filter === 'offen' && !r.laedt) setFilter('erledigt');
  }, [id, r.laedt]);
  useEffect(() => {
    // Auf breiten Bildschirmen den ersten offenen Vorschlag gleich zeigen
    if (!id && offen.length && matchMedia('(min-width: 1100px)').matches) geheZu(`eingang/${offen[0].id}`);
  }, [id, r.daten]);

  const weiter = useRef(0);
  useEffect(() => () => clearTimeout(weiter.current), []);
  const entschieden = (neu: Vorschlag) => {
    r.setze(alle.map((v) => (v.id === neu.id ? neu : v)));
    if (neu.status !== 'konflikt') {
      const naechster = offen.find((v) => v.id !== neu.id);
      if (naechster) weiter.current = window.setTimeout(() => location.hash.startsWith('#/eingang') && geheZu(`eingang/${naechster.id}`), 1200);
    }
  };

  const pruefen = async () => {
    setPrueft(true);
    try {
      const e = await api.pruefen();
      r.neu();
      ladeZaehler();
      melde(e.vorschlaege ? `Prüflauf fertig: ${e.vorschlaege} neue ${e.vorschlaege === 1 ? 'Vorschlag' : 'Vorschläge'}, ${e.befunde.length} Befunde.` : `Prüflauf fertig: ${e.befunde.length} Befunde, keine neuen Vorschläge.`);
    } catch (err) {
      melde(fehlerText(err), 'fehler');
    } finally {
      setPrueft(false);
    }
  };

  return (
    <div class={`seite seite--eingang${id ? ' hat-auswahl' : ''}`}>
      <div class="eingang-liste-spalte">
        <Seitenkopf
          ohneId={!!gewaehlt}
          titel="Eingang"
          unterzeile="Vorschläge von Menschen und KI. Ins Wissen kommt nur, was jemand freigibt."
          aktion={
            darf.freigeben(ich) ? (
              <Knopf klein icon="schild" laedt={prueft} onClick={pruefen}>
                Prüflauf starten
              </Knopf>
            ) : undefined
          }
        />
        <Segment
          name="eingang-filter"
          legende="Anzeigen"
          versteckteLegende
          wert={filter}
          aendern={setFilter}
          optionen={[
            { wert: 'offen', text: `Offen (${offen.length})` },
            { wert: 'erledigt', text: `Erledigt (${erledigt.length})` },
          ]}
        />
        {r.laedt && !r.daten && <Skelett zeilen={6} />}
        {r.fehler && <Fehlerhinweis text={r.fehler} nochmal={r.neu} />}
        {r.daten &&
          (liste.length ? (
            <ul class="vorschlag-liste">
              {liste.map((v) => (
                <li key={v.id}>
                  <a href={href(`eingang/${v.id}`)} class={`vorschlag-zeile${v.id === id ? ' aktiv' : ''}`} aria-current={v.id === id ? 'true' : undefined}>
                    <span class={`vorschlag-art vorschlag-art--${v.status === 'konflikt' ? 'konflikt' : v.art}`} aria-hidden="true">
                      <Icon name={v.status === 'konflikt' ? 'warnung' : v.art === 'neu' ? 'neu' : v.art === 'loeschung' ? 'kreuz' : 'stift'} groesse={16} />
                    </span>
                    <span class="vorschlag-zeile-text">
                      <span class="vorschlag-zeile-titel">{zielName(v, titel)}</span>
                      <span class="vorschlag-zeile-grund">{v.grund}</span>
                      <span class="vorschlag-zeile-meta">
                        {v.status === 'konflikt' ? 'Konflikt' : v.status === 'offen' ? ART_TEXT[v.art] : STATUS_TEXT[v.status]} · {v.von} · {relativ(v.erstellt)}
                        {istRegel(v) && ' · Regel'}
                      </span>
                    </span>
                  </a>
                </li>
              ))}
            </ul>
          ) : null)}
        {r.daten && filter === 'offen' && wartend > 0 && (
          <div class="wip-hinweis">
            <p>
              <strong>{wartend} weitere</strong> {wartend === 1 ? 'wartet' : 'warten'}. Du siehst höchstens {grenze} auf einmal, damit nichts liegen bleibt.
            </p>
            <Knopf klein art="leise" onClick={() => setAlleZeigen(true)}>
              Alle zeigen
            </Knopf>
          </div>
        )}
        {r.daten &&
          (liste.length ? null : (
            <Leer icon={filter === 'offen' ? 'haken' : 'eingang'} titel={filter === 'offen' ? 'Alles erledigt' : 'Noch nichts entschieden'}>
              <p>
                {filter === 'offen'
                  ? 'Im Eingang wartet nichts. Neue Vorschläge kommen, wenn jemand etwas hinzufügt oder eine Änderung vorschlägt.'
                  : 'Hier stehen später alle freigegebenen und abgelehnten Vorschläge.'}
              </p>
            </Leer>
          ))}
      </div>
      <div class="eingang-detail">
        {gewaehlt ? (
          <Detail v={gewaehlt} titel={titel} entschieden={entschieden} />
        ) : id && r.laedt ? (
          <Laedt />
        ) : id ? (
          <Leer icon="eingang" titel="Vorschlag nicht gefunden">
            <p>
              Vielleicht wurde er schon entschieden. <a href="#/eingang">Zur Liste</a>
            </p>
          </Leer>
        ) : (
          <div class="eingang-platzhalter">
            <Leer icon="eingang" titel="Wähl links einen Vorschlag">
              <p>Du siehst dann, was sich ändert, wer es vorgeschlagen hat und warum.</p>
            </Leer>
          </div>
        )}
      </div>
    </div>
  );
}
