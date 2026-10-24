import { useEffect, useState } from 'preact/hooks';
import { api } from '../api';
import type { Antwort, Einrichtung, Einstellungen, KiVoreinstellung, KiWeg } from '../api/types';
import { darf, useApp } from '../kontext';
import { fehlerText, useLaden } from '../lib/laden';
import { fundstelleHref } from '../lib/artikel';
import { zeilenText } from '../lib/fundstelle';
import { PRODUKT } from '../produkt';
import { kiHinweis } from '../lib/kennzeichnung';
import { Icon } from '../ui/Icon';
import { Feld, Fehlerhinweis, Hinweis, Knopf, Laedt } from '../ui/teile';

// Der 5-Minuten-Weg: eigene KI anbinden oder ersten Kontext hochladen, dann die erste Frage mit Beleg.
// Jeder Schritt lässt sich überspringen; nichts davon ist endgültig.

/** Wege nach CONTRACT v1.4 4.1. „hd_test“ nur, wenn der Server es anbietet ([S-1]). */
const WEGE: { id: KiWeg; titel: string; unter: string }[] = [
  { id: 'hd_test', titel: 'Test-KI von HD', unter: 'Sofort los, ohne eigenes Konto. EU-Modell, läuft über Heidrich Digital als Unterauftragsverarbeiter. Nur in der Testphase.' },
  { id: 'eigener_schluessel', titel: 'Eigener Anbieter', unter: 'Mistral, IONOS, STACKIT, Scaleway mit eurem Schlüssel, oder ein lokales Modell. EU zuerst.' },
  { id: 'app', titel: 'Über deine KI-App', unter: 'Claude, ChatGPT oder Le Chat verbinden sich per MCP und arbeiten mit eurem Wissen.' },
  { id: 'ohne', titel: 'Erst ohne KI', unter: 'Antworten sind wörtliche Auszüge mit Fundstelle. Jederzeit umstellbar.' },
];

const REGION_TEXT: Record<KiVoreinstellung['region'], string> = { eu: 'EU', lokal: 'lokal', usa: 'USA', unbekannt: 'Region unbekannt' };

export function F12Hinweis() {
  return (
    <p class="hinweis hinweis--warnung f12" role="note">
      <Icon name="info" groesse={20} />
      <span>
        Was dieses Programm über MCP abruft (Suchtreffer, Artikel, Antworten, die du sehen darfst), geht an den Anbieter dieses Programms und landet im Kontext seines Modells. {PRODUKT} kann das nur über die Rechte dieses Zugangs begrenzen.
      </span>
    </p>
  );
}

function Schrittleiste({ schritte, aktiv, fertig }: { schritte: { id: number; titel: string }[]; aktiv: number; fertig: Set<number> }) {
  return (
    <ol class="start-leiste" aria-label="Fortschritt">
      {schritte.map((s, i) => {
        const zustand = fertig.has(s.id) ? 'fertig' : s.id === aktiv ? 'aktiv' : 'offen';
        return (
          <li key={s.id} class={`start-schritt start-schritt--${zustand}`} aria-current={s.id === aktiv ? 'step' : undefined}>
            <span class="start-nummer" aria-hidden="true">
              {zustand === 'fertig' ? <Icon name="haken" groesse={16} /> : i + 1}
            </span>
            <span class="start-schritt-titel">
              {s.titel}
              <span class="sr-only">{zustand === 'fertig' ? ', erledigt' : zustand === 'aktiv' ? ', aktuell' : ''}</span>
            </span>
          </li>
        );
      })}
    </ol>
  );
}

function KiSchritt({ e, ein, weiter }: { e: Einstellungen; ein: Einrichtung; weiter: (text: string) => void }) {
  const managed = !!e.managed;
  const liste = (e.voreinstellungen ?? []).filter((v) => v.id !== 'hd_test' && (!managed || v.managed_erlaubt));
  const wege = WEGE.filter((w) => w.id !== 'hd_test' || ein.test_ki_verfuegbar);
  const [weg, setWeg] = useState<KiWeg>(wege[0].id);
  const [vid, setVid] = useState<string>(liste.find((v) => v.region === 'eu')?.id ?? liste[0]?.id ?? '');
  const [url, setUrl] = useState('');
  const [modell, setModell] = useState('');
  const [schluessel, setSchluessel] = useState('');
  const [ergebnis, setErgebnis] = useState<{ ok: boolean; text: string } | null>(null);
  const [laedt, setLaedt] = useState(false);
  const [fehler, setFehler] = useState<Record<string, string>>({});
  const [kopiert, setKopiert] = useState(false);
  const v = liste.find((x) => x.id === vid);
  const lokal = v?.region === 'lokal';
  const mcpUrl = `${location.origin}${location.pathname.replace(/[^/]*$/, '')}mcp`;

  useEffect(() => {
    setErgebnis(null);
    setFehler({});
    setUrl(v?.url ?? '');
    setModell(v?.chatModelle[0] ?? '');
  }, [vid, weg]);

  const senden = async (ev: Event) => {
    ev.preventDefault();
    const f: Record<string, string> = {};
    if (weg === 'eigener_schluessel') {
      if (!v) f.vid = 'Wähl einen Anbieter.';
      if (lokal && !/^https?:\/\//.test(url)) f.url = 'Die Adresse muss mit http:// oder https:// anfangen.';
      if (!lokal && !schluessel.trim()) f.schluessel = 'Ohne Schlüssel antwortet der Anbieter nicht.';
    }
    setFehler(f);
    if (Object.keys(f).length) return;
    setLaedt(true);
    setErgebnis(null);
    try {
      const r = await api.einrichtungKi(
        weg === 'eigener_schluessel' ? { weg, voreinstellung: vid, ...(lokal ? { url } : {}), chatModell: modell || undefined, schluessel: schluessel || undefined } : { weg },
      );
      setErgebnis({ ok: r.verbindung === 'ok', text: r.meldung });
      if (r.verbindung === 'ok') {
        setSchluessel('');
        weiter(weg === 'eigener_schluessel' ? `${v?.name ?? 'Anbieter'} verbunden` : weg === 'hd_test' ? 'Test-KI von HD verbunden' : weg === 'app' ? 'KI-App über MCP' : 'Ohne KI');
      }
    } catch (err) {
      setErgebnis({ ok: false, text: fehlerText(err) });
    } finally {
      setLaedt(false);
    }
  };

  return (
    <form class="formular" onSubmit={senden} noValidate>
      <fieldset class="formular-gruppe">
        <legend class="feld-label">Wer soll die Fragen beantworten?</legend>
        <div class="weg-karten">
          {wege.map((w) => (
            <label key={w.id} class={`weg-karte${weg === w.id ? ' aktiv' : ''}`}>
              <input type="radio" name="weg" value={w.id} checked={weg === w.id} onChange={() => setWeg(w.id)} />
              <span class="weg-titel">{w.titel}</span>
              <span class="weg-unter">{w.unter}</span>
            </label>
          ))}
        </div>
      </fieldset>

      {weg === 'eigener_schluessel' && (
        <>
          <Feld label="Anbieter" fehler={fehler.vid} hilfe={v ? `Region: ${REGION_TEXT[v.region]}.${managed ? ' Lokale Modelle gehen mit der selbst gehosteten Fassung.' : ''}` : undefined}>
            {(p) => (
              <div class="auswahl">
                <select {...p} class="eingabe" value={vid} onChange={(x) => setVid((x.target as HTMLSelectElement).value)}>
                  {liste.map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.name} ({REGION_TEXT[a.region]})
                    </option>
                  ))}
                </select>
                <Icon name="pfeilRunter" groesse={16} klasse="auswahl-pfeil" />
              </div>
            )}
          </Feld>
          {lokal && (
            <Feld label="Adresse" fehler={fehler.url} hilfe="Standard für Ollama. Läuft es auf einem anderen Rechner, dessen Adresse eintragen.">
              {(p) => <input {...p} class="eingabe mono" type="url" value={url} onInput={(x) => setUrl((x.target as HTMLInputElement).value)} />}
            </Feld>
          )}
          <div class="feld-reihe">
            <Feld label="Modell" hilfe="Vorgeschlagen ist das, was wir mit der Prüfbank getestet haben.">
              {(p) => (
                <input {...p} class="eingabe" type="text" list="modelle" value={modell} onInput={(x) => setModell((x.target as HTMLInputElement).value)} />
              )}
            </Feld>
            {!lokal && (
              <Feld label="API-Schlüssel" fehler={fehler.schluessel} hilfe="Wird verschlüsselt gespeichert und nie wieder angezeigt. Nach einem Umzug neu eingeben.">
                {(p) => <input {...p} class="eingabe" type="password" autocomplete="off" value={schluessel} onInput={(x) => setSchluessel((x.target as HTMLInputElement).value)} />}
              </Feld>
            )}
          </div>
          <datalist id="modelle">
            {v?.chatModelle.map((m) => (
              <option key={m} value={m} />
            ))}
          </datalist>
          {v?.region === 'usa' && (
            <Hinweis art="warnung" icon="warnung" titel="Anbieter außerhalb der EU">
              <p>Fragen und gefundene Abschnitte gehen an Server in den USA. Klärt vorher den Vertrag zur Auftragsverarbeitung.</p>
            </Hinweis>
          )}
        </>
      )}

      {weg === 'app' && (
        <div class="app-weg">
          <p>Trag diese Adresse in deiner KI-App als MCP-Server ein. Die App meldet sich selbst an (OAuth); du bestätigst einmal, was sie darf.</p>
          <div class="kopier-zeile">
            <code class="token mono">{mcpUrl}</code>
            <Knopf klein icon={kopiert ? 'haken' : 'kopieren'} onClick={() => navigator.clipboard.writeText(mcpUrl).then(() => setKopiert(true), () => undefined)}>
              {kopiert ? 'Kopiert' : 'Kopieren'}
            </Knopf>
          </div>
          <F12Hinweis />
        </div>
      )}

      {ergebnis && (
        <p class={`ki-test ki-test--${ergebnis.ok ? 'ok' : 'fehler'}`} role="status">
          <Icon name={ergebnis.ok ? 'haken' : 'warnung'} groesse={18} />
          <span>{ergebnis.text}</span>
        </p>
      )}

      <div class="knopf-reihe">
        <Knopf art="primaer" type="submit" laedt={laedt} icon={weg === 'eigener_schluessel' ? 'schloss' : 'pfeil'}>
          {weg === 'eigener_schluessel' ? 'Verbindung prüfen und speichern' : weg === 'ohne' ? 'Ohne KI weiter' : 'Weiter'}
        </Knopf>
      </div>
    </form>
  );
}

function WissenSchritt({ weiter }: { weiter: (text: string, beispiel: boolean, titel?: string) => void }) {
  const { ich, einstellungen, ladeZaehler, ladeArtikelListe } = useApp();
  const [dateien, setDateien] = useState<File[]>([]);
  const [text, setText] = useState('');
  const [laedt, setLaedt] = useState<'' | 'eigen' | 'beispiel'>('');
  const [fehler, setFehler] = useState<string | null>(null);
  const [ziehen, setZiehen] = useState(false);
  const sammlung = einstellungen?.sammlungen?.[0] ?? 'Grundlagen';

  const hochladen = async () => {
    if (!dateien.length && !text.trim()) return setFehler('Wähl mindestens eine Datei oder füg einen Text ein.');
    setFehler(null);
    setLaedt('eigen');
    try {
      let titel = '';
      for (const d of dateien) {
        const r = await api.hinzufuegen({ art: 'datei', datei: d, titel: d.name.replace(/\.[^.]+$/, ''), sammlung, sichtbarkeit: 'betrieb' });
        titel ||= r.quelle.kopf.titel;
      }
      if (text.trim()) {
        const t = text.trim().split('\n')[0].slice(0, 60);
        const r = await api.hinzufuegen({ art: 'text', titel: t, inhalt: text.trim(), sammlung, sichtbarkeit: 'betrieb' });
        titel ||= r.quelle.kopf.titel;
      }
      ladeZaehler();
      ladeArtikelListe();
      const n = dateien.length + (text.trim() ? 1 : 0);
      weiter(`${n} ${n === 1 ? 'Dokument' : 'Dokumente'} hinzugefügt`, false, titel);
    } catch (err) {
      setFehler(fehlerText(err));
    } finally {
      setLaedt('');
    }
  };

  const beispiel = async () => {
    setFehler(null);
    setLaedt('beispiel');
    try {
      await api.einrichtungBeispiel('laden');
      ladeZaehler();
      ladeArtikelListe();
      weiter('Beispiel Tischlerei Wendt geladen', true);
    } catch (err) {
      setFehler(fehlerText(err));
    } finally {
      setLaedt('');
    }
  };

  const nimm = (l: FileList | null) => l && setDateien((d) => [...d, ...Array.from(l)].slice(0, 20));

  return (
    <div class="wissen-wege">
      <section class="wissen-weg" aria-labelledby="ww-eigen">
        <h3 id="ww-eigen" class="weg-titel">
          Eigene Dokumente
        </h3>
        <p class="klein-text">PDF, Word, Markdown oder Text. Alles wird zuerst eine Quelle; Vorschläge für Artikel landen im Eingang, bis jemand freigibt.</p>
        <div
          class={`ablage ablage--klein${ziehen ? ' ziehen' : ''}`}
          onDragOver={(e) => {
            e.preventDefault();
            setZiehen(true);
          }}
          onDragLeave={() => setZiehen(false)}
          onDrop={(e) => {
            e.preventDefault();
            setZiehen(false);
            nimm(e.dataTransfer?.files ?? null);
          }}
        >
          <Icon name="hochladen" groesse={26} />
          <p class="ablage-titel">Dateien hierher ziehen</p>
          <label class="ablage-waehlen">
            oder Dateien auswählen
            <input type="file" multiple class="sr-only" accept=".pdf,.docx,.md,.txt,.html,.htm" onChange={(e) => nimm((e.target as HTMLInputElement).files)} />
          </label>
        </div>
        {!!dateien.length && (
          <ul class="datei-liste">
            {dateien.map((d, i) => (
              <li key={i}>
                <Icon name="dokumente" groesse={16} />
                <span class="umbruch">{d.name}</span>
                <button type="button" class="symbol-knopf" aria-label={`${d.name} entfernen`} onClick={() => setDateien((x) => x.filter((_, j) => j !== i))}>
                  <Icon name="schliessen" groesse={16} />
                </button>
              </li>
            ))}
          </ul>
        )}
        <Feld label="Oder Text einfügen" hilfe="Zum Beispiel eine Arbeitsanweisung, eine Preisliste oder eine Mail mit einer Absprache.">
          {(p) => <textarea {...p} class="eingabe" rows={4} value={text} onInput={(x) => setText((x.target as HTMLTextAreaElement).value)} />}
        </Feld>
        <Knopf art="primaer" icon="hochladen" laedt={laedt === 'eigen'} onClick={hochladen}>
          Hinzufügen
        </Knopf>
      </section>
      {darf.verwalten(ich) && (
        <section class="wissen-weg wissen-weg--beispiel" aria-labelledby="ww-beispiel">
          <h3 id="ww-beispiel" class="weg-titel">
            Erst mit einem Beispiel
          </h3>
          <p class="klein-text">
            Tischlerei Wendt ist ein erfundener Betrieb mit Artikeln, Dokumenten, Fakten und offenen Vorschlägen. So siehst du, wie {PRODUKT} nach ein paar Wochen aussieht.
          </p>
          <p class="meta-klein">Das Beispiel ist gekennzeichnet und lässt sich unter Einstellungen mit einem Klick wieder entfernen.</p>
          <Knopf icon="ordner" laedt={laedt === 'beispiel'} onClick={beispiel}>
            Beispiel laden
          </Knopf>
        </section>
      )}
      {fehler && <Fehlerhinweis text={fehler} />}
    </div>
  );
}

function FrageSchritt({ titel, fertig }: { titel?: string; fertig: () => void }) {
  const { einstellungen } = useApp();
  const ein = useLaden(() => api.einrichtung(), []);
  const vorschlaege = ein.daten?.vorschlagsfragen.length ? ein.daten.vorschlagsfragen.slice(0, 3) : titel ? [`Worum geht es in „${titel}“?`] : [];
  useEffect(() => {
    if (vorschlaege[0] && !frage) setFrage(vorschlaege[0]);
  }, [ein.daten]);
  const [frage, setFrage] = useState('');
  const [antwort, setAntwort] = useState<Antwort | null>(null);
  const [laedt, setLaedt] = useState(false);
  const [fehler, setFehler] = useState<string | null>(null);
  const fragen = async (ev: Event) => {
    ev.preventDefault();
    if (!frage.trim()) return setFehler('Schreib eine Frage.');
    setFehler(null);
    setLaedt(true);
    try {
      setAntwort(await api.frage(frage.trim()));
    } catch (err) {
      setFehler(fehlerText(err));
    } finally {
      setLaedt(false);
    }
  };
  const b = antwort?.belege[0];
  return (
    <div>
      <form class="formular" onSubmit={fragen} noValidate>
        <Feld label="Deine erste Frage" fehler={fehler}>
          {(p) => <textarea {...p} class="eingabe frage-feld" rows={2} value={frage} onInput={(x) => setFrage((x.target as HTMLTextAreaElement).value)} />}
        </Feld>
        {vorschlaege.filter((v) => v !== frage).length > 0 && (
          <div class="chip-reihe" aria-label="Andere Fragen zum Ausprobieren">
            {vorschlaege.filter((v) => v !== frage).map((v) => (
              <button key={v} type="button" class="chip chip--knopf" onClick={() => setFrage(v)}>
                {v}
              </button>
            ))}
          </div>
        )}
        <div class="knopf-reihe">
          <Knopf art="primaer" type="submit" laedt={laedt} icon="fragen">
            Fragen
          </Knopf>
        </div>
      </form>
      {antwort && (
        <section class="start-antwort" aria-live="polite" aria-labelledby="sa-titel">
          <h3 id="sa-titel" class="abschnitt-titel">
            {antwort.status === 'beantwortet' ? 'Antwort mit Beleg' : 'Dazu steht nichts drin'}
          </h3>
          {antwort.status === 'beantwortet' ? (
            <>
              <ul class="antwort-punkte">
                {antwort.punkte.map((p, i) => (
                  <li key={i}>
                    <span class="antwort-text">{p.text}</span>{' '}
                    {p.belege.map((n) => (
                      <span key={n} class="beleg-marke-still mono">
                        [{n}]
                      </span>
                    ))}
                  </li>
                ))}
              </ul>
              {b && (
                <div class="punkt-beleg">
                  <blockquote class="zitat">
                    <p>
                      <mark>{b.zitat}</mark>
                    </p>
                  </blockquote>
                  <p class="quelle-ort">
                    [1] {b.abschnitt} · {zeilenText(b.zeilen)}
                  </p>
                  <a class="quelle-oeffnen" href={fundstelleHref(b)}>
                    Stelle im Original ansehen <Icon name="pfeil" groesse={16} />
                  </a>
                </div>
              )}
            </>
          ) : (
            <p>{PRODUKT} rät nicht. Wenn es in den Dokumenten nicht steht, sagt es das. Versuch eine Frage, die sich aus dem Hochgeladenen beantworten lässt.</p>
          )}
          <p class="antwort-warnung">
            <strong class="ki-kennzeichen">{kiHinweis(antwort, einstellungen?.provider)}</strong> Prüf die Belege.
          </p>
          <div class="knopf-reihe">
            <Knopf art="primaer" icon="haken" onClick={fertig}>
              Fertig, zu Heute
            </Knopf>
          </div>
        </section>
      )}
    </div>
  );
}

export function ErsteSchritte() {
  const { ich, einstellungen, melde } = useApp();
  const st = useLaden(() => api.einrichtung(), []);
  const admin = darf.verwalten(ich);
  const schritte = [...(admin ? [{ id: 1, titel: 'KI anbinden' }] : []), { id: 2, titel: 'Wissen hinzufügen' }, { id: 3, titel: 'Erste Frage mit Beleg' }];
  const [aktiv, setAktiv] = useState<number>(admin ? 1 : 2);
  const [fertig, setFertig] = useState<Set<number>>(new Set());
  const [notizen, setNotizen] = useState<Record<number, string>>({});
  const [titel, setTitel] = useState<string | undefined>();

  const erledigt = (id: number, text: string) => {
    setFertig((f) => new Set(f).add(id));
    setNotizen((n) => ({ ...n, [id]: text }));
    const naechster = schritte.find((s) => s.id > id && !fertig.has(s.id));
    if (naechster) setAktiv(naechster.id);
  };

  const abschliessen = async () => {
    await api.einrichtungFertig().catch(() => undefined);
    melde('Eingerichtet. Alles lässt sich unter Einstellungen ändern.');
    location.hash = '#/heute';
  };

  return (
    <div class="seite seite--start">
      <header class="start-kopf">
        <div>
          <p class="oberzeile">Erste Schritte · etwa 5 Minuten</p>
          <h1 id="seitentitel" tabIndex={-1}>
            Bis zur ersten belegten Antwort
          </h1>
          <p class="unterzeile">Eigene KI anbinden oder Dokumente hochladen, dann eine Frage stellen. Jede Antwort zeigt, woher sie kommt.</p>
        </div>
        <button type="button" class="text-knopf start-ueberspringen" onClick={abschliessen}>
          Überspringen, ich schaue mich erst um
        </button>
      </header>

      <div class="start-raster">
        <Schrittleiste schritte={schritte} aktiv={aktiv} fertig={fertig} />
        <div class="start-inhalt">
          {schritte.map((s, i) => {
            const offen = s.id === aktiv;
            return (
              <section key={s.id} class={`start-karte${offen ? ' start-karte--offen' : ''}${fertig.has(s.id) ? ' start-karte--fertig' : ''}`} aria-labelledby={`sk-${s.id}`}>
                <div class="start-karte-kopf">
                  <h2 id={`sk-${s.id}`} class="start-karte-titel">
                    <span class="mono start-karte-nr">{String(i + 1).padStart(2, '0')}</span> {s.titel}
                  </h2>
                  {!offen && fertig.has(s.id) && (
                    <span class="start-notiz">
                      <Icon name="haken" groesse={16} /> {notizen[s.id]}
                      <button type="button" class="text-knopf" onClick={() => setAktiv(s.id)}>
                        ändern
                      </button>
                    </span>
                  )}
                  {!offen && !fertig.has(s.id) && s.id < aktiv && (
                    <button type="button" class="text-knopf" onClick={() => setAktiv(s.id)}>
                      nachholen
                    </button>
                  )}
                </div>
                {offen && (
                  <div class="start-karte-rumpf">
                    {s.id === 1 && (einstellungen && st.daten ? <KiSchritt e={einstellungen} ein={st.daten} weiter={(t) => erledigt(1, t)} /> : <Laedt />)}
                    {s.id === 2 && (
                      <WissenSchritt
                        weiter={(t, _b, ti) => {
                          if (ti) setTitel(ti);
                          erledigt(2, t);
                        }}
                      />
                    )}
                    {s.id === 3 && <FrageSchritt titel={titel} fertig={abschliessen} />}
                    {s.id !== 3 && (
                      <button type="button" class="text-knopf start-spaeter" onClick={() => setAktiv(schritte[i + 1]?.id ?? 3)}>
                        Diesen Schritt später machen
                      </button>
                    )}
                  </div>
                )}
              </section>
            );
          })}
        </div>
      </div>
    </div>
  );
}
