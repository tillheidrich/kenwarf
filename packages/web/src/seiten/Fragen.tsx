import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { PRODUKT } from '../produkt';
import { api, MOCK } from '../api';
import type { Abgleich, Antwort, Artikel, Fundstelle, Reichweite } from '../api/types';
import { kiHinweis } from '../lib/kennzeichnung';
import { useApp, darf } from '../kontext';
import { fehlerText } from '../lib/laden';
import { href, type Route } from '../lib/router';
import { zeilenText } from '../lib/fundstelle';
import { kurzname, bereichVon } from '../lib/pfade';
import { Icon } from '../ui/Icon';
import { Dialog, Feld, Fehlerhinweis, Hinweis, Knopf, KnopfLink, Segment, Seitenkopf, Skelett } from '../ui/teile';
import { datum } from '../lib/datum';

const REICHWEITEN: { wert: Reichweite; text: string; icon: 'person' | 'team' | 'betrieb'; hinweis: string }[] = [
  { wert: 'ich', text: 'Nur meins', icon: 'person', hinweis: 'Nur deine eigenen Notizen und Dokumente' },
  { wert: 'team', text: 'Team', icon: 'team', hinweis: 'Deins und das deiner Teams' },
  { wert: 'betrieb', text: 'Betrieb', icon: 'betrieb', hinweis: 'Alles, was du sehen darfst, auch was für alle Angemeldeten freigegeben ist' },
];

const DEMO_FRAGEN: { wer: string; frage: string; marke?: string }[] = [
  { wer: 'Kai, Werkstatt', frage: 'Ein Kunde ruft an, an seiner neuen Schranktür ist ein Kratzer. Was sag ich ihm?' },
  { wer: 'Sabine, Büro', frage: 'Wie viel Anzahlung nehmen wir bei einer Treppe für 2.400 €?' },
  { wer: 'Neuer Azubi', frage: 'Wie lange läuft die Lüftung im Lackraum nach?', marke: 'Steht nicht drin' },
  { wer: 'Neuer Geselle', frage: 'Mit welchem Stundensatz rechnen wir im Angebot?', marke: 'Gehört nicht hierher' },
];

function initial(name: string) {
  return name.trim().charAt(0).toUpperCase();
}

function AbgleichListe({ titel, punkte, art }: { titel: string; punkte: Abgleich['fehlt']; art: string }) {
  if (!punkte.length) return null;
  return (
    <section class={`abgleich abgleich--${art}`} aria-label={titel}>
      <h3 class="abgleich-titel">
        {titel} <span class="zahl">{punkte.length}</span>
      </h3>
      <ul>
        {punkte.map((p) => (
          <li key={p.id}>
            <span>{p.satz}</span>
            {p.belege[0] && (
              <a class="fussnote fussnote--inline" href={href('fundstelle', { pfad: p.belege[0].quelle, von: p.belege[0].zeilen[0], bis: p.belege[0].zeilen[1], zitat: p.belege[0].zitat.slice(0, 300) })} aria-label={`Fundstelle: ${p.belege[0].abschnitt}`}>
                <Icon name="dokumente" groesse={12} />
              </a>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}

function titelFuer(f: Fundstelle, titel: Map<string, string>): string {
  return titel.get(f.quelle) ?? kurzname(f.quelle).replace(/^\d+-/, '').replace(/-/g, ' ');
}

export function Fragen({ route }: { route: Route }) {
  const { einstellungen, artikelListe, ich } = useApp();
  const vorgabe = route.query.get('q') ?? '';
  const [frage, setFrage] = useState(vorgabe);
  const [gestellt, setGestellt] = useState('');
  const [sammlung, setSammlung] = useState('');
  const [reichweite, setReichweite] = useState<Reichweite>('betrieb');
  const [antwort, setAntwort] = useState<Antwort | null>(null);
  const [laedt, setLaedt] = useState(false);
  const [fehler, setFehler] = useState<string | null>(null);
  const [markiert, setMarkiert] = useState<number | null>(null);
  const [eingabeFehler, setEingabeFehler] = useState<string | null>(null);
  const lauf = useRef(0);
  const antwortRef = useRef<HTMLDivElement>(null);

  const sammlungen = useMemo(() => {
    const s = new Set<string>(einstellungen?.sammlungen ?? []);
    for (const a of artikelListe) s.add(a.kopf.gruppe);
    return [...s].sort((a, b) => a.localeCompare(b, 'de'));
  }, [einstellungen, artikelListe]);

  const titel = useMemo(() => new Map(artikelListe.map((a) => [a.pfad, a.kopf.titel])), [artikelListe]);

  const beispiele = useMemo(() => {
    if (MOCK) return DEMO_FRAGEN;
    return artikelListe.slice(0, 4).map((a) => ({ wer: a.kopf.gruppe, frage: `Was gilt bei „${a.kopf.titel}“?`, marke: undefined }));
  }, [artikelListe]);
  const kopfVon = useMemo(() => new Map<string, Artikel['kopf']>(artikelListe.map((a) => [a.pfad, a.kopf])), [artikelListe]);
  const [erstIch, setErstIch] = useState(false);
  const [eigene, setEigene] = useState('');
  const [eigeneFehler, setEigeneFehler] = useState<string | null>(null);
  const [abgleich, setAbgleich] = useState<Abgleich | null>(null);
  const [fehlerOffen, setFehlerOffen] = useState(false);
  const [richtig, setRichtig] = useState('');
  const [meldet, setMeldet] = useState(false);
  const { melde } = useApp();
  useEffect(() => {
    api.lesen().then((l) => setErstIch(l.modus_erst_ich), () => undefined);
  }, []);

  const stelle = async (text = frage, opt: { reichweite?: Reichweite } = {}) => {
    const f = text.trim();
    if (f.length < 3) {
      setEingabeFehler('Schreib eine Frage mit ein paar Wörtern.');
      document.getElementById('frage-eingabe')?.focus();
      return;
    }
    setEingabeFehler(null);
    if (erstIch && !eigene.trim()) {
      setEigeneFehler('Schreib zuerst deine eigene Einschätzung, ein Satz reicht. Oder schalte „Erst du, dann ich“ aus.');
      document.getElementById('eigene-einschaetzung')?.focus();
      return;
    }
    setEigeneFehler(null);
    setAbgleich(null);
    const r = opt.reichweite ?? reichweite;
    if (opt.reichweite) setReichweite(opt.reichweite);
    const meine = ++lauf.current;
    setLaedt(true);
    setFehler(null);
    setAntwort(null);
    setGestellt(f);
    setMarkiert(null);
    try {
      const [a, ab] = await Promise.all([
        api.frage(f, { reichweite: r, sammlung: sammlung || undefined }),
        erstIch ? api.einschaetzung({ bezug: f, text: eigene.trim() }) : Promise.resolve(null),
      ]);
      if (meine !== lauf.current) return;
      setAntwort(a);
      setAbgleich(ab);
      setTimeout(() => antwortRef.current?.focus({ preventScroll: false }), 20);
    } catch (e) {
      if (meine !== lauf.current) return;
      setFehler(fehlerText(e));
    } finally {
      if (meine === lauf.current) setLaedt(false);
    }
  };

  useEffect(() => {
    if (vorgabe) {
      setFrage(vorgabe);
      void stelle(vorgabe);
    }
  }, [vorgabe]);

  const zeigeBeleg = (n: number) => {
    setMarkiert(n);
    const el = document.getElementById(`beleg-${n}`);
    if (el) {
      el.scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'nearest' });
      el.focus({ preventScroll: true });
    }
  };

  const kopieren = async () => {
    if (!antwort) return;
    const text = [
      gestellt,
      '',
      ...antwort.punkte.map((p) => `- ${p.text} ${p.belege.map((b) => `[${b}]`).join('')}`),
      '',
      ...antwort.belege.map((b, i) => `[${i + 1}] ${b.quelle}, ${b.abschnitt}, ${zeilenText(b.zeilen)}: „${b.zitat}“`),
    ].join('\n');
    try {
      await navigator.clipboard.writeText(text);
      setKopiert(true);
      setTimeout(() => setKopiert(false), 2000);
    } catch {
      setKopiert(false);
    }
  };
  const [kopiert, setKopiert] = useState(false);

  const testmodus = einstellungen?.provider.art === 'mock';
  const belege = antwort?.belege ?? [];

  return (
    <div class="seite seite--fragen">
      <Seitenkopf titel="Fragen" unterzeile="Frag euer Wissen. Jede Antwort zeigt, wo sie steht." />

      <div class={`fragen-raster${belege.length ? ' mit-quellen' : ''}`}>
        <section class="karte frage-karte" aria-labelledby="frage-titel">
          <form
            class="frage-form"
            onSubmit={(e) => {
              e.preventDefault();
              void stelle();
            }}
          >
            <h2 id="frage-titel" class="sr-only">
              Frage stellen
            </h2>
            <label for="frage-eingabe" class="feld-label">
              Deine Frage
            </label>
            <div class={`frage-feld${eingabeFehler ? ' feld--fehler' : ''}`}>
              <textarea
                id="frage-eingabe"
                class="eingabe frage-eingabe"
                rows={2}
                placeholder="Zum Beispiel: Wie viel Anzahlung nehmen wir bei Einbauküchen?"
                value={frage}
                aria-describedby={eingabeFehler ? 'frage-fehler frage-hilfe' : 'frage-hilfe'}
                aria-invalid={eingabeFehler ? 'true' : undefined}
                onInput={(e) => setFrage((e.target as HTMLTextAreaElement).value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
                    e.preventDefault();
                    void stelle();
                  }
                }}
              />
              <Knopf art="primaer" type="submit" laedt={laedt} iconRechts="pfeil" klasse="frage-senden">
                Fragen
              </Knopf>
            </div>
            {eingabeFehler && (
              <p class="feld-fehler" id="frage-fehler">
                <Icon name="warnung" groesse={16} /> {eingabeFehler}
              </p>
            )}
            <p class="feld-hilfe" id="frage-hilfe">
              Enter schickt ab, Umschalt + Enter macht eine neue Zeile.
            </p>

            <div class="suchbereich">
              <div class="feld feld--kompakt">
                <label class="feld-label" for="frage-sammlung">
                  Worin suchen?
                </label>
                <div class="auswahl">
                  <select id="frage-sammlung" class="eingabe" value={sammlung} onChange={(e) => setSammlung((e.target as HTMLSelectElement).value)}>
                    <option value="">Überall</option>
                    {sammlungen.map((s) => (
                      <option key={s} value={s}>
                        {s}
                      </option>
                    ))}
                  </select>
                  <Icon name="pfeilRunter" groesse={16} klasse="auswahl-pfeil" />
                </div>
              </div>
              <Segment name="reichweite" legende="Reichweite" wert={reichweite} optionen={REICHWEITEN} aendern={setReichweite} />
            </div>
            <label class="schalter-zeile schalter-zeile--block erst-ich-schalter">
              <input type="checkbox" class="schalter" checked={erstIch} onChange={(e) => setErstIch((e.target as HTMLInputElement).checked)} />
              <span>
                <span class="schalter-titel">Erst du, dann ich</span>
                <span class="feld-hilfe">Du schreibst zuerst, was du denkst. {PRODUKT} zeigt danach nur, was dir fehlt oder was dagegen spricht.</span>
              </span>
            </label>
            {erstIch && (
              <div class={`feld${eigeneFehler ? ' feld--fehler' : ''}`}>
                <label class="feld-label" for="eigene-einschaetzung">
                  Deine Einschätzung <span class="feld-pflicht">(Pflicht)</span>
                </label>
                <textarea
                  id="eigene-einschaetzung"
                  class="eingabe"
                  rows={3}
                  placeholder="Zum Beispiel: Ich würde 30 % Anzahlung nehmen und erst danach bestellen."
                  value={eigene}
                  aria-invalid={eigeneFehler ? 'true' : undefined}
                  aria-describedby={eigeneFehler ? 'eigene-fehler' : undefined}
                  onInput={(e) => setEigene((e.target as HTMLTextAreaElement).value)}
                />
                {eigeneFehler && (
                  <p class="feld-fehler" id="eigene-fehler">
                    <Icon name="warnung" groesse={16} /> {eigeneFehler}
                  </p>
                )}
              </div>
            )}
          </form>

          <div class="antwort-bereich" aria-live="polite" aria-busy={laedt ? 'true' : 'false'}>
            {!antwort && !laedt && !fehler && (
              <div class="beispiele">
                <p class="beispiele-titel">
                  <Icon name="lampe" groesse={18} /> Probier zum Beispiel
                </p>
                <ul>
                  {beispiele.map((b) => (
                    <li key={b.frage}>
                      <button
                        type="button"
                        class="beispiel"
                        onClick={() => {
                          setFrage(b.frage);
                          void stelle(b.frage);
                        }}
                      >
                        <span class="beispiel-wer">{b.wer}</span>
                        <span class="beispiel-frage">{b.frage}</span>
                        {b.marke && <span class={`beispiel-marke${b.marke.startsWith('Gehört') ? ' fremd' : ''}`}>{b.marke}</span>}
                      </button>
                    </li>
                  ))}
                </ul>
                {!artikelListe.length && !MOCK && (
                  <p class="klein-text">
                    Noch ist kein Wissen da. <a href="#/hinzufuegen">Leg die ersten Dokumente an</a>, dann kann {PRODUKT} antworten.
                  </p>
                )}
              </div>
            )}

            {laedt && (
              <div class="antwort-laedt" role="status">
                <p class="antwort-gefragt">{gestellt}</p>
                <p class="laedt-text">
                  <span class="puls" aria-hidden="true" /> {PRODUKT} sucht in eurem Wissen und prüft die Belege …
                </p>
                <Skelett zeilen={4} />
              </div>
            )}

            {fehler && <Fehlerhinweis titel="Die Antwort konnte nicht geladen werden." text={fehler} nochmal={() => void stelle(gestellt)} />}

            {antwort && (
              <div class={`antwort antwort--${antwort.status}`} tabIndex={-1} ref={antwortRef} aria-label="Antwort">
                <div class="antwort-kopf">
                  <span class="avatar" aria-hidden="true">
                    {initial(ich.name)}
                  </span>
                  <div>
                    <p class="antwort-wer">{ich.name}</p>
                    <p class="antwort-frage">
                      <span class="sr-only">Deine Frage: </span>
                      {gestellt}
                    </p>
                    <p class="antwort-meta">
                      gesucht in {sammlung || 'allem'} · Reichweite {REICHWEITEN.find((x) => x.wert === reichweite)?.text}
                      {testmodus ? ' · Testmodus' : ''}
                    </p>
                  </div>
                </div>

                {abgleich && (
                  <div class="abgleich-rahmen">
                    <AbgleichListe titel="Fehlt dir" punkte={abgleich.fehlt} art="fehlt" />
                    <AbgleichListe titel="Widerspricht dir" punkte={abgleich.widerspricht} art="widerspricht" />
                    <p class="abgleich-gleich">
                      <Icon name="haken" groesse={16} /> Stimmt mit dir überein: {abgleich.uebereinstimmend_anzahl} {abgleich.uebereinstimmend_anzahl === 1 ? 'Punkt' : 'Punkte'}
                    </p>
                  </div>
                )}

                {antwort.status === 'beantwortet' && (
                  <details class="ganze-antwort" open={!abgleich}>
                    <summary class={abgleich ? 'abschnitt-titel' : 'sr-only'}>Ganze Antwort zeigen</summary>
                    <ul class="antwort-punkte">
                      {antwort.punkte.map((p, i) => (
                        <li key={i}>
                          <span class="antwort-text">{p.text}</span>{' '}
                          {p.gestuetzt && p.gestuetzt !== 'ja' && <span class="gestuetzt-hinweis">{p.gestuetzt === 'teilweise' ? 'nur teilweise belegt' : 'Beleg unklar'}</span>}{' '}
                          {p.belege.map((b) => (
                            <button
                              type="button"
                              key={b}
                              class={`beleg-marke${markiert === b ? ' aktiv' : ''}`}
                              onClick={() => zeigeBeleg(b)}
                              aria-label={`Beleg ${b}: ${belege[b - 1]?.abschnitt ?? ''}`}
                            >
                              {b}
                            </button>
                          ))}
                        </li>
                      ))}
                    </ul>
                    {/* Der Kennzeichnungssatz steht genau einmal, im Fuß; derselbe Satz als Hinweis entfällt hier */}
                    {antwort.hinweis && antwort.hinweis !== kiHinweis(antwort, einstellungen?.provider) && <p class="antwort-hinweis">{antwort.hinweis}</p>}
                  </details>
                )}

                {antwort.status === 'steht_nicht_drin' && (
                  <div class="antwort-leer">
                    <div class="antwort-leer-zeichen" aria-hidden="true">
                      <Icon name="suche" groesse={22} />
                    </div>
                    <div>
                      <h2 class="antwort-leer-titel">Dazu steht nichts drin.</h2>
                      <p>{antwort.hinweis || `In dem, was du sehen darfst, gibt es dazu keine Fundstelle. ${PRODUKT} rät nicht.`}</p>
                      <div class="knopf-reihe">
                        {reichweite !== 'betrieb' && (
                          <Knopf klein icon="betrieb" onClick={() => void stelle(gestellt, { reichweite: 'betrieb' })}>
                            Im ganzen Betrieb suchen
                          </Knopf>
                        )}
                        {darf.vorschlagen(ich) && (
                          <KnopfLink klein icon="hinzufuegen" href={href('hinzufuegen', { art: 'text', titel: gestellt })}>
                            Wissen dazu aufschreiben
                          </KnopfLink>
                        )}
                      </div>
                    </div>
                  </div>
                )}

                {antwort.status === 'gehoert_nicht_hierher' && (
                  <div class="antwort-leer antwort-leer--fremd">
                    <div class="antwort-leer-zeichen" aria-hidden="true">
                      <Icon name="schild" groesse={22} />
                    </div>
                    <div>
                      <h2 class="antwort-leer-titel">Das gehört nicht hierher.</h2>
                      <p>{antwort.hinweis}</p>
                    </div>
                  </div>
                )}

                <div class="antwort-fuss">
                  <p class="antwort-warnung">
                    <strong class="ki-kennzeichen">{kiHinweis(antwort, einstellungen?.provider)}</strong> Antworten können trotzdem Fehler enthalten. Prüf die Belege.
                  </p>
                  <div class="knopf-reihe">
                    {antwort.status === 'beantwortet' && (
                      <Knopf klein icon={kopiert ? 'haken' : 'kopieren'} onClick={kopieren}>
                        {kopiert ? 'Kopiert' : 'Kopieren'}
                      </Knopf>
                    )}
                    {belege.length > 0 && <span class="meta-klein mono">{belege.length} {belege.length === 1 ? 'Fundstelle' : 'Fundstellen'}</span>}
                    <Knopf klein art="leise" icon="warnung" onClick={() => setFehlerOffen(true)}>
                      Das ist falsch
                    </Knopf>
                    <Knopf
                      klein
                      art="leise"
                      icon="neu"
                      onClick={() => {
                        setAntwort(null);
                        setFrage('');
                        document.getElementById('frage-eingabe')?.focus();
                      }}
                    >
                      Neue Frage
                    </Knopf>
                  </div>
                </div>
              </div>
            )}
          </div>

          {testmodus && (
            <div class="testmodus">
              <Hinweis titel="Testmodus ohne KI">
                <p>
                  {PRODUKT} antwortet gerade ohne Sprachmodell, nur mit wörtlichen Sätzen aus den besten Fundstellen.{' '}
                  {darf.verwalten(ich) ? <a href="#/einstellungen/ki">KI-Anbieter einstellen</a> : `Die Person, die ${PRODUKT} verwaltet, kann einen KI-Anbieter einstellen.`}
                </p>
              </Hinweis>
            </div>
          )}
        </section>

        {belege.length > 0 && (
          <aside class="quellen-spalte" aria-labelledby="quellen-titel">
            <h2 id="quellen-titel" class="quellen-titel">
              <Icon name="dokumente" groesse={18} /> Quellen <span class="zahl">{belege.length}</span>
            </h2>
            <ol class="quellen-liste">
              {belege.map((b, i) => (
                <li key={i} id={`beleg-${i + 1}`} tabIndex={-1} class={`quelle-karte${markiert === i + 1 ? ' aktiv' : ''}`}>
                  <div class="quelle-kopf">
                    <span class="beleg-nummer" aria-hidden="true">
                      {i + 1}
                    </span>
                    <div>
                      <p class="quelle-titel">
                        <span class="sr-only">Beleg {i + 1}: </span>
                        {titelFuer(b, titel)}
                        {b.web && <span class="chip chip--warn quelle-web">Webseite</span>}
                      </p>
                      <p class="quelle-abschnitt">{b.abschnitt}</p>
                    </div>
                  </div>
                  <p class="quelle-status mono">
                    {kopfVon.get(b.quelle) ? (
                      <>
                        <Icon name={kopfVon.get(b.quelle)!.status === 'freigegeben' ? 'haken' : 'warnung'} groesse={13} />{' '}
                        {kopfVon.get(b.quelle)!.status === 'freigegeben' ? 'freigegeben' : kopfVon.get(b.quelle)!.status} · Stand {datum(kopfVon.get(b.quelle)!.stand)}
                      </>
                    ) : (
                      'Dokument, unverändert'
                    )}{' '}
                    · {zeilenText(b.zeilen)}
                  </p>
                  <blockquote class="zitat">
                    <p>
                      <mark>{b.zitat}</mark>
                    </p>
                  </blockquote>
                  <p class="quelle-pfad" title={b.quelle}>
                    {bereichVon(b.quelle) === 'quellen' ? 'Dokument' : 'Wissen'} · {b.quelle}
                  </p>
                  <a class="quelle-oeffnen" href={href('fundstelle', { pfad: b.quelle, von: b.zeilen[0], bis: b.zeilen[1], zitat: b.zitat.slice(0, 300) })}>
                    Fundstelle öffnen <Icon name="pfeil" groesse={16} />
                  </a>
                </li>
              ))}
            </ol>
          </aside>
        )}
      </div>

      <Dialog
        offen={fehlerOffen}
        schliessen={() => setFehlerOffen(false)}
        titel="Das ist falsch"
        beschreibung={`Deine Meldung kommt ins Fehlerbuch und wird eine Prüffrage. So merkt ${PRODUKT}, wenn dieselbe falsche Antwort wiederkommt.`}
      >
        <form
          class="formular"
          onSubmit={async (e) => {
            e.preventDefault();
            if (!antwort) return;
            setMeldet(true);
            try {
              await api.meldeFehler({
                art: antwort.status === 'steht_nicht_drin' ? 'fehlende_antwort' : 'falsche_antwort',
                frage: gestellt,
                bezug: null,
                falsch: antwort.punkte.map((p) => p.text).join(' ') || antwort.hinweis,
                richtig: richtig.trim() || null,
                fundstelle: antwort.belege[0] ? `${antwort.belege[0].quelle}#${antwort.belege[0].zeilen.join('-')}` : null,
              });
              melde('Danke. Die Meldung steht im Fehlerbuch.');
              setFehlerOffen(false);
              setRichtig('');
            } catch (err) {
              melde(fehlerText(err), 'fehler');
            } finally {
              setMeldet(false);
            }
          }}
        >
          <div class="zitat zitat--klein">
            <p>{antwort ? antwort.punkte.map((p) => p.text).join(' ') || antwort.hinweis : ''}</p>
          </div>
          <Feld label="Was stimmt stattdessen?" hilfe="Optional. In deinen Worten, gern mit Fundstelle.">
            {(p) => <textarea {...p} class="eingabe" rows={3} value={richtig} onInput={(e) => setRichtig((e.target as HTMLTextAreaElement).value)} />}
          </Feld>
          <div class="knopf-reihe knopf-reihe--ende">
            <Knopf art="leise" onClick={() => setFehlerOffen(false)}>
              Abbrechen
            </Knopf>
            <Knopf art="primaer" type="submit" laedt={meldet} icon="haken">
              Melden
            </Knopf>
          </div>
        </form>
      </Dialog>
    </div>
  );
}
