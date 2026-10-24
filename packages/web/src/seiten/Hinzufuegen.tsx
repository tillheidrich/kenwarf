import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { PRODUKT } from '../produkt';
import { api } from '../api';
import type { ImportArt, Quelle, QuellenArt, Sichtbarkeit, Vorschlag } from '../api/types';
import { useApp, darf } from '../kontext';
import { fehlerText, useLaden } from '../lib/laden';
import { datum } from '../lib/datum';
import { href, type Route } from '../lib/router';
import { dokumentRoute, teamName } from '../lib/pfade';
import { Icon, type IconName } from '../ui/Icon';
import { Feld, Fehlerhinweis, Knopf, KnopfLink, Leer, Segment, Seitenkopf } from '../ui/teile';

type Reiter = 'datei' | 'text' | 'web' | 'audio' | 'import';

const REITER: { id: Reiter; titel: string; unter: string; icon: IconName }[] = [
  { id: 'datei', titel: 'Datei hochladen', unter: 'PDF, Word, Text, HTML', icon: 'hochladen' },
  { id: 'text', titel: 'Text einfügen', unter: 'Notiz oder kopierter Inhalt', icon: 'text' },
  { id: 'web', titel: 'Aus dem Web', unter: 'Eine Seite, auf Wunsch beobachtet', icon: 'web' },
  { id: 'audio', titel: 'Sprachnotiz', unter: 'Direkt hier aufnehmen', icon: 'mikro' },
  { id: 'import', titel: 'Importieren', unter: 'Obsidian, Notion, Outline …', icon: 'ordner' },
];

const IMPORTE: { art: ImportArt; titel: string; schritte: string[]; datei: string }[] = [
  { art: 'obsidian', titel: 'Obsidian', datei: '.zip', schritte: ['Den Vault-Ordner im Dateimanager öffnen.', 'Den ganzen Ordner als ZIP packen (Rechtsklick, „Komprimieren“).', 'Die ZIP-Datei hier hochladen. Links zwischen Notizen bleiben erhalten.'] },
  { art: 'notion', titel: 'Notion', datei: '.zip', schritte: ['In Notion oben rechts auf „…“, dann „Exportieren“.', 'Format „Markdown & CSV“ wählen, Unterseiten einschließen.', 'Die heruntergeladene ZIP-Datei hier hochladen.'] },
  { art: 'outline', titel: 'Outline', datei: '.zip', schritte: ['In Outline: Einstellungen, dann „Export“.', 'Format Markdown wählen und die Mail mit dem Link abwarten.', 'Die ZIP-Datei hier hochladen.'] },
  { art: 'confluence', titel: 'Confluence', datei: '.zip', schritte: ['Im Bereich: „Bereichseinstellungen“, dann „Bereich exportieren“.', 'HTML-Export wählen.', `Die ZIP-Datei hier hochladen. ${PRODUKT} wandelt HTML in Markdown um.`] },
  { art: 'markdown', titel: 'Markdown-Ordner', datei: '.zip', schritte: ['Den Ordner mit .md-Dateien als ZIP packen.', 'Hier hochladen. Unterordner werden zu Sammlungen.'] },
  { art: 'okf', titel: 'Open Knowledge Format', datei: '.zip', schritte: [`Den OKF-Export als ZIP hochladen, zum Beispiel aus einer anderen ${PRODUKT}-Installation.`] },
];

const KNOPF: Record<Reiter, string> = { datei: 'Datei aufnehmen', text: 'Text speichern', web: 'Seite holen', audio: 'Aufnahme speichern', import: 'Import starten' };

function groesse(b: number) {
  return b > 1024 * 1024 ? `${(b / 1024 / 1024).toFixed(1).replace('.', ',')} MB` : `${Math.max(1, Math.round(b / 1024))} KB`;
}

function zeit(s: number) {
  return `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
}

/** Sprachaufnahme im Browser (MediaRecorder). Ohne Unterstützung bleibt der Datei-Weg. */
function Aufnahme({ fertig }: { fertig: (b: Blob | null) => void }) {
  const kann = typeof navigator !== 'undefined' && !!navigator.mediaDevices?.getUserMedia && typeof MediaRecorder !== 'undefined';
  const [zustand, setZustand] = useState<'bereit' | 'laeuft' | 'fertig' | 'fehler'>('bereit');
  const [sek, setSek] = useState(0);
  const [url, setUrl] = useState<string | null>(null);
  const [meldung, setMeldung] = useState('');
  const rec = useRef<MediaRecorder | null>(null);
  const teile = useRef<Blob[]>([]);
  const uhr = useRef<number>(0);

  useEffect(
    () => () => {
      clearInterval(uhr.current);
      rec.current?.stream.getTracks().forEach((t) => t.stop());
      if (url) URL.revokeObjectURL(url);
    },
    [],
  );

  const start = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const r = new MediaRecorder(stream);
      teile.current = [];
      r.ondataavailable = (e) => e.data.size && teile.current.push(e.data);
      r.onstop = () => {
        stream.getTracks().forEach((t) => t.stop());
        const blob = new Blob(teile.current, { type: r.mimeType || 'audio/webm' });
        if (url) URL.revokeObjectURL(url);
        setUrl(URL.createObjectURL(blob));
        setZustand('fertig');
        fertig(blob);
      };
      rec.current = r;
      r.start();
      setSek(0);
      const t0 = Date.now();
      uhr.current = window.setInterval(() => setSek((Date.now() - t0) / 1000), 250);
      setZustand('laeuft');
      fertig(null);
    } catch {
      setZustand('fehler');
      setMeldung('Das Mikrofon ist gesperrt. Erlaube den Zugriff in den Browser-Einstellungen oder lade eine Audiodatei hoch.');
    }
  };
  const stopp = () => {
    clearInterval(uhr.current);
    rec.current?.stop();
  };

  if (!kann)
    return (
      <p class="hinweis hinweis--info">
        <Icon name="info" groesse={20} />
        <span>Dieser Browser kann nicht direkt aufnehmen. Nimm die Notiz mit dem Handy auf und lade sie unter „Datei hochladen“ hoch.</span>
      </p>
    );
  return (
    <div class={`aufnahme aufnahme--${zustand}`}>
      {zustand !== 'laeuft' ? (
        <button type="button" class="aufnahme-knopf" onClick={start}>
          <Icon name="mikro" groesse={28} />
          <span>{zustand === 'fertig' ? 'Neu aufnehmen' : 'Aufnahme starten'}</span>
        </button>
      ) : (
        <button type="button" class="aufnahme-knopf aufnahme-knopf--stopp" onClick={stopp}>
          <Icon name="stopp" groesse={28} />
          <span>Aufnahme beenden</span>
        </button>
      )}
      <p class="aufnahme-zeit mono" role="timer" aria-live="off">
        {zustand === 'laeuft' && <span class="rec-punkt" aria-hidden="true" />}
        {zeit(sek)}
      </p>
      <p class="sr-only" aria-live="polite">
        {zustand === 'laeuft' ? 'Aufnahme läuft' : zustand === 'fertig' ? `Aufnahme fertig, ${Math.round(sek)} Sekunden` : ''}
      </p>
      {zustand === 'fertig' && url && <audio controls src={url} class="aufnahme-player" aria-label="Aufnahme anhören" />}
      {zustand === 'fehler' && <p class="feld-fehler">{meldung}</p>}
      <p class="feld-hilfe">{PRODUKT} verschriftet die Notiz, wenn auf dem Server eine Spracherkennung eingerichtet ist. Sonst wartet sie im Dokument auf das Transkript.</p>
    </div>
  );
}

const BEOB: Record<string, { text: string; icon: IconName }> = {
  ok: { text: 'Unverändert', icon: 'haken' },
  geaendert: { text: 'Geändert', icon: 'stift' },
  nicht_abrufbar: { text: 'Nicht abrufbar', icon: 'warnung' },
  wartet: { text: 'Wartet auf Abruf', icon: 'uhr' },
};

function Beobachtet() {
  const r = useLaden(() => api.quellen(), []);
  const liste = (r.daten ?? []).filter((q) => q.kopf.beobachtet);
  return (
    <section class="beobachtet" aria-labelledby="beob-titel">
      <div class="beobachtet-kopf">
        <Icon name="verlauf" groesse={20} />
        <div>
          <h2 id="beob-titel">Regelmäßig neue Inhalte erhalten</h2>
          <p>Beobachtete Quellen holt {PRODUKT} von selbst neu. Ändert sich etwas, liegt ein Vorschlag im Eingang.</p>
        </div>
      </div>
      {liste.length ? (
        <ul class="beobachtet-liste">
          {liste.map((q) => (
            <li key={q.pfad} class={`beob-${q.kopf.beobachtung?.status ?? 'wartet'}`}>
              <span class="beob-haupt">
                <a href={href(dokumentRoute(q.pfad))}>{q.kopf.titel}</a>
                <span class="meta-klein">
                  {q.kopf.art === 'web' ? 'Webseite' : 'Datei'} · zuletzt geprüft {datum(q.kopf.beobachtung?.zuletzt_geprueft ?? q.kopf.erfasst_am)}
                </span>
                {q.kopf.beobachtung?.meldung && <span class="beob-meldung">{q.kopf.beobachtung.meldung}</span>}
              </span>
              <span class={`beob-status beob-status--${q.kopf.beobachtung?.status ?? 'wartet'}`}>
                <Icon name={BEOB[q.kopf.beobachtung?.status ?? 'wartet'].icon} groesse={14} />
                {BEOB[q.kopf.beobachtung?.status ?? 'wartet'].text}
              </span>
            </li>
          ))}
        </ul>
      ) : (
        !r.laedt && <p class="klein-text">Noch nichts beobachtet. Wähl „Aus dem Web“ und setz den Haken bei „Beobachten“.</p>
      )}
    </section>
  );
}

export function Hinzufuegen({ route }: { route: Route }) {
  const { ich, einstellungen, artikelListe, ladeZaehler, melde } = useApp();
  const startArt = (route.query.get('art') as Reiter) || 'datei';
  const [reiter, setReiter] = useState<Reiter>(REITER.some((r) => r.id === startArt) ? startArt : 'datei');
  const [datei, setDatei] = useState<File | null>(null);
  const [ziehen, setZiehen] = useState(false);
  const [titel, setTitel] = useState(route.query.get('titel') ?? '');
  const [inhalt, setInhalt] = useState('');
  const [alsNotiz, setAlsNotiz] = useState(false);
  const [url, setUrl] = useState('');
  const [aufnahme, setAufnahme] = useState<Blob | null>(null);
  const [importArt, setImportArt] = useState<ImportArt>('obsidian');
  const [importDatei, setImportDatei] = useState<File | null>(null);
  const [importPfad, setImportPfad] = useState('');
  const [importErgebnis, setImportErgebnis] = useState<{ quellen: number; vorschlaege: number; hinweise?: string[] } | null>(null);
  const sammlungen = useMemo(() => {
    const s = new Set<string>(einstellungen?.sammlungen ?? []);
    for (const a of artikelListe) s.add(a.kopf.gruppe);
    return [...s].filter(Boolean).sort((a, b) => a.localeCompare(b, 'de'));
  }, [einstellungen, artikelListe]);
  const [sammlung, setSammlung] = useState('');
  const [neueSammlung, setNeueSammlung] = useState('');
  const sichtStart = route.query.get('sicht') === 'ich' ? 'ich' : 'betrieb';
  const [sicht, setSicht] = useState<'ich' | 'team' | 'betrieb'>(sichtStart);
  const [team, setTeam] = useState(ich.teams[0] ?? '');
  const [beobachten, setBeobachten] = useState(false);
  const [fehler, setFehler] = useState<Record<string, string>>({});
  const [laedt, setLaedt] = useState(false);
  const [ergebnis, setErgebnis] = useState<{ quelle: Quelle; vorschlaege: Vorschlag[] } | null>(null);
  const [allgemein, setAllgemein] = useState<string | null>(null);
  const dateiRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!sammlung && sammlungen.length) setSammlung(sammlungen[0]);
  }, [sammlungen]);
  useEffect(() => {
    const a = route.query.get('art') as Reiter;
    if (a && REITER.some((r) => r.id === a)) setReiter(a);
  }, [route.query.get('art')]);

  if (!darf.vorschlagen(ich))
    return (
      <div class="seite">
        <Seitenkopf titel="Inhalte hinzufügen" />
        <Leer icon="schloss" titel="Dafür fehlt dir die Rolle">
          <p>Hinzufügen dürfen Autoren, Freigeber und Admins. Frag die Person, die {PRODUKT} bei euch verwaltet. Fragen stellen und lesen kannst du trotzdem.</p>
        </Leer>
      </div>
    );

  const zuruecksetzen = () => {
    setErgebnis(null);
    setDatei(null);
    setInhalt('');
    setTitel('');
    setUrl('');
    setAufnahme(null);
    setFehler({});
    setAllgemein(null);
    setImportErgebnis(null);
    setImportDatei(null);
  };

  const senden = async (e: Event) => {
    e.preventDefault();
    const f: Record<string, string> = {};
    const zielSammlung = sammlung === '__neu' ? neueSammlung.trim() : sammlung;
    if (!zielSammlung) f.sammlung = 'Wähl eine Sammlung oder leg eine neue an.';
    if (reiter === 'datei' && !datei) f.datei = 'Wähl zuerst eine Datei aus.';
    if (reiter === 'text' && !inhalt.trim()) f.inhalt = 'Da steht noch nichts.';
    if (reiter === 'web' && !/^https?:\/\/\S+\.\S+/.test(url.trim())) f.url = 'Gib eine vollständige Adresse ein, zum Beispiel https://www.beispiel.de/seite.';
    if (reiter === 'audio' && !aufnahme) f.audio = 'Nimm zuerst etwas auf.';
    if (reiter === 'import' && !importDatei && !importPfad.trim()) f.import = 'Wähl die Export-Datei aus.';
    if (sicht === 'team' && !team) f.team = 'Du bist in keinem Team. Wähl „Nur ich“ oder „Betrieb“.';
    setFehler(f);
    if (Object.keys(f).length) {
      const erstes = document.querySelector<HTMLElement>('[aria-invalid="true"], .feld--fehler input, .feld--fehler select, .ablage-fehler');
      erstes?.focus();
      return;
    }
    const sichtbarkeit: Sichtbarkeit = sicht === 'team' ? `team:${team}` : sicht;
    setLaedt(true);
    setAllgemein(null);
    if (reiter === 'import') {
      try {
        const r = await api.importieren({ art: importArt, datei: importDatei ?? undefined, pfad: importPfad.trim() || undefined, sammlung: zielSammlung, sichtbarkeit });
        setImportErgebnis(r);
        ladeZaehler();
        setTimeout(() => document.getElementById('ergebnis-titel')?.focus(), 30);
      } catch (err) {
        setAllgemein(fehlerText(err));
      } finally {
        setLaedt(false);
      }
      return;
    }
    const art: QuellenArt = reiter === 'text' && alsNotiz ? 'notiz' : reiter;
    try {
      const r = await api.hinzufuegen({
        art,
        titel: titel.trim() || undefined,
        inhalt: reiter === 'text' ? inhalt : undefined,
        url: reiter === 'web' ? url.trim() : undefined,
        datei: reiter === 'datei' ? (datei ?? undefined) : reiter === 'audio' ? (aufnahme ?? undefined) : undefined,
        dateiname: reiter === 'audio' ? `sprachnotiz-${new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-')}.webm` : undefined,
        sammlung: zielSammlung,
        sichtbarkeit,
        beobachten,
      });
      setErgebnis(r);
      ladeZaehler();
      melde(`„${r.quelle.kopf.titel}“ ist gespeichert.`);
      setTimeout(() => document.getElementById('ergebnis-titel')?.focus(), 30);
    } catch (err) {
      setAllgemein(fehlerText(err));
    } finally {
      setLaedt(false);
    }
  };

  if (importErgebnis)
    return (
      <div class="seite seite--schmal">
        <Seitenkopf titel="Inhalte hinzufügen" />
        <section class="karte ergebnis" aria-labelledby="ergebnis-titel">
          <div class="ergebnis-zeichen" aria-hidden="true">
            <Icon name="haken" groesse={26} />
          </div>
          <h2 id="ergebnis-titel" tabIndex={-1}>
            Import fertig: {importErgebnis.quellen} {importErgebnis.quellen === 1 ? 'Dokument' : 'Dokumente'}
          </h2>
          <p>
            Alles liegt als Dokument unter „Dokumente“. {importErgebnis.vorschlaege} {importErgebnis.vorschlaege === 1 ? 'Vorschlag wartet' : 'Vorschläge warten'} im Eingang. Ins Wissen kommt erst, was jemand freigibt.
          </p>
          {importErgebnis.hinweise?.length ? (
            <ul class="klein-liste">
              {importErgebnis.hinweise.map((h) => (
                <li key={h}>{h}</li>
              ))}
            </ul>
          ) : null}
          <div class="knopf-reihe">
            <KnopfLink art="primaer" href="#/eingang" iconRechts="pfeil">
              Zum Eingang
            </KnopfLink>
            <Knopf art="leise" icon="neu" onClick={zuruecksetzen}>
              Noch etwas hinzufügen
            </Knopf>
          </div>
        </section>
      </div>
    );

  if (ergebnis)
    return (
      <div class="seite seite--schmal">
        <Seitenkopf titel="Inhalte hinzufügen" />
        <section class="karte ergebnis" aria-labelledby="ergebnis-titel">
          <div class="ergebnis-zeichen" aria-hidden="true">
            <Icon name="haken" groesse={26} />
          </div>
          <h2 id="ergebnis-titel" tabIndex={-1}>
            Gespeichert: {ergebnis.quelle.kopf.titel}
          </h2>
          <p>
            Das Dokument liegt unverändert unter <span class="mono">{ergebnis.quelle.pfad}</span>.
            {ergebnis.quelle.kopf.ersetzt && ' Es ersetzt die ältere Fassung in der Suche.'}
          </p>
          {ergebnis.vorschlaege.length ? (
            <div class="ergebnis-vorschlaege">
              <p>
                <strong>
                  {ergebnis.vorschlaege.length === 1 ? 'Ein Vorschlag liegt' : `${ergebnis.vorschlaege.length} Vorschläge liegen`} jetzt im Eingang.
                </strong>{' '}
                Das Wissen ändert sich erst, wenn jemand freigibt.
              </p>
              <ul>
                {ergebnis.vorschlaege.map((v) => (
                  <li key={v.id}>
                    <a href={href(`eingang/${v.id}`)}>
                      {v.art === 'neu' ? 'Neuer Artikel' : v.art === 'loeschung' ? 'Löschen' : 'Änderung'}: {v.ziel.split('/').pop()?.replace(/\.md$/, '')}
                    </a>
                  </li>
                ))}
              </ul>
            </div>
          ) : (
            <p class="klein-text">Daraus ist noch kein Vorschlag entstanden. Das kommt, sobald der Text erkannt ist.</p>
          )}
          <div class="knopf-reihe">
            {ergebnis.vorschlaege.length > 0 && (
              <KnopfLink art="primaer" href="#/eingang" iconRechts="pfeil">
                Zum Eingang
              </KnopfLink>
            )}
            <KnopfLink href={href(dokumentRoute(ergebnis.quelle.pfad))}>Dokument ansehen</KnopfLink>
            <Knopf art="leise" icon="neu" onClick={zuruecksetzen}>
              Noch etwas hinzufügen
            </Knopf>
          </div>
        </section>
      </div>
    );

  return (
    <div class="seite seite--mittel">
      <Seitenkopf titel="Inhalte hinzufügen" unterzeile="Wähl, was du ablegen willst, und leg fest, wer es lesen darf." />

      <fieldset class="reiter-karten">
        <legend class="sr-only">Was willst du hinzufügen?</legend>
        {REITER.map((r) => (
          <label key={r.id} class={`reiter-karte${reiter === r.id ? ' aktiv' : ''}`}>
            <input type="radio" name="art" value={r.id} checked={reiter === r.id} onChange={() => setReiter(r.id)} />
            <span class="reiter-icon" aria-hidden="true">
              <Icon name={r.icon} />
            </span>
            <span class="reiter-text">
              <span class="reiter-titel">{r.titel}</span>
              <span class="reiter-unter">{r.unter}</span>
            </span>
            <span class="reiter-haken" aria-hidden="true">
              <Icon name="haken" groesse={16} />
            </span>
          </label>
        ))}
      </fieldset>

      <form class="karte hinzufuegen-form" onSubmit={senden} noValidate>
        <div class="hinzufuegen-spalten">
          <div class="hinzufuegen-quelle">
            <p class="schritt">1 · Quelle</p>
            {reiter === 'datei' && (
              <>
                <h2 class="schritt-titel">Datei auswählen</h2>
                <div
                  class={`ablage${ziehen ? ' ziehen' : ''}${fehler.datei ? ' ablage-fehler' : ''}${datei ? ' hat-datei' : ''}`}
                  onDragOver={(e) => {
                    e.preventDefault();
                    setZiehen(true);
                  }}
                  onDragLeave={() => setZiehen(false)}
                  onDrop={(e) => {
                    e.preventDefault();
                    setZiehen(false);
                    const f = e.dataTransfer?.files?.[0];
                    if (f) {
                      setDatei(f);
                      if (!titel) setTitel(f.name.replace(/\.[^.]+$/, ''));
                    }
                  }}
                >
                  {datei ? (
                    <div class="ablage-datei">
                      <Icon name="dokumente" groesse={28} />
                      <div>
                        <p class="ablage-name">{datei.name}</p>
                        <p class="meta-klein">{groesse(datei.size)}</p>
                      </div>
                      <button type="button" class="symbol-knopf" aria-label={`${datei.name} entfernen`} onClick={() => setDatei(null)}>
                        <Icon name="schliessen" />
                      </button>
                    </div>
                  ) : (
                    <>
                      <Icon name="hochladen" groesse={30} />
                      <p class="ablage-titel">Datei hierher ziehen</p>
                      <label class="ablage-waehlen">
                        oder Datei auswählen
                        <input
                          ref={dateiRef}
                          type="file"
                          class="sr-only"
                          accept=".pdf,.doc,.docx,.txt,.md,.html,.htm,.csv,.xlsx,.odt,audio/*"
                          aria-describedby="datei-hilfe"
                          onChange={(e) => {
                            const f = (e.target as HTMLInputElement).files?.[0] ?? null;
                            setDatei(f);
                            if (f && !titel) setTitel(f.name.replace(/\.[^.]+$/, ''));
                          }}
                        />
                      </label>
                      <p class="meta-klein" id="datei-hilfe">
                        PDF, Word, Excel, Text, HTML oder Audio
                      </p>
                    </>
                  )}
                </div>
                {fehler.datei && (
                  <p class="feld-fehler">
                    <Icon name="warnung" groesse={16} /> {fehler.datei}
                  </p>
                )}
                <p class="feld-hilfe">Eine neue Fassung derselben Datei ersetzt die alte in der Suche. Die alte bleibt im Verlauf.</p>
              </>
            )}

            {reiter === 'text' && (
              <>
                <h2 class="schritt-titel">Text einfügen</h2>
                <Feld label="Titel" hilfe={`Leer lassen, dann nimmt ${PRODUKT} die erste Zeile.`}>
                  {(p) => <input {...p} class="eingabe" type="text" value={titel} onInput={(e) => setTitel((e.target as HTMLInputElement).value)} />}
                </Feld>
                <Feld label="Inhalt" pflicht fehler={fehler.inhalt}>
                  {(p) => (
                    <textarea
                      {...p}
                      class="eingabe eingabe--text"
                      rows={9}
                      placeholder="Notiz, Mail, Protokoll, Ablauf … Markdown geht auch."
                      value={inhalt}
                      onInput={(e) => setInhalt((e.target as HTMLTextAreaElement).value)}
                    />
                  )}
                </Feld>
                <label class="schalter-zeile">
                  <input type="checkbox" class="schalter" checked={alsNotiz} onChange={(e) => setAlsNotiz((e.target as HTMLInputElement).checked)} />
                  <span>Als kurze Notiz ablegen (nicht als Dokument)</span>
                </label>
              </>
            )}

            {reiter === 'web' && (
              <>
                <h2 class="schritt-titel">Webseite holen</h2>
                <Feld label="Adresse" pflicht fehler={fehler.url} hilfe={`${PRODUKT} holt die Seite einmal und speichert den Text.`}>
                  {(p) => (
                    <input
                      {...p}
                      class="eingabe"
                      type="url"
                      inputMode="url"
                      autocomplete="url"
                      placeholder="https://"
                      value={url}
                      onInput={(e) => setUrl((e.target as HTMLInputElement).value)}
                    />
                  )}
                </Feld>
                <Feld label="Titel" hilfe="Optional.">
                  {(p) => <input {...p} class="eingabe" type="text" value={titel} onInput={(e) => setTitel((e.target as HTMLInputElement).value)} />}
                </Feld>
              </>
            )}

            {reiter === 'import' && (
              <>
                <h2 class="schritt-titel">Woher kommt das Wissen?</h2>
                <fieldset class="import-wahl">
                  <legend class="sr-only">System</legend>
                  {IMPORTE.map((i) => (
                    <label key={i.art} class={`import-option${importArt === i.art ? ' aktiv' : ''}`}>
                      <input type="radio" name="import-art" value={i.art} checked={importArt === i.art} onChange={() => setImportArt(i.art)} />
                      <span>{i.titel}</span>
                    </label>
                  ))}
                </fieldset>
                <ol class="import-schritte">
                  {IMPORTE.find((i) => i.art === importArt)!.schritte.map((t) => (
                    <li key={t}>{t}</li>
                  ))}
                </ol>
                <div class={`ablage ablage--klein${fehler.import ? ' ablage-fehler' : ''}${importDatei ? ' hat-datei' : ''}`}>
                  {importDatei ? (
                    <div class="ablage-datei">
                      <Icon name="ordner" groesse={26} />
                      <div>
                        <p class="ablage-name">{importDatei.name}</p>
                        <p class="meta-klein">{groesse(importDatei.size)}</p>
                      </div>
                      <button type="button" class="symbol-knopf" aria-label={`${importDatei.name} entfernen`} onClick={() => setImportDatei(null)}>
                        <Icon name="schliessen" />
                      </button>
                    </div>
                  ) : (
                    <label class="ablage-waehlen">
                      Export-Datei auswählen (.zip)
                      <input type="file" class="sr-only" accept=".zip,application/zip" onChange={(e) => setImportDatei((e.target as HTMLInputElement).files?.[0] ?? null)} />
                    </label>
                  )}
                </div>
                {fehler.import && (
                  <p class="feld-fehler">
                    <Icon name="warnung" groesse={16} /> {fehler.import}
                  </p>
                )}
                <details class="profi">
                  <summary>Für Profis: Ordner auf dem Server</summary>
                  <Feld label="Pfad auf dem Server" hilfe="Statt Hochladen. Gleich wie kern import --obsidian <pfad>.">
                    {(p) => <input {...p} class="eingabe mono" type="text" placeholder="/srv/import/vault" value={importPfad} onInput={(e) => setImportPfad((e.target as HTMLInputElement).value)} />}
                  </Feld>
                </details>
                <p class="feld-hilfe">Jede Seite wird ein Dokument. {PRODUKT} schlägt daraus Artikel vor, nichts landet direkt im Wissen.</p>
              </>
            )}

            {reiter === 'audio' && (
              <>
                <h2 class="schritt-titel">Sprachnotiz aufnehmen</h2>
                <Feld label="Titel" hilfe="Zum Beispiel: Wie wir den Transporter packen">
                  {(p) => <input {...p} class="eingabe" type="text" value={titel} onInput={(e) => setTitel((e.target as HTMLInputElement).value)} />}
                </Feld>
                <Aufnahme fertig={setAufnahme} />
                {fehler.audio && (
                  <p class="feld-fehler">
                    <Icon name="warnung" groesse={16} /> {fehler.audio}
                  </p>
                )}
              </>
            )}
          </div>

          <div class="hinzufuegen-ablage">
            <p class="schritt">2 · Ablage und Zugriff</p>
            <h2 class="schritt-titel">Wohin gehört das?</h2>
            <Feld label="Sammlung" fehler={fehler.sammlung}>
              {(p) => (
                <div class="auswahl">
                  <select {...p} class="eingabe" value={sammlung} onChange={(e) => setSammlung((e.target as HTMLSelectElement).value)}>
                    {sammlungen.map((s) => (
                      <option key={s} value={s}>
                        {s}
                      </option>
                    ))}
                    <option value="__neu">Neue Sammlung …</option>
                  </select>
                  <Icon name="pfeilRunter" groesse={16} klasse="auswahl-pfeil" />
                </div>
              )}
            </Feld>
            {sammlung === '__neu' && (
              <Feld label="Name der neuen Sammlung" pflicht>
                {(p) => <input {...p} class="eingabe" type="text" value={neueSammlung} onInput={(e) => setNeueSammlung((e.target as HTMLInputElement).value)} />}
              </Feld>
            )}
            <Segment
              name="sicht"
              legende="Wer darf lesen?"
              wert={sicht}
              aendern={setSicht}
              optionen={[
                { wert: 'ich', text: 'Nur ich', icon: 'person' },
                { wert: 'team', text: 'Team', icon: 'team' },
                { wert: 'betrieb', text: 'Alle im Betrieb', icon: 'betrieb' },
              ]}
            />
            <p class="feld-hilfe sicht-erklaerung" aria-live="polite">
              {sicht === 'ich'
                ? 'Nur du. Auch Admins sehen es nicht.'
                : sicht === 'team'
                  ? 'Alle Mitglieder des gewählten Teams.'
                  : 'Alle, die sich hier anmelden können: jede Person mit Zugang zu dieser Instanz, egal welches Team.'}
            </p>
            {sicht === 'team' &&
              (ich.teams.length > 1 ? (
                <Feld label="Welches Team?">
                  {(p) => (
                    <div class="auswahl">
                      <select {...p} class="eingabe" value={team} onChange={(e) => setTeam((e.target as HTMLSelectElement).value)}>
                        {ich.teams.map((t) => (
                          <option key={t} value={t}>
                            {teamName(t)}
                          </option>
                        ))}
                      </select>
                      <Icon name="pfeilRunter" groesse={16} klasse="auswahl-pfeil" />
                    </div>
                  )}
                </Feld>
              ) : (
                <p class="feld-hilfe">{team ? `Team ${teamName(team)}` : ''}</p>
              ))}
            {fehler.team && <p class="feld-fehler">{fehler.team}</p>}
            {reiter !== 'import' && <label class="schalter-zeile schalter-zeile--block">
              <input type="checkbox" class="schalter" checked={beobachten} onChange={(e) => setBeobachten((e.target as HTMLInputElement).checked)} />
              <span>
                <span class="schalter-titel">Beobachten</span>
                <span class="feld-hilfe">
                  {reiter === 'web' ? `${PRODUKT} schaut regelmäßig nach. Ändert sich die Seite, kommt ein Vorschlag in den Eingang.` : 'Neue Fassungen werden erkannt und als Vorschlag gemeldet.'}
                </span>
              </span>
            </label>}
          </div>
        </div>
        {allgemein && <Fehlerhinweis text={allgemein} />}
        <div class="hinzufuegen-fuss">
          <p>Der Inhalt wird als Dokument gespeichert. Vorschläge für das Wissen prüfst du danach im Eingang.</p>
          <Knopf art="primaer" type="submit" laedt={laedt} iconRechts="pfeil">
            {KNOPF[reiter]}
          </Knopf>
        </div>
      </form>

      <Beobachtet />
    </div>
  );
}
