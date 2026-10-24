import { useEffect, useState } from 'preact/hooks';
import { api, MOCK } from '../api';
import type { Einstellungen as E, ExportArt, ExportAuftrag, Konto as KontoT, KontoAktion, LeseEinstellungen, LeseRegel, Lesestil, NeuesToken, PruefbankLauf, ProviderArt, Rolle, TokenScope, VerbundeneApp, ZugangsToken } from '../api/types';
import { PRODUKT } from '../produkt';
import { F12Hinweis } from './ErsteSchritte';
import { KI_STATUS_TEXT, KontextbilanzInhalt } from './Kontextbilanz';
import { useApp, darf, ROLLEN_TEXT } from '../kontext';
import { fehlerText, useLaden } from '../lib/laden';
import { datum } from '../lib/datum';
import type { Route } from '../lib/router';
import { teamName } from '../lib/pfade';
import { Icon, type IconName } from '../ui/Icon';
import { Chip, Dialog, Feld, Fehlerhinweis, Hinweis, Knopf, KnopfLink, Laedt, Seitenkopf } from '../ui/teile';

const ABSCHNITTE: { id: string; text: string; icon: IconName; wer?: 'admin' | 'freigeber' | 'konto'; betont?: boolean }[] = [
  { id: 'lesen', text: 'Mein Lesen', icon: 'heute' },
  { id: 'wissen', text: 'Dein Wissen gehört dir', icon: 'herunterladen', betont: true },
  { id: 'konto', text: 'Konto', icon: 'stern', wer: 'konto' },
  { id: 'kontext', text: 'Kontextbilanz', icon: 'fakten', wer: 'freigeber' },
  { id: 'apps', text: 'Verbundene Apps', icon: 'schloss' },
  { id: 'anmeldung', text: 'Anmeldung und Geräte', icon: 'person' },
  { id: 'ki', text: 'KI-Anbieter', icon: 'lampe', wer: 'admin' },
  { id: 'datenweg', text: 'Wohin gehen meine Daten?', icon: 'web' },
  { id: 'betrieb', text: 'Betrieb', icon: 'betrieb' },
  { id: 'benutzer', text: 'Benutzer und Rollen', icon: 'team', wer: 'admin' },
];

const SCOPE_TEXT: Record<TokenScope, { titel: string; unter: string }> = {
  'kern:lesen': { titel: 'Lesen', unter: 'Suchen und Artikel lesen, mit deinen Rechten' },
  'kern:fragen': { titel: 'Fragen', unter: 'Fragen stellen, Antworten mit Beleg' },
  'kern:vorschlagen': { titel: 'Vorschlagen', unter: 'Änderungen in den Eingang legen, nie direkt schreiben' },
  'kern:bericht': { titel: 'Berichten', unter: 'Agentenberichte abgeben' },
  'kern:verwalten': { titel: 'Verwalten', unter: 'Nur für Admins: Einstellungen lesen' },
};

const ANBIETER: { art: ProviderArt; titel: string; unter: string }[] = [
  { art: 'mock', titel: 'Testmodus', unter: 'Ohne KI. Antwortet mit wörtlichen Sätzen aus den Fundstellen.' },
  { art: 'ollama', titel: 'Ollama, lokal', unter: 'Läuft auf eurem eigenen Rechner oder Server. Nichts geht nach außen.' },
  { art: 'openai', titel: 'OpenAI-kompatibel', unter: 'Zum Beispiel Mistral, IONOS, STACKIT oder ein eigener vLLM-Server.' },
  { art: 'anthropic', titel: 'Anthropic', unter: 'Claude über die API.' },
];

const STIL_TEXT: Record<Lesestil, { titel: string; unter: string }> = {
  zusammenfassung: { titel: 'Zusammenfassung', unter: 'Ein kurzer Text, was sich getan hat. Darunter Knöpfe für Entscheidungsvorlage und nur Abweichungen.' },
  entscheidung: { titel: 'Entscheidungsvorlage', unter: 'Was sich ändert, was du entscheiden sollst, was du ignorieren darfst. Zusammenfassung auf Klick.' },
  fokus: { titel: 'Fokus', unter: 'Nur Abweichungen, mit Lesebudget. Meldungen nur über deine eigenen Regeln.' },
};

const WENN_TEXT: Record<LeseRegel['wenn'], string> = {
  fakt_aendert: 'sich ein Fakt ändert',
  frist_naht: 'eine Frist näher rückt',
  artikel_aendert: 'sich ein Artikel ändert',
  neue_quelle: 'eine neue Quelle dazukommt',
  zustaendig_fuer: 'ich zuständig bin',
  agent_risiko: 'ein Agent ein Risiko meldet',
};

export function regelSatz(r: LeseRegel): string {
  const f: string[] = [];
  if (r.filter.art) f.push(`der Art „${r.filter.art}“`);
  if (r.filter.gruppe) f.push(`in der Gruppe „${r.filter.gruppe}“`);
  if (r.filter.gegenstand) f.push(`zu „${r.filter.gegenstand}“`);
  if (r.filter.tage) f.push(`innerhalb von ${r.filter.tage} Tagen`);
  const anfang = r.dann === 'melden' ? 'Melde mir sofort, wenn' : 'Sammle für die nächste Zustellung, wenn';
  return `${anfang} ${WENN_TEXT[r.wenn]}${f.length ? ' ' + f.join(' ') : ''}.`;
}

function MeinLesen() {
  const { melde, artikelListe } = useApp();
  const r = useLaden(() => api.lesen(), []);
  const b = useLaden(() => api.lesebilanz(), []);
  const [e, setE] = useState<LeseEinstellungen | null>(null);
  const [laedt, setLaedt] = useState(false);
  const [neuWenn, setNeuWenn] = useState<LeseRegel['wenn']>('artikel_aendert');
  const [neuGruppe, setNeuGruppe] = useState('');
  const [neuDann, setNeuDann] = useState<LeseRegel['dann']>('sammeln');
  useEffect(() => {
    if (r.daten) setE(r.daten);
  }, [r.daten]);
  if (r.laedt || !e) return <Laedt />;
  if (r.fehler) return <Fehlerhinweis text={r.fehler} nochmal={r.neu} />;
  const setze = (x: Partial<LeseEinstellungen>) => setE({ ...e, ...x });
  const gruppen = [...new Set(artikelListe.map((a) => a.kopf.gruppe))].sort();
  const speichern = async (ev: Event) => {
    ev.preventDefault();
    setLaedt(true);
    try {
      setE(await api.speichereLesen(e));
      melde('Gespeichert. Gilt ab der nächsten Ansicht.');
    } catch (err) {
      melde(fehlerText(err), 'fehler');
    } finally {
      setLaedt(false);
    }
  };
  return (
    <form class="formular" onSubmit={speichern} noValidate>
      <p class="hinweis hinweis--info">
        <Icon name="schloss" groesse={20} />
        <span>Diese Einstellungen und deine Lesedaten siehst nur du. Kein Admin bekommt einen Bericht darüber, was du liest.</span>
      </p>
      <fieldset class="formular-gruppe">
        <legend class="feld-label">Lesestil für „Heute“</legend>
        <div class="anbieter-karten">
          {(Object.keys(STIL_TEXT) as Lesestil[]).map((s) => (
            <label key={s} class={`anbieter-karte${e.stil === s ? ' aktiv' : ''}`}>
              <input type="radio" name="stil" value={s} checked={e.stil === s} onChange={() => setze({ stil: s })} />
              <span class="anbieter-titel">{STIL_TEXT[s].titel}</span>
              <span class="anbieter-unter">{STIL_TEXT[s].unter}</span>
            </label>
          ))}
        </div>
      </fieldset>
      <label class="schalter-zeile schalter-zeile--block">
        <input type="checkbox" class="schalter" checked={e.lesebudget_an} onChange={(x) => setze({ lesebudget_an: (x.target as HTMLInputElement).checked })} />
        <span>
          <span class="schalter-titel">Lesebudget</span>
          <span class="feld-hilfe">Zeigt, wie lange das Lesen heute dauert. Standard aus.</span>
        </span>
      </label>
      {e.lesebudget_an && (
        <>
          <div class="feld-reihe">
            <Feld label="Minuten pro Tag">
              {(p) => <input {...p} class="eingabe" type="number" min={1} max={120} inputMode="numeric" value={e.lesebudget_min_tag} onInput={(x) => setze({ lesebudget_min_tag: Number((x.target as HTMLInputElement).value) || 1 })} />}
            </Feld>
            <Feld label="Wörter pro Minute" hilfe="Annahme 200 für deutsche Sachtexte. Wer schneller liest, stellt mehr ein.">
              {(p) => <input {...p} class="eingabe" type="number" min={80} max={600} inputMode="numeric" value={e.woerter_pro_minute} onInput={(x) => setze({ woerter_pro_minute: Number((x.target as HTMLInputElement).value) || 200 })} />}
            </Feld>
          </div>
          <label class="schalter-zeile schalter-zeile--block">
            <input type="checkbox" class="schalter" checked={e.budget_hart} onChange={(x) => setze({ budget_hart: (x.target as HTMLInputElement).checked })} />
            <span>
              <span class="schalter-titel">Harte Grenze im Fokus-Stil</span>
              <span class="feld-hilfe">Was nicht ins Budget passt, kommt morgen. Ohne Haken zeigt {PRODUKT} alles und markiert nur, ab wo es über dem Budget liegt.</span>
            </span>
          </label>
        </>
      )}
      <div class="feld-reihe">
        <Feld label="Höchstens offene Vorschläge im Eingang" hilfe="Weitere warten sichtbar gezählt.">
          {(p) => <input {...p} class="eingabe" type="number" min={1} max={20} inputMode="numeric" value={e.max_offene_vorschlaege} onInput={(x) => setze({ max_offene_vorschlaege: Number((x.target as HTMLInputElement).value) || 3 })} />}
        </Feld>
        <Feld label="Zustellzeiten" hilfe="Höchstens drei, mit Komma getrennt, z. B. 07:30, 13:00.">
          {(p) => <input {...p} class="eingabe mono" type="text" value={e.zustellzeiten.join(', ')} onInput={(x) => setze({ zustellzeiten: (x.target as HTMLInputElement).value.split(',').map((t) => t.trim()).filter(Boolean).slice(0, 3) })} />}
        </Feld>
      </div>
      <label class="schalter-zeile schalter-zeile--block">
        <input type="checkbox" class="schalter" checked={e.modus_erst_ich} onChange={(x) => setze({ modus_erst_ich: (x.target as HTMLInputElement).checked })} />
        <span>
          <span class="schalter-titel">„Erst du, dann ich“ beim Fragen vorschlagen</span>
          <span class="feld-hilfe">Du schreibst zuerst deine Einschätzung, {PRODUKT} zeigt danach Lücken und Widersprüche.</span>
        </span>
      </label>
      <label class="schalter-zeile schalter-zeile--block">
        <input type="checkbox" class="schalter" checked={e.nur_abweichungen} onChange={(x) => setze({ nur_abweichungen: (x.target as HTMLInputElement).checked })} />
        <span>
          <span class="schalter-titel">Im Fokus nur Abweichungen</span>
          <span class="feld-hilfe">Punkte, die seit deiner letzten Ansicht gleich geblieben sind, werden ausgeblendet.</span>
        </span>
      </label>
      <section class="artikel-abschnitt" aria-labelledby="regeln-titel">
        <h3 id="regeln-titel" class="abschnitt-titel">
          Meine Regeln
        </h3>
        <p class="klein-text">{PRODUKT} meldet nur, was eine dieser Regeln auslöst, plus harte Pflichten wie eine Frist in deiner Zuständigkeit.</p>
        <ul class="regel-liste">
          {e.regeln.map((rg) => (
            <li key={rg.id}>
              <span>{regelSatz(rg)}</span>
              <button type="button" class="symbol-knopf" aria-label={`Regel entfernen: ${regelSatz(rg)}`} onClick={() => setze({ regeln: e.regeln.filter((x) => x.id !== rg.id) })}>
                <Icon name="schliessen" groesse={18} />
              </button>
            </li>
          ))}
          {!e.regeln.length && <li class="klein-text">Keine eigenen Regeln.</li>}
        </ul>
        <div class="regel-neu">
          <Feld label="Wenn">
            {(p) => (
              <div class="auswahl">
                <select {...p} class="eingabe" value={neuWenn} onChange={(x) => setNeuWenn((x.target as HTMLSelectElement).value as LeseRegel['wenn'])}>
                  {Object.entries(WENN_TEXT).map(([k, v]) => (
                    <option key={k} value={k}>
                      {v}
                    </option>
                  ))}
                </select>
                <Icon name="pfeilRunter" groesse={16} klasse="auswahl-pfeil" />
              </div>
            )}
          </Feld>
          <Feld label="In Gruppe">
            {(p) => (
              <div class="auswahl">
                <select {...p} class="eingabe" value={neuGruppe} onChange={(x) => setNeuGruppe((x.target as HTMLSelectElement).value)}>
                  <option value="">alle</option>
                  {gruppen.map((g) => (
                    <option key={g}>{g}</option>
                  ))}
                </select>
                <Icon name="pfeilRunter" groesse={16} klasse="auswahl-pfeil" />
              </div>
            )}
          </Feld>
          <Feld label="Dann">
            {(p) => (
              <div class="auswahl">
                <select {...p} class="eingabe" value={neuDann} onChange={(x) => setNeuDann((x.target as HTMLSelectElement).value as LeseRegel['dann'])}>
                  <option value="sammeln">sammeln</option>
                  <option value="melden">sofort melden</option>
                </select>
                <Icon name="pfeilRunter" groesse={16} klasse="auswahl-pfeil" />
              </div>
            )}
          </Feld>
          <Knopf
            klein
            icon="neu"
            onClick={() => setze({ regeln: [...e.regeln, { id: `r${Date.now().toString(36)}`, wenn: neuWenn, filter: neuGruppe ? { gruppe: neuGruppe } : {}, dann: neuDann }] })}
          >
            Regel hinzufügen
          </Knopf>
        </div>
      </section>
      {b.daten && (
        <section class="artikel-abschnitt" aria-labelledby="bilanz-titel">
          <h3 id="bilanz-titel" class="abschnitt-titel">
            Meine Lesebilanz
          </h3>
          <ul class="klein-liste">
            {b.daten.nieGeoeffnet.map((n, i) => (
              <li key={i}>
                {n.zweck === 'agentenbericht' ? `Agentenberichte${n.regel ? ` von ${n.regel}` : ''}` : n.zweck === 'briefing' ? 'Heute-Ansichten' : n.zweck}: {n.anzahl}
                {n.von ? ` von ${n.von}` : ''} nie geöffnet.
              </li>
            ))}
          </ul>
          {b.daten.vorschlaege.map((v) => (
            <p key={v} class="klein-text">
              {v}
            </p>
          ))}
          <p class="meta-klein">Lesedaten werden nach 30 Tagen gelöscht.</p>
        </section>
      )}
      <div class="knopf-reihe">
        <Knopf art="primaer" type="submit" laedt={laedt} icon="haken">
          Speichern
        </Knopf>
      </div>
    </form>
  );
}

function Betrieb({ e, kannAendern, speichern }: { e: E; kannAendern: boolean; speichern: (e: E) => Promise<void> }) {
  const [name, setName] = useState(e.betrieb);
  const [sprache, setSprache] = useState(e.sprache);
  const [teams, setTeams] = useState(e.teams.join(', '));
  const [akzent, setAkzent] = useState(e.marke?.akzent ?? '#2055b3');
  const [logo, setLogo] = useState(e.marke?.logo ?? '');
  const [stil, setStil] = useState<Lesestil>(e.standard_lesestil ?? 'zusammenfassung');
  const [laedt, setLaedt] = useState(false);
  const [fehler, setFehler] = useState<string | null>(null);
  const senden = async (ev: Event) => {
    ev.preventDefault();
    if (!name.trim()) return setFehler('Der Betrieb braucht einen Namen.');
    setFehler(null);
    setLaedt(true);
    await speichern({
      ...e,
      betrieb: name.trim(),
      sprache,
      teams: teams.split(',').map((t) => t.trim().toLowerCase()).filter(Boolean),
      marke: { akzent, logo: logo.trim() || undefined },
      standard_lesestil: stil,
    });
    setLaedt(false);
  };
  return (
    <form onSubmit={senden} class="formular" noValidate>
      <fieldset disabled={!kannAendern} class="formular-gruppe">
        <legend class="sr-only">Betrieb</legend>
        <Feld label="Name des Betriebs" fehler={fehler}>
          {(p) => <input {...p} class="eingabe" type="text" value={name} onInput={(x) => setName((x.target as HTMLInputElement).value)} />}
        </Feld>
        <Feld label="Sprache der Oberfläche und Antworten">
          {(p) => (
            <div class="auswahl">
              <select {...p} class="eingabe" value={sprache} onChange={(x) => setSprache((x.target as HTMLSelectElement).value as 'de' | 'en')}>
                <option value="de">Deutsch</option>
                <option value="en">Englisch</option>
              </select>
              <Icon name="pfeilRunter" groesse={16} klasse="auswahl-pfeil" />
            </div>
          )}
        </Feld>
        <Feld label="Teams" hilfe="Mit Komma trennen. Teams bestimmen, wer was lesen darf.">
          {(p) => <input {...p} class="eingabe" type="text" value={teams} onInput={(x) => setTeams((x.target as HTMLInputElement).value)} />}
        </Feld>
        <Feld label="Lesestil für neue Benutzer" hilfe="Nur ein Startwert. Jede Person kann ihn jederzeit selbst ändern.">
          {(p) => (
            <div class="auswahl">
              <select {...p} class="eingabe" value={stil} onChange={(x) => setStil((x.target as HTMLSelectElement).value as Lesestil)}>
                {(Object.keys(STIL_TEXT) as Lesestil[]).map((s) => (
                  <option key={s} value={s}>
                    {STIL_TEXT[s].titel}
                  </option>
                ))}
              </select>
              <Icon name="pfeilRunter" groesse={16} klasse="auswahl-pfeil" />
            </div>
          )}
        </Feld>
        <div class="feld-reihe">
          <Feld label="Hauptfarbe" hilfe="Für Knöpfe, Links und Belege. Achte auf genug Kontrast zu Weiß.">
            {(p) => (
              <div class="farbe-feld">
                <input {...p} type="color" class="farbe" value={akzent} onInput={(x) => setAkzent((x.target as HTMLInputElement).value)} />
                <span class="mono">{akzent}</span>
              </div>
            )}
          </Feld>
          <Feld label="Logo (Adresse)" hilfe={`SVG oder PNG, quadratisch. Leer lassen für das ${PRODUKT}-Zeichen.`}>
            {(p) => <input {...p} class="eingabe" type="url" placeholder="https://…/logo.svg" value={logo} onInput={(x) => setLogo((x.target as HTMLInputElement).value)} />}
          </Feld>
        </div>
        {kannAendern && (
          <div class="knopf-reihe">
            <Knopf art="primaer" type="submit" laedt={laedt} icon="haken">
              Speichern
            </Knopf>
          </div>
        )}
      </fieldset>
    </form>
  );
}

/** v1.4 8.2: Prüfstatus sichtbar, Prüfbank-Lauf, Rückweg. v1.4 5.2: Schlüssel getrennt und nur schreibend. */
function Ki({ e, kannAendern, speichern }: { e: E; kannAendern: boolean; speichern: (e: E) => Promise<void> }) {
  const { setzeEinstellungen, melde } = useApp();
  const managed = !!e.managed;
  const vor = (e.voreinstellungen ?? []).filter((v) => v.id !== 'hd_test');
  const [art, setArt] = useState<ProviderArt>(e.provider.art);
  const [vid, setVid] = useState<string>(e.ki?.voreinstellung ?? e.provider.anbieter ?? vor.find((v) => v.region === 'eu')?.id ?? '');
  const [url, setUrl] = useState(e.provider.url ?? '');
  const [chat, setChat] = useState(e.provider.chatModell ?? '');
  const [embed, setEmbed] = useState(e.provider.embedModell ?? '');
  const [schluessel, setSchluessel] = useState('');
  const [laedt, setLaedt] = useState<'' | 'speichern' | 'pruefen' | 'zurueck'>('');
  const [lauf, setLauf] = useState<PruefbankLauf | null>(null);
  const [fehler, setFehler] = useState<Record<string, string>>({});
  const pb = useLaden(() => api.pruefbank(), []);
  useEffect(() => {
    if (art === 'ollama' && !url) setUrl('http://localhost:11434');
  }, [art]);
  const ausListe = managed && art === 'openai';
  const status = KI_STATUS_TEXT[e.ki?.status ?? (e.provider.art === 'mock' ? 'ohne_ki' : 'ungeprueft')];
  const letzter = lauf ?? pb.daten;
  const senden = async (ev: Event) => {
    ev.preventDefault();
    const f: Record<string, string> = {};
    if ((art === 'ollama' || (art === 'openai' && !ausListe)) && !/^https?:\/\//.test(url)) f.url = 'Die Adresse muss mit http:// oder https:// anfangen.';
    if (art !== 'mock' && !ausListe && !chat.trim()) f.chat = 'Welches Modell soll antworten?';
    if ((art === 'openai' || art === 'anthropic') && !schluessel && !(e.provider.hatSchluessel && e.provider.art === art)) f.key = 'Ohne Schlüssel geht es bei diesem Anbieter nicht.';
    setFehler(f);
    if (Object.keys(f).length) return;
    setLaedt('speichern');
    const provider: E['provider'] = ausListe ? { art, anbieter: vid, chatModell: chat || undefined, embedModell: embed || undefined } : { art, url: url || undefined, chatModell: chat || undefined, embedModell: embed || undefined };
    await speichern({ ...e, provider });
    if (schluessel) {
      try {
        await api.speichereKiSchluessel(ausListe ? vid : art, schluessel);
        setSchluessel('');
      } catch (err) {
        melde(fehlerText(err), 'fehler');
      }
    }
    setLaedt('');
  };
  const pruefen = async () => {
    setLaedt('pruefen');
    try {
      const l = await api.pruefbankLauf();
      setLauf(l);
      setzeEinstellungen(await api.einstellungen());
    } catch (err) {
      melde(fehlerText(err), 'fehler');
    } finally {
      setLaedt('');
    }
  };
  const zurueck = async () => {
    setLaedt('zurueck');
    try {
      setzeEinstellungen(await api.kiZurueck());
      melde('Der vorherige KI-Anbieter ist wieder aktiv.');
    } catch (err) {
      melde(fehlerText(err), 'fehler');
    } finally {
      setLaedt('');
    }
  };
  const karten = managed ? ANBIETER.filter((a) => a.art !== 'ollama') : ANBIETER;
  return (
    <div class="formular">
      <div class={`ki-status ki-status--${status.art || 'neutral'}`}>
        <div>
          <p class="schalter-titel">Prüfstatus: {status.text}</p>
          <p class="klein-text">
            {e.ki?.status === 'geprueft'
              ? `Die Prüfbank lief mit diesem Modell: Belegtreue ${letzter?.belegtreue != null ? `${Math.round(letzter.belegtreue * 100)} %` : 'ok'}, keine Rechte-Lecks.`
              : e.ki?.status === 'unter_schwelle'
                ? 'Mit diesem Modell stimmen zu viele Belege nicht. Es läuft weiter, aber prüf die Antworten genauer oder geh zurück.'
                : e.ki?.status === 'ungeprueft'
                  ? 'Seit dem letzten Wechsel lief die Prüfbank noch nicht. Sie misst mit festen Fragen, ob Belege stimmen und keine Rechte durchsickern.'
                  : 'Antworten sind wörtliche Auszüge mit Fundstelle.'}
          </p>
        </div>
        {kannAendern && e.provider.art !== 'mock' && (
          <div class="knopf-reihe">
            <Knopf laedt={laedt === 'pruefen'} icon="schild" onClick={pruefen}>
              Prüfbank laufen lassen
            </Knopf>
            {e.ki?.status === 'unter_schwelle' && e.ki.vorher && (
              <Knopf art="leise" laedt={laedt === 'zurueck'} icon="zurueck" onClick={zurueck}>
                Zurück zum vorherigen
              </Knopf>
            )}
          </div>
        )}
      </div>
      {letzter && letzter.status === 'fertig' && (
        <dl class="bilanz-werte bilanz-werte--klein" aria-label="Letzter Prüflauf">
          <div class="bilanz-wert">
            <dt>Belegtreue</dt>
            <dd class="mono">{letzter.belegtreue != null ? `${Math.round(letzter.belegtreue * 100)} %` : '–'}</dd>
          </div>
          <div class="bilanz-wert">
            <dt>Rechte-Lecks</dt>
            <dd class="mono">{letzter.lecks ?? '–'}</dd>
          </div>
          <div class="bilanz-wert">
            <dt>Eingeschleuste Anweisungen abgewehrt</dt>
            <dd class="mono">{letzter.injektion != null ? `${Math.round(letzter.injektion * 100)} %` : '–'}</dd>
          </div>
          <div class="bilanz-wert">
            <dt>Lauf</dt>
            <dd class="mono">{datum(letzter.am)}</dd>
          </div>
        </dl>
      )}
      <form onSubmit={senden} class="formular" noValidate>
        {managed && (
          <p class="hinweis hinweis--info">
            <Icon name="schild" groesse={20} />
            <span>Betreuter Betrieb: Es gehen nur Anbieter aus einer geprüften Liste. Euer Schlüssel geht nur an den gewählten Anbieter. Lokale Modelle gehen mit der selbst gehosteten Fassung.</span>
          </p>
        )}
        <fieldset disabled={!kannAendern} class="formular-gruppe">
          <legend class="feld-label">Wer beantwortet die Fragen?</legend>
          <div class="anbieter-karten">
            {karten.map((a) => (
              <label key={a.art} class={`anbieter-karte${art === a.art ? ' aktiv' : ''}`}>
                <input type="radio" name="anbieter" value={a.art} checked={art === a.art} onChange={() => setArt(a.art)} />
                <span class="anbieter-titel">{managed && a.art === 'openai' ? 'Europäischer Anbieter' : a.titel}</span>
                <span class="anbieter-unter">{managed && a.art === 'openai' ? 'Mistral, IONOS, STACKIT oder Scaleway mit eurem Schlüssel.' : a.unter}</span>
              </label>
            ))}
          </div>
          {ausListe && (
            <Feld label="Anbieter">
              {(p) => (
                <div class="auswahl">
                  <select {...p} class="eingabe" value={vid} onChange={(x) => setVid((x.target as HTMLSelectElement).value)}>
                    {vor
                      .filter((x) => x.art === 'openai')
                      .map((x) => (
                        <option key={x.id} value={x.id}>
                          {x.name}
                        </option>
                      ))}
                  </select>
                  <Icon name="pfeilRunter" groesse={16} klasse="auswahl-pfeil" />
                </div>
              )}
            </Feld>
          )}
          {(art === 'ollama' || (art === 'openai' && !ausListe)) && (
            <Feld label="Adresse des Servers" fehler={fehler.url} hilfe={art === 'openai' ? 'Die Basis-Adresse der API, endet meist auf /v1.' : undefined}>
              {(p) => <input {...p} class="eingabe" type="url" value={url} onInput={(x) => setUrl((x.target as HTMLInputElement).value)} />}
            </Feld>
          )}
          {art !== 'mock' && (
            <div class="feld-reihe">
              <Feld label="Modell für Antworten" fehler={fehler.chat} hilfe={ausListe ? 'Leer lassen für die Empfehlung.' : undefined}>
                {(p) => <input {...p} class="eingabe" type="text" placeholder={art === 'ollama' ? 'z. B. qwen2.5:14b' : art === 'anthropic' ? 'z. B. claude-sonnet' : 'z. B. mistral-small-latest'} value={chat} onInput={(x) => setChat((x.target as HTMLInputElement).value)} />}
              </Feld>
              <Feld label="Modell für die Suche (Embedding)" hilfe="Optional. Empfehlung: bge-m3 oder multilingual-e5. Ohne läuft die Volltextsuche.">
                {(p) => <input {...p} class="eingabe" type="text" value={embed} onInput={(x) => setEmbed((x.target as HTMLInputElement).value)} />}
              </Feld>
            </div>
          )}
          {(art === 'openai' || art === 'anthropic') && (
            <Feld
              label="API-Schlüssel"
              fehler={fehler.key}
              hilfe={e.provider.hatSchluessel && e.provider.art === art ? 'Ein Schlüssel ist gespeichert. Nur ausfüllen, wenn du ihn ersetzen willst.' : 'Wird verschlüsselt gespeichert und nie wieder angezeigt. Nach einem Umzug neu eingeben.'}
            >
              {(p) => <input {...p} class="eingabe" type="password" autocomplete="off" placeholder={e.provider.hatSchluessel && e.provider.art === art ? '•••••••• gespeichert' : ''} value={schluessel} onInput={(x) => setSchluessel((x.target as HTMLInputElement).value)} />}
            </Feld>
          )}
          {art === 'anthropic' && <p class="klein-text datenfluss">{(e.voreinstellungen ?? []).find((x) => x.id === 'anthropic')?.datenfluss ?? 'Fragen und gefundene Abschnitte gehen an Anthropic, Server in den USA (Drittland).'}</p>}
          {kannAendern && (
            <div class="knopf-reihe">
              <Knopf art="primaer" type="submit" laedt={laedt === 'speichern'} icon="haken">
                Speichern
              </Knopf>
              <KnopfLink art="leise" href="#/einstellungen/datenweg" iconRechts="pfeil">
                Wohin gehen meine Daten?
              </KnopfLink>
            </div>
          )}
          {kannAendern && <p class="meta-klein">Nach jedem Wechsel steht der Prüfstatus auf „noch nicht geprüft“, bis die Prüfbank gelaufen ist.</p>}
        </fieldset>
      </form>
    </div>
  );
}

function Datenweg({ admin }: { admin: boolean }) {
  const r = useLaden(() => api.datenweg(), []);
  if (r.laedt) return <Laedt />;
  if (r.fehler || !r.daten) return <Fehlerhinweis text={r.fehler ?? ''} nochmal={r.neu} />;
  const d = r.daten;
  return (
    <div class="datenweg">
      <ol class="datenweg-kette" aria-label="Weg der Daten">
        <li>
          <span class="datenweg-knoten">
            <Icon name="person" />
          </span>
          <span class="datenweg-name">Dein Browser</span>
          <span class="datenweg-ort">Frage eintippen</span>
        </li>
        <li>
          <span class="datenweg-knoten">
            <Icon name="betrieb" />
          </span>
          <span class="datenweg-name">{PRODUKT}-Server</span>
          <span class="datenweg-ort">Suche, Rechte, Belege</span>
        </li>
        <li class={d.lokal ? 'lokal' : 'extern'}>
          <span class="datenweg-knoten">
            <Icon name={d.lokal ? 'schloss' : 'web'} />
          </span>
          <span class="datenweg-name">{d.anbieter}</span>
          <span class="datenweg-ort">{d.region ?? 'Region unbekannt'}</span>
        </li>
      </ol>
      <dl class="artikel-meta">
        <div>
          <dt>Anbieter</dt>
          <dd>{d.anbieter}</dd>
        </div>
        <div>
          <dt>Endpunkt</dt>
          <dd class={admin ? 'mono umbruch' : ''}>{!d.endpunkt ? 'keiner, alles bleibt hier' : admin ? d.endpunkt : 'nur für Admins sichtbar'}</dd>
        </div>
        <div>
          <dt>Region</dt>
          <dd>{d.region ?? 'unbekannt'}</dd>
        </div>
        <div>
          <dt>Verlässt den Server</dt>
          <dd>{d.lokal ? 'Nein' : 'Ja'}</dd>
        </div>
      </dl>
      {d.hinweis && (
        <Hinweis art={d.lokal ? 'info' : 'warnung'} icon={d.lokal ? 'info' : 'warnung'}>
          <p>{d.hinweis}</p>
        </Hinweis>
      )}
      <div class="datenweg-listen">
        <section>
          <h3>Was dorthin geht</h3>
          {d.daten.length ? (
            <ul>
              {d.daten.map((x) => (
                <li key={x}>{x}</li>
              ))}
            </ul>
          ) : (
            <p class="klein-text">Nichts.</p>
          )}
        </section>
        {!!d.apps?.length && (
          <section>
            <h3>Verbundene Apps</h3>
            <ul>
              {d.apps.map((a) => (
                <li key={a.name}>
                  {a.name}: Treffer und Antworten gehen an {a.anbieter ?? 'den Anbieter der App'}
                </li>
              ))}
            </ul>
          </section>
        )}
        {d.nie && (
          <section>
            <h3>Was nie dorthin geht</h3>
            <ul>
              {d.nie.map((x) => (
                <li key={x}>{x}</li>
              ))}
            </ul>
          </section>
        )}
      </div>
    </div>
  );
}

function Benutzer() {
  const { melde } = useApp();
  const r = useLaden(() => api.benutzer(), []);
  const { einstellungen } = useApp();
  const [offen, setOffen] = useState(false);
  const [name, setName] = useState('');
  const [pw, setPw] = useState('');
  const [rollen, setRollen] = useState<Rolle[]>(['leser', 'autor']);
  const [teams, setTeams] = useState<string[]>([]);
  const [fehler, setFehler] = useState<string | null>(null);
  const [laedt, setLaedt] = useState(false);
  const { ich } = useApp();
  const [aktion, setAktion] = useState<{ art: 'passwort' | 'tokens'; u: { id: string; name: string } } | null>(null);
  const [einmal, setEinmal] = useState<string | null>(null);
  const fuehreAus = async () => {
    if (!aktion) return;
    setLaedt(true);
    try {
      if (aktion.art === 'passwort') {
        const r = await api.setzePasswortZurueck(aktion.u.id);
        setEinmal(r.einmalPasswort);
      } else {
        await api.widerrufeTokensVon(aktion.u.id);
        melde(`Alle Schlüssel von ${aktion.u.name} sind widerrufen.`);
        setAktion(null);
      }
    } catch (err) {
      melde(fehlerText(err), 'fehler');
      setAktion(null);
    } finally {
      setLaedt(false);
    }
  };
  const schliesseAktion = () => {
    setAktion(null);
    setEinmal(null);
  };
  const senden = async (e: Event) => {
    e.preventDefault();
    if (!name.trim()) return setFehler('Bitte einen Namen eingeben.');
    if (pw.length < 10) return setFehler('Das Passwort braucht mindestens 10 Zeichen.');
    setLaedt(true);
    setFehler(null);
    try {
      const u = await api.legeBenutzerAn({ name: name.trim(), passwort: pw, rollen, teams });
      r.setze([...(r.daten ?? []), u]);
      melde(`${u.name} ist angelegt. Gib das Passwort persönlich weiter.`);
      setOffen(false);
      setName('');
      setPw('');
    } catch (err) {
      setFehler(fehlerText(err));
    } finally {
      setLaedt(false);
    }
  };
  if (r.laedt) return <Laedt />;
  if (r.fehler) return <Fehlerhinweis text={r.fehler} nochmal={r.neu} />;
  return (
    <div>
      <div class="knopf-reihe knopf-reihe--zwischen">
        <p class="klein-text">
          {r.daten?.length} Benutzer. Rollen bauen aufeinander auf: Lesen, Vorschlagen, Freigeben, Verwalten.
        </p>
        <Knopf art="primaer" icon="neu" onClick={() => setOffen(true)}>
          Benutzer anlegen
        </Knopf>
      </div>
      <ul class="benutzer-liste">
        {r.daten?.map((u) => (
          <li key={u.id} class="benutzer-zeile">
            <span class="avatar" aria-hidden="true">
              {u.name
                .split(' ')
                .map((t) => t[0])
                .join('')
                .slice(0, 2)}
            </span>
            <span class="benutzer-name">
              {u.name}
              <span class="meta-klein">{u.teams.length ? u.teams.map(teamName).join(', ') : 'kein Team'}</span>
            </span>
            <span class="chip-reihe">
              {u.rollen.map((ro) => (
                <Chip key={ro} art={ro === 'admin' ? 'akzent' : ''}>
                  {ROLLEN_TEXT[ro] ?? ro}
                </Chip>
              ))}
            </span>
            {u.id !== ich.id && (
              <span class="benutzer-aktionen">
                <Knopf klein art="leise" icon="schloss" aria-label={`Passwort von ${u.name} zurücksetzen`} onClick={() => setAktion({ art: 'passwort', u })}>
                  Passwort
                </Knopf>
                <Knopf klein art="leise" icon="kreuz" aria-label={`Schlüssel von ${u.name} widerrufen`} onClick={() => setAktion({ art: 'tokens', u })}>
                  Schlüssel
                </Knopf>
              </span>
            )}
          </li>
        ))}
      </ul>
      <Dialog
        offen={!!aktion}
        schliessen={schliesseAktion}
        titel={aktion?.art === 'passwort' ? (einmal ? 'Einmal-Passwort' : 'Passwort zurücksetzen?') : 'Alle Schlüssel widerrufen?'}
        beschreibung={
          einmal
            ? undefined
            : aktion?.art === 'passwort'
              ? `${aktion.u.name} wird überall abgemeldet und bekommt ein Einmal-Passwort. Beim nächsten Anmelden muss ein eigenes her. Alle Schlüssel für KI-Werkzeuge werden widerrufen.`
              : `Alle Werkzeuge, die mit Schlüsseln von ${aktion?.u.name ?? ''} arbeiten, kommen sofort nicht mehr rein. Neue Schlüssel kann nur die Person selbst anlegen.`
        }
      >
        {einmal ? (
          <div class="formular">
            <p>Gib dieses Passwort persönlich oder am Telefon weiter, nicht per Mail. Es wird nur jetzt angezeigt.</p>
            <code class="token mono">{einmal}</code>
            <div class="knopf-reihe knopf-reihe--ende">
              <Knopf art="primaer" icon="haken" onClick={schliesseAktion}>
                Fertig
              </Knopf>
            </div>
          </div>
        ) : (
          <div class="knopf-reihe knopf-reihe--ende">
            <Knopf art="leise" onClick={schliesseAktion}>
              Abbrechen
            </Knopf>
            <Knopf art="gefahr" laedt={laedt} onClick={fuehreAus}>
              {aktion?.art === 'passwort' ? 'Ja, zurücksetzen' : 'Ja, widerrufen'}
            </Knopf>
          </div>
        )}
      </Dialog>
      <Dialog offen={offen} schliessen={() => setOffen(false)} titel="Benutzer anlegen">
        <form onSubmit={senden} class="formular" noValidate>
          <Feld label="Name">{(p) => <input {...p} class="eingabe" type="text" autocomplete="off" value={name} onInput={(e) => setName((e.target as HTMLInputElement).value)} />}</Feld>
          <Feld label="Erstes Passwort" hilfe="Mindestens 10 Zeichen. Die Person ändert es später selbst.">
            {(p) => <input {...p} class="eingabe" type="text" autocomplete="new-password" value={pw} onInput={(e) => setPw((e.target as HTMLInputElement).value)} />}
          </Feld>
          <fieldset class="formular-gruppe">
            <legend class="feld-label">Darf</legend>
            <div class="haken-liste">
              {(['leser', 'autor', 'freigeber', 'admin'] as Rolle[]).map((ro) => (
                <label key={ro} class="schalter-zeile">
                  <input type="checkbox" checked={rollen.includes(ro)} onChange={(e) => setRollen((x) => ((e.target as HTMLInputElement).checked ? [...x, ro] : x.filter((y) => y !== ro)))} />
                  <span>{ROLLEN_TEXT[ro]}</span>
                </label>
              ))}
            </div>
          </fieldset>
          {!!einstellungen?.teams.length && (
            <fieldset class="formular-gruppe">
              <legend class="feld-label">Teams</legend>
              <div class="haken-liste">
                {einstellungen.teams.map((t) => (
                  <label key={t} class="schalter-zeile">
                    <input type="checkbox" checked={teams.includes(t)} onChange={(e) => setTeams((x) => ((e.target as HTMLInputElement).checked ? [...x, t] : x.filter((y) => y !== t)))} />
                    <span>{teamName(t)}</span>
                  </label>
                ))}
              </div>
            </fieldset>
          )}
          {fehler && <Fehlerhinweis text={fehler} />}
          <div class="knopf-reihe knopf-reihe--ende">
            <Knopf art="leise" onClick={() => setOffen(false)}>
              Abbrechen
            </Knopf>
            <Knopf art="primaer" type="submit" laedt={laedt} icon="haken">
              Anlegen
            </Knopf>
          </div>
        </form>
      </Dialog>
    </div>
  );
}

function tageBis(iso: string | null): number | null {
  if (!iso) return null;
  return Math.ceil((new Date(iso).getTime() - Date.now()) / 86400000);
}

function kopiereText(text: string, melde: (t: string, a?: 'ok' | 'fehler' | 'info') => void, ok: () => void) {
  navigator.clipboard.writeText(text).then(ok, () => melde('Kopieren ging nicht. Markier den Text und kopier ihn von Hand.', 'fehler'));
}

/** S1 M2/M3/M5: Schlüssel nur für sich selbst, mit Rechten und Ablauf, einzeln widerrufbar. */
function Zugang() {
  const { ich, melde } = useApp();
  const r = useLaden(() => api.tokens(), []);
  const [neuOffen, setNeuOffen] = useState(false);
  const [bezeichnung, setBezeichnung] = useState('');
  const [scopes, setScopes] = useState<TokenScope[]>(['kern:lesen', 'kern:fragen']);
  const [tage, setTage] = useState(90);
  const [laedt, setLaedt] = useState(false);
  const [fehler, setFehler] = useState<string | null>(null);
  const [neu, setNeu] = useState<NeuesToken | null>(null);
  const [kopiert, setKopiert] = useState('');
  const [weg, setWeg] = useState<ZugangsToken | null>(null);
  const mcpUrl = `${location.origin}${location.pathname.replace(/[^/]*$/, '')}mcp`;
  const admin = darf.verwalten(ich);

  const anlegen = async (ev: Event) => {
    ev.preventDefault();
    if (!bezeichnung.trim()) return setFehler('Gib dem Schlüssel einen Namen, damit du ihn später wiedererkennst.');
    if (!scopes.length) return setFehler('Wähl mindestens ein Recht.');
    setFehler(null);
    setLaedt(true);
    try {
      const t = await api.legeTokenAn({ bezeichnung: bezeichnung.trim(), scopes, gueltigTage: tage });
      setNeu(t);
      r.setze([t.eintrag, ...(r.daten ?? [])]);
      setBezeichnung('');
    } catch (err) {
      setFehler(fehlerText(err));
    } finally {
      setLaedt(false);
    }
  };
  const widerrufen = async () => {
    if (!weg) return;
    setLaedt(true);
    try {
      await api.widerrufeToken(weg.id);
      r.setze((r.daten ?? []).filter((t) => t.id !== weg.id));
      melde(`„${weg.bezeichnung}“ ist widerrufen. Werkzeuge mit diesem Schlüssel kommen nicht mehr rein.`);
      setWeg(null);
    } catch (err) {
      melde(fehlerText(err), 'fehler');
    } finally {
      setLaedt(false);
    }
  };
  const schliesseNeu = () => {
    setNeuOffen(false);
    setNeu(null);
    setFehler(null);
  };
  const konfig = JSON.stringify({ mcpServers: { [PRODUKT.toLowerCase()]: { type: 'http', url: mcpUrl, headers: { Authorization: `Bearer ${neu?.token ?? '<dein-schlüssel>'}` } } } }, null, 2);

  return (
    <div class="zugang">
      <p class="klein-text">
        Für Programme ohne Anmeldefenster, zum Beispiel ein eigener Agent oder lokales MCP. Jeder Schlüssel hat höchstens deine Rechte, nur die Häkchen, die du setzt, und ein Ablaufdatum. Schreiben kann kein Programm, nur Vorschläge in den Eingang legen.
      </p>
      <p class="hinweis hinweis--info">
        <Icon name="schild" groesse={20} />
        <span>Schlüssel gelten nur für dich. Auch Admins können keine Schlüssel für andere anlegen, nur fremde widerrufen.</span>
      </p>
      <div class="knopf-reihe knopf-reihe--zwischen">
        <p class="klein-text">{r.daten ? `${r.daten.length} ${r.daten.length === 1 ? 'Schlüssel' : 'Schlüssel'} aktiv` : ' '}</p>
        <Knopf art="primaer" icon="neu" onClick={() => setNeuOffen(true)}>
          Neuer Schlüssel
        </Knopf>
      </div>
      {r.laedt && <Laedt />}
      {r.fehler && <Fehlerhinweis text={r.fehler} nochmal={r.neu} />}
      {r.daten && (
        <ul class="token-liste">
          {r.daten.map((t) => {
            const rest = tageBis(t.laeuftAb);
            return (
              <li key={t.id} class="token-zeile">
                <div class="token-haupt">
                  <p class="token-name">{t.bezeichnung}</p>
                  <ul class="chip-reihe" aria-label="Rechte">
                    {t.scopes.map((sc) => (
                      <li key={sc} class={`chip${sc === 'kern:verwalten' ? ' chip--warn' : ''}`}>
                        {SCOPE_TEXT[sc]?.titel ?? sc}
                      </li>
                    ))}
                  </ul>
                </div>
                <dl class="token-daten">
                  <div>
                    <dt>Läuft ab</dt>
                    <dd class={rest !== null && rest <= 7 ? 'bald' : ''}>{t.laeuftAb ? `${datum(t.laeuftAb)}${rest !== null && rest <= 7 ? ` (in ${rest} ${rest === 1 ? 'Tag' : 'Tagen'})` : ''}` : 'nie'}</dd>
                  </div>
                  <div>
                    <dt>Zuletzt benutzt</dt>
                    <dd>{t.zuletzt ? datum(t.zuletzt) : 'noch nie'}</dd>
                  </div>
                </dl>
                <Knopf klein art="gefahr" icon="kreuz" aria-label={`${t.bezeichnung} widerrufen`} onClick={() => setWeg(t)}>
                  Widerrufen
                </Knopf>
              </li>
            );
          })}
          {!r.daten.length && <li class="klein-text leer-zeile">Noch kein Schlüssel. Leg einen an, wenn ein Werkzeug Zugriff braucht.</li>}
        </ul>
      )}

      <Dialog offen={neuOffen} schliessen={schliesseNeu} titel={neu ? 'Dein neuer Schlüssel' : 'Neuer Schlüssel'} breit>
        {neu ? (
          <div class="formular">
            <p class="hinweis hinweis--warnung">
              <Icon name="warnung" groesse={20} />
              <span>Der Schlüssel wird nur jetzt angezeigt. Kopier ihn in dein Werkzeug. Wer ihn hat, kommt mit diesen Rechten an euer Wissen.</span>
            </p>
            <code class="token mono">{neu.token}</code>
            <div class="knopf-reihe">
              <Knopf klein icon={kopiert === 't' ? 'haken' : 'kopieren'} onClick={() => kopiereText(neu.token, melde, () => setKopiert('t'))}>
                {kopiert === 't' ? 'Kopiert' : 'Schlüssel kopieren'}
              </Knopf>
            </div>
            <pre class="code-block" tabIndex={0} aria-label="Beispiel-Konfiguration">
              {konfig}
            </pre>
            <div class="knopf-reihe knopf-reihe--zwischen">
              <Knopf klein art="leise" icon={kopiert === 'k' ? 'haken' : 'kopieren'} onClick={() => kopiereText(konfig, melde, () => setKopiert('k'))}>
                {kopiert === 'k' ? 'Kopiert' : 'Konfiguration kopieren'}
              </Knopf>
              <Knopf art="primaer" icon="haken" onClick={schliesseNeu}>
                Fertig
              </Knopf>
            </div>
          </div>
        ) : (
          <form class="formular" onSubmit={anlegen} noValidate>
            <F12Hinweis />
            <Feld label="Wofür ist der Schlüssel?" hilfe="Zum Beispiel „Claude Desktop im Büro“ oder „Nachtlauf-Agent“.">
              {(p) => <input {...p} class="eingabe" type="text" autocomplete="off" value={bezeichnung} onInput={(x) => setBezeichnung((x.target as HTMLInputElement).value)} />}
            </Feld>
            <fieldset class="formular-gruppe">
              <legend class="feld-label">Was darf das Werkzeug?</legend>
              <div class="haken-liste haken-liste--erklaert">
                {(Object.keys(SCOPE_TEXT) as TokenScope[])
                  .filter((sc) => sc !== 'kern:verwalten' || admin)
                  .map((sc) => (
                    <label key={sc} class="schalter-zeile">
                      <input type="checkbox" checked={scopes.includes(sc)} onChange={(e) => setScopes((x) => ((e.target as HTMLInputElement).checked ? [...x, sc] : x.filter((y) => y !== sc)))} />
                      <span>
                        <span class="schalter-titel">{SCOPE_TEXT[sc].titel}</span>
                        <span class="feld-hilfe">{SCOPE_TEXT[sc].unter}</span>
                      </span>
                    </label>
                  ))}
              </div>
            </fieldset>
            <Feld label="Gültig für">
              {(p) => (
                <div class="auswahl">
                  <select {...p} class="eingabe" value={tage} onChange={(x) => setTage(Number((x.target as HTMLSelectElement).value))}>
                    <option value={7}>7 Tage</option>
                    <option value={30}>30 Tage</option>
                    <option value={90}>90 Tage</option>
                    <option value={365}>1 Jahr</option>
                  </select>
                  <Icon name="pfeilRunter" groesse={16} klasse="auswahl-pfeil" />
                </div>
              )}
            </Feld>
            {fehler && <Fehlerhinweis text={fehler} />}
            <div class="knopf-reihe knopf-reihe--ende">
              <Knopf art="leise" onClick={schliesseNeu}>
                Abbrechen
              </Knopf>
              <Knopf art="primaer" type="submit" laedt={laedt} icon="schloss">
                Schlüssel erstellen
              </Knopf>
            </div>
          </form>
        )}
      </Dialog>

      <Dialog offen={!!weg} schliessen={() => setWeg(null)} titel="Schlüssel widerrufen?" beschreibung={weg ? `„${weg.bezeichnung}“ hört sofort auf zu funktionieren. Das lässt sich nicht rückgängig machen.` : ''}>
        <div class="knopf-reihe knopf-reihe--ende">
          <Knopf art="leise" onClick={() => setWeg(null)}>
            Abbrechen
          </Knopf>
          <Knopf art="gefahr" laedt={laedt} onClick={widerrufen}>
            Ja, widerrufen
          </Knopf>
        </div>
      </Dialog>
    </div>
  );
}

/** S1 M3: Passwort ändern, Geräte sehen, einzeln oder überall abmelden. */
function Konto() {
  const { ich, melde, abmelden } = useApp();
  const g = useLaden(() => api.geraete(), []);
  const [alt, setAlt] = useState('');
  const [neu, setNeu] = useState('');
  const [wdh, setWdh] = useState('');
  const [fehler, setFehler] = useState<string | null>(null);
  const [laedt, setLaedt] = useState<'' | 'pw' | 'alle'>('');
  const [ueberall, setUeberall] = useState(false);

  const pwAendern = async (ev: Event) => {
    ev.preventDefault();
    if (!alt) return setFehler('Gib dein bisheriges Passwort ein.');
    if (neu.length < 10) return setFehler('Das neue Passwort braucht mindestens 10 Zeichen.');
    if (neu !== wdh) return setFehler('Die beiden neuen Passwörter sind nicht gleich.');
    setFehler(null);
    setLaedt('pw');
    try {
      await api.aenderePasswort(alt, neu);
      setAlt('');
      setNeu('');
      setWdh('');
      g.neu();
      melde('Passwort geändert. Alle anderen Geräte sind abgemeldet, alle Schlüssel für KI-Werkzeuge widerrufen.');
    } catch (err) {
      setFehler(fehlerText(err));
    } finally {
      setLaedt('');
    }
  };
  const geraetAbmelden = async (id: string) => {
    try {
      await api.meldeGeraetAb(id);
      g.setze((g.daten ?? []).filter((x) => x.id !== id));
      melde('Gerät abgemeldet.');
    } catch (err) {
      melde(fehlerText(err), 'fehler');
    }
  };
  const alleAbmelden = async () => {
    setLaedt('alle');
    try {
      const r = await api.abmeldenUeberall();
      melde(`Überall abgemeldet. ${r.tokensWiderrufen} ${r.tokensWiderrufen === 1 ? 'Schlüssel' : 'Schlüssel'} widerrufen.`);
      await abmelden();
    } catch (err) {
      melde(fehlerText(err), 'fehler');
      setLaedt('');
    }
  };

  return (
    <div class="konto">
      <section aria-labelledby="pw-titel">
        <h3 id="pw-titel" class="abschnitt-titel">
          Passwort ändern
        </h3>
        <form class="formular formular--schmal" onSubmit={pwAendern} noValidate>
          <input type="text" class="sr-only" autocomplete="username" value={ich.name} readOnly tabIndex={-1} aria-hidden="true" />
          <Feld label="Bisheriges Passwort">
            {(p) => <input {...p} class="eingabe" type="password" autocomplete="current-password" value={alt} onInput={(x) => setAlt((x.target as HTMLInputElement).value)} />}
          </Feld>
          <Feld label="Neues Passwort" hilfe="Mindestens 10 Zeichen.">
            {(p) => <input {...p} class="eingabe" type="password" autocomplete="new-password" value={neu} onInput={(x) => setNeu((x.target as HTMLInputElement).value)} />}
          </Feld>
          <Feld label="Neues Passwort wiederholen">
            {(p) => <input {...p} class="eingabe" type="password" autocomplete="new-password" value={wdh} onInput={(x) => setWdh((x.target as HTMLInputElement).value)} />}
          </Feld>
          {fehler && <Fehlerhinweis text={fehler} />}
          <p class="klein-text">Danach sind alle anderen Geräte abgemeldet und alle Schlüssel für KI-Werkzeuge widerrufen. Dieses Gerät bleibt angemeldet.</p>
          <div class="knopf-reihe">
            <Knopf art="primaer" type="submit" laedt={laedt === 'pw'} icon="schloss">
              Passwort ändern
            </Knopf>
          </div>
        </form>
      </section>

      <section aria-labelledby="geraete-titel" class="artikel-abschnitt">
        <h3 id="geraete-titel" class="abschnitt-titel">
          Angemeldete Geräte
        </h3>
        {g.laedt && <Laedt />}
        {g.fehler && <Fehlerhinweis text={g.fehler} nochmal={g.neu} />}
        {g.daten && (
          <ul class="geraete-liste">
            {g.daten.map((x) => (
              <li key={x.id} class="geraet-zeile">
                <Icon name={x.aktuell ? 'person' : 'web'} groesse={18} />
                <span class="geraet-name">
                  {x.geraet}
                  {x.aktuell && <span class="chip chip--ok">dieses Gerät</span>}
                  <span class="meta-klein">
                    angemeldet {datum(x.erstellt)}, zuletzt aktiv {datum(x.zuletzt)}
                  </span>
                </span>
                {!x.aktuell && (
                  <Knopf klein art="leise" icon="abmelden" aria-label={`${x.geraet} abmelden`} onClick={() => void geraetAbmelden(x.id)}>
                    Abmelden
                  </Knopf>
                )}
              </li>
            ))}
          </ul>
        )}
        <div class="gefahr-zone">
          <div>
            <p class="schalter-titel">Überall abmelden</p>
            <p class="klein-text">Beendet alle Sitzungen, auch diese, und widerruft alle deine Schlüssel. Sinnvoll, wenn ein Gerät verloren ist.</p>
          </div>
          <Knopf art="gefahr" icon="abmelden" onClick={() => setUeberall(true)}>
            Überall abmelden
          </Knopf>
        </div>
      </section>

      <Dialog offen={ueberall} schliessen={() => setUeberall(false)} titel="Überall abmelden?" beschreibung="Alle Geräte werden abgemeldet, auch dieses. Alle Schlüssel für KI-Werkzeuge hören sofort auf zu funktionieren.">
        <div class="knopf-reihe knopf-reihe--ende">
          <Knopf art="leise" onClick={() => setUeberall(false)}>
            Abbrechen
          </Knopf>
          <Knopf art="gefahr" laedt={laedt === 'alle'} onClick={alleAbmelden}>
            Ja, überall abmelden
          </Knopf>
        </div>
      </Dialog>
    </div>
  );
}

const EXPORT_ARTEN: { art: ExportArt; titel: string; unter: string; admin?: boolean }[] = [
  { art: 'zip', titel: 'ZIP mit Verlauf', unter: 'Euer Ordner mit Artikeln, Quellen, Originalen und git-Verlauf. Lesbar ohne dieses Programm, zum Beispiel in Obsidian.' },
  { art: 'okf', titel: 'Offenes Format (OKF)', unter: 'Für andere Werkzeuge. Markdown mit YAML-Kopf, nur was du sehen darfst.' },
  { art: 'umzugspaket', titel: 'Umzugspaket', unter: 'Vollständig und verschlüsselt, für den Umzug in die eigene Cloud oder auf einen Rechner im Haus.', admin: true },
];

function groesseText(b?: number) {
  if (!b) return '';
  return b > 1e6 ? `${(b / 1e6).toLocaleString('de-DE', { maximumFractionDigits: 1 })} MB` : `${Math.max(1, Math.round(b / 1e3))} kB`;
}

/** v1.4 7.1 und 7.3: drei Exportarten, Ausstiegsprobe. Export ab der ersten Sitzung, auch im Modus nur_lesen. */
function WissenGehoertDir() {
  const { ich, melde } = useApp();
  const admin = darf.verwalten(ich);
  const ein = useLaden(() => (admin ? api.einrichtung() : Promise.resolve(null)), []);
  const probe = useLaden(() => (admin ? api.ausstiegsprobe() : Promise.resolve(null)), []);
  const [art, setArt] = useState<ExportArt>('zip');
  const [passphrase, setPassphrase] = useState('');
  const [auftrag, setAuftrag] = useState<ExportAuftrag | null>(null);
  const [laedt, setLaedt] = useState<'' | 'export' | 'probe'>('');
  const [fehler, setFehler] = useState<string | null>(null);

  const exportieren = async (ev: Event) => {
    ev.preventDefault();
    if (art === 'umzugspaket' && passphrase.length < 12) return setFehler('Das Umzugspaket braucht eine Passphrase mit mindestens 12 Zeichen. Ohne sie lässt es sich nicht öffnen, auch nicht von uns.');
    setFehler(null);
    setLaedt('export');
    setAuftrag({ status: 'laeuft' });
    try {
      const { id } = await api.starteExport(art, art === 'umzugspaket' ? passphrase : undefined);
      for (let i = 0; i < 120; i++) {
        const st = await api.exportStand(id);
        setAuftrag(st);
        if (st.status !== 'laeuft') break;
        await new Promise((r) => setTimeout(r, 1000));
      }
    } catch (err) {
      setFehler(fehlerText(err));
      setAuftrag(null);
    } finally {
      setLaedt('');
    }
  };
  const probeStarten = async () => {
    setLaedt('probe');
    try {
      await api.starteAusstiegsprobe();
      probe.neu();
      melde('Ausstiegsprobe gestartet. Das Ergebnis steht gleich hier.');
    } catch (err) {
      melde(fehlerText(err), 'fehler');
    } finally {
      setLaedt('');
    }
  };
  const beispielWeg = async () => {
    try {
      await api.einrichtungBeispiel('entfernen');
      ein.neu();
      melde('Beispiel entfernt.');
    } catch (err) {
      melde(fehlerText(err), 'fehler');
    }
  };
  const arten = EXPORT_ARTEN.filter((a) => !a.admin || admin);
  const p = probe.daten;
  return (
    <div class="eigentum">
      <div class="eigentum-kopf">
        <p class="eigentum-satz">Euer Wissen liegt als normale Textdateien in einem Ordner mit Versionsverlauf. Ihr könnt es jederzeit vollständig mitnehmen, kostenlos und ohne uns zu fragen.</p>
        <ul class="eigentum-fakten">
          <li>
            <span class="mono">.md</span> Markdown mit YAML-Kopf, lesbar in jedem Editor
          </li>
          <li>
            <span class="mono">.git</span> jede Freigabe mit Autor, Datum und Grund
          </li>
          <li>
            <span class="mono">orig</span> eure Originaldateien unverändert
          </li>
        </ul>
      </div>

      <form class="formular" onSubmit={exportieren} noValidate>
        <fieldset class="formular-gruppe">
          <legend class="feld-label">Was möchtest du herunterladen?</legend>
          <div class="weg-karten">
            {arten.map((a) => (
              <label key={a.art} class={`weg-karte${art === a.art ? ' aktiv' : ''}`}>
                <input type="radio" name="exportart" value={a.art} checked={art === a.art} onChange={() => setArt(a.art)} />
                <span class="weg-titel">{a.titel}</span>
                <span class="weg-unter">{a.unter}</span>
              </label>
            ))}
          </div>
        </fieldset>
        {art === 'umzugspaket' && (
          <Feld label="Passphrase für das Paket" hilfe="Mindestens 12 Zeichen. Schreib sie dir auf; ohne sie lässt sich das Paket nicht öffnen. KI-Schlüssel sind nicht enthalten und werden nach dem Umzug neu eingegeben.">
            {(pr) => <input {...pr} class="eingabe" type="password" autocomplete="new-password" value={passphrase} onInput={(x) => setPassphrase((x.target as HTMLInputElement).value)} />}
          </Feld>
        )}
        {art !== 'umzugspaket' && !admin && <p class="meta-klein">Der Export enthält, was du sehen darfst. Fremde private Notizen sind nicht dabei.</p>}
        {fehler && <Fehlerhinweis text={fehler} />}
        <div class="knopf-reihe">
          <Knopf art="primaer" type="submit" laedt={laedt === 'export'} icon="herunterladen">
            Export erstellen
          </Knopf>
          {auftrag?.status === 'laeuft' && <span class="meta-klein" role="status">Wird gepackt …</span>}
          {auftrag?.status === 'fertig' && auftrag.link && (
            <KnopfLink href={auftrag.link} icon="herunterladen" download={MOCK ? `${PRODUKT.toLowerCase()}-demo-export.json` : undefined}>
              Herunterladen{auftrag.bytes ? ` (${groesseText(auftrag.bytes)})` : ''}
            </KnopfLink>
          )}
          {auftrag?.status === 'fehler' && <span class="meta-klein">Der Export ist fehlgeschlagen. Versuch es nochmal.</span>}
        </div>
        {auftrag?.status === 'fertig' && auftrag.bereit_bis && <p class="meta-klein">Der Link gilt bis {datum(auftrag.bereit_bis)} und nur für dich.</p>}
      </form>

      {admin && (
        <section class="eigentum-block" aria-labelledby="probe-titel">
          <div>
            <h3 id="probe-titel" class="eigentum-titel">
              Ausstiegsprobe
            </h3>
            <p class="klein-text">
              {p
                ? `Zuletzt am ${datum(p.am)}: ${p.bestanden ? 'bestanden' : 'nicht bestanden'}. Umzugspaket wieder ausgepackt und geprüft, ${p.offen.dateien} Dateien im offenen Format ohne ${PRODUKT} lesbar${p.offen.fundstellenKaputt ? `, ${p.offen.fundstellenKaputt} kaputte Fundstellen` : ''}.`
                : `Prüft, ob ihr wirklich ohne Verlust gehen könnt: Umzugspaket packen, in einen leeren Ordner auspacken, vergleichen, und den OKF-Export ohne ${PRODUKT} lesen.`}
            </p>
          </div>
          <Knopf icon="schild" laedt={laedt === 'probe'} onClick={probeStarten}>
            Probe starten
          </Knopf>
        </section>
      )}

      <section class="artikel-abschnitt" aria-labelledby="umzug-titel">
        <h3 id="umzug-titel" class="abschnitt-titel">
          Umziehen, zum Beispiel in die eigene Cloud
        </h3>
        <ol class="umzug-schritte">
          <li>Umzugspaket herunterladen.</li>
          <li>
            In der neuen Installation auspacken: <code class="mono">{PRODUKT.toLowerCase()} umzug auspacken paket.tar.age ./daten</code>
          </li>
          <li>
            Prüfen: <code class="mono">{PRODUKT.toLowerCase()} umzug pruefen ./daten</code> vergleicht Prüfsummen, Verlauf und Antworten.
          </li>
          <li>Wenn alles stimmt, die alte Instanz löschen. Im betreuten Betrieb geht das unter Konto, mit Bestätigung per Mail.</li>
        </ol>
        <p class="meta-klein">
          Andere Quellen wie Obsidian, Notion oder Outline: <a href="#/hinzufuegen?art=import">Hinzufügen › Import</a>
        </p>
      </section>

      {admin && ein.daten?.beispiel_geladen && (
        <section class="eigentum-block" aria-labelledby="bsp-titel">
          <div>
            <h3 id="bsp-titel" class="eigentum-titel">
              Beispiel Tischlerei Wendt
            </h3>
            <p class="klein-text">Die erfundenen Beispieldaten sind noch geladen. Entfernen löscht sie ohne Rest.</p>
          </div>
          <Knopf art="gefahr" icon="kreuz" onClick={beispielWeg}>
            Beispiel entfernen
          </Knopf>
        </section>
      )}
    </div>
  );
}

const STATUS_TEXT: Record<KontoT['status'], string> = {
  angelegt: 'wird eingerichtet',
  test: 'Testphase',
  test_abgelaufen: 'Testphase beendet, nur lesen',
  aktiv: 'aktiv',
  zahlung_offen: 'Zahlung offen',
  nur_lesen: 'nur lesen',
  umzug_laeuft: 'Umzug läuft',
  umgezogen: 'umgezogen',
  demo: 'Vorführung',
  pausiert: 'pausiert',
  loeschung_geplant: 'Löschung geplant',
};

/** v1.4 3.5/3.6: Konto in der Instanz, nur Admin, nur im betreuten Betrieb (404 im Selbstbetrieb blendet aus). */
function KontoAbo({ k, neu }: { k: KontoT; neu: () => void }) {
  const { melde } = useApp();
  const [laedt, setLaedt] = useState('');
  const [loeschen, setLoeschen] = useState(false);
  const [bestaetigung, setBestaetigung] = useState('');
  const subdomain = location.hostname.split('.')[0] || 'instanz';
  const aktion = async (a: KontoAktion, body?: Record<string, unknown>, ok?: string) => {
    setLaedt(a);
    try {
      const r = await api.kontoAktion(a, body);
      if (typeof r.checkout_url === 'string') location.href = r.checkout_url;
      melde(typeof r.hinweis === 'string' ? r.hinweis : (ok ?? 'Erledigt.'));
      neu();
    } catch (err) {
      melde(fehlerText(err), 'fehler');
    } finally {
      setLaedt('');
    }
  };
  return (
    <div class="konto-abo">
      <dl class="artikel-meta">
        <div>
          <dt>Status</dt>
          <dd>{STATUS_TEXT[k.status]}</dd>
        </div>
        <div>
          <dt>Paket</dt>
          <dd>
            {k.paket[0].toUpperCase() + k.paket.slice(1)}, {k.stufe === 'geteilt' ? 'geteilter Server' : 'eigene Maschine'}
          </dd>
        </div>
        {k.test_ende && (
          <div>
            <dt>Testphase bis</dt>
            <dd class="mono">{datum(k.test_ende)}</dd>
          </div>
        )}
        {k.kuendigung_zum && (
          <div>
            <dt>Gekündigt zum</dt>
            <dd class="mono">{datum(k.kuendigung_zum)}</dd>
          </div>
        )}
        {k.loeschen_am && (
          <div>
            <dt>Löschung am</dt>
            <dd class="mono">{datum(k.loeschen_am)}</dd>
          </div>
        )}
      </dl>
      {k.status === 'test' && <p class="klein-text">Wenn du nichts tust, wird nichts abgebucht. Nach der Testphase ist alles 30 Tage nur lesbar und exportierbar, dann löschen wir und sagen vorher Bescheid.</p>}

      <div class="konto-aktionen">
        <section class="eigentum-block">
          <div>
            <h3 class="eigentum-titel">Weiter nutzen</h3>
            <p class="klein-text">{k.kauf_offen ? 'Paket wählen und mit Mollie bezahlen. Rechnung binnen 7 Tagen per Mail.' : 'Kaufen ist gerade noch nicht freigeschaltet. Deine Daten bleiben, und die Testphase läuft wie angegeben.'}</p>
          </div>
          <Knopf art="primaer" disabled={!k.kauf_offen} laedt={laedt === 'kaufen'} onClick={() => aktion('kaufen', { paket: k.paket, stufe: k.stufe, intervall: 'monat' })}>
            Kaufen
          </Knopf>
        </section>
        {k.status === 'test' && (
          <section class="eigentum-block">
            <div>
              <h3 class="eigentum-titel">Mehr Zeit</h3>
              <p class="klein-text">{k.test_selbst_verlaengert ? 'Du hast die Testphase schon einmal verlängert.' : 'Einmal 14 Tage länger testen, ohne Begründung.'}</p>
            </div>
            <Knopf disabled={k.test_selbst_verlaengert} laedt={laedt === 'test-verlaengern'} onClick={() => aktion('test-verlaengern', undefined, 'Testphase um 14 Tage verlängert.')}>
              14 Tage verlängern
            </Knopf>
          </section>
        )}
        <section class="eigentum-block">
          <div>
            <h3 class="eigentum-titel">Umziehen</h3>
            <p class="klein-text">In die eigene Cloud oder auf einen Rechner im Haus. Kostenlos, ohne Verlust; den Link zum Paket bekommst nur du.</p>
          </div>
          <div class="knopf-reihe">
            <Knopf laedt={laedt === 'umzug'} onClick={() => aktion('umzug', { ziel: 'eigene_cloud' })}>
              Eigene Cloud
            </Knopf>
            <Knopf art="leise" onClick={() => aktion('umzug', { ziel: 'lokal' })}>
              Lokal
            </Knopf>
          </div>
        </section>
        {k.status === 'aktiv' && !k.kuendigung_zum && (
          <section class="eigentum-block">
            <div>
              <h3 class="eigentum-titel">Kündigen</h3>
              <p class="klein-text">Zum Ende des Zeitraums. Danach 30 Tage nur lesen und exportieren.</p>
            </div>
            <Knopf laedt={laedt === 'kuendigen'} onClick={() => aktion('kuendigen')}>
              Kündigen
            </Knopf>
          </section>
        )}
        <div class="gefahr-zone">
          <div>
            <p class="schalter-titel">Instanz löschen</p>
            <p class="klein-text">Löscht alles: Wissen, Quellen, Zugänge, Sicherungen. Vorher exportieren. Du bekommst eine Mail mit Bestätigungslink.</p>
          </div>
          <Knopf art="gefahr" icon="kreuz" onClick={() => setLoeschen(true)}>
            Löschen
          </Knopf>
        </div>
      </div>
      <Dialog offen={loeschen} schliessen={() => setLoeschen(false)} titel="Instanz löschen?" beschreibung={`Tipp zur Bestätigung „${subdomain}“ ein. Erst der Klick auf den Link in der Mail löscht wirklich.`}>
        <div class="formular">
          <Feld label="Name der Instanz">{(p) => <input {...p} class="eingabe mono" type="text" autocomplete="off" value={bestaetigung} onInput={(x) => setBestaetigung((x.target as HTMLInputElement).value)} />}</Feld>
          <div class="knopf-reihe knopf-reihe--ende">
            <Knopf art="leise" onClick={() => setLoeschen(false)}>
              Abbrechen
            </Knopf>
            <Knopf
              art="gefahr"
              disabled={bestaetigung.trim() !== subdomain}
              laedt={laedt === 'loeschen'}
              onClick={() => {
                setLoeschen(false);
                void aktion('loeschen', { bestaetigung: subdomain });
              }}
            >
              Mail zum Löschen schicken
            </Knopf>
          </div>
        </div>
      </Dialog>
    </div>
  );
}

const CLIENT_ANLEITUNG: { name: string; schritte: string }[] = [
  { name: 'Claude (Web und Desktop)', schritte: 'In den Einstellungen bei den Konnektoren einen eigenen Konnektor hinzufügen und die Adresse einfügen. Claude öffnet ein Fenster zum Anmelden, dort bestätigst du die Rechte.' },
  { name: 'ChatGPT', schritte: 'In den Einstellungen bei Apps oder Konnektoren einen eigenen MCP-Server anlegen, die Adresse einfügen, als Anmeldung OAuth wählen, dann anmelden und Rechte bestätigen.' },
  { name: 'Le Chat (Mistral)', schritte: 'Bei den Konnektoren einen eigenen MCP-Konnektor hinzufügen, die Adresse einfügen und anmelden.' },
  { name: 'Claude Code', schritte: 'Im Terminal: claude mcp add --transport http <name> <Adresse>, danach in Claude Code /mcp aufrufen und anmelden.' },
];

/** v1.4 6.4: Verbundene Apps (OAuth) und eigene Schlüssel, mit Pflichthinweis F12. */
function VerbundeneApps() {
  const { melde } = useApp();
  const r = useLaden(() => api.apps(), []);
  const [weg, setWeg] = useState<VerbundeneApp | null>(null);
  const mcpUrl = `${location.origin}${location.pathname.replace(/[^/]*$/, '')}mcp`;
  const trennen = async () => {
    if (!weg) return;
    try {
      await api.trenneApp(weg.clientId);
      r.setze((r.daten ?? []).filter((a) => a.clientId !== weg.clientId));
      melde(`${weg.name} ist getrennt. Alle Zugänge dieser App sind widerrufen.`);
    } catch (err) {
      melde(fehlerText(err), 'fehler');
    } finally {
      setWeg(null);
    }
  };
  return (
    <div class="zugang">
      <p>
        KI-Apps wie Claude, ChatGPT oder Le Chat verbinden sich über diese Adresse und melden sich selbst an. Jede App bekommt höchstens deine Rechte und nur die, die du beim Verbinden bestätigst.
      </p>
      <F12Hinweis />
      <div class="kopier-zeile">
        <code class="token mono">{mcpUrl}</code>
      </div>
      <section aria-labelledby="apps-titel">
        <h3 id="apps-titel" class="abschnitt-titel">
          Verbunden
        </h3>
        {r.laedt && <Laedt />}
        {r.fehler && <Fehlerhinweis text={r.fehler} nochmal={r.neu} />}
        {r.daten && (
          <ul class="token-liste">
            {r.daten.map((a) => (
              <li key={a.clientId} class="token-zeile">
                <div class="token-haupt">
                  <p class="token-name">{a.name}</p>
                  {a.anbieter && <p class="meta-klein">Daten gehen an: {a.anbieter}</p>}
                  <ul class="chip-reihe" aria-label="Rechte">
                    {a.scopes.map((sc) => (
                      <li key={sc} class="chip">
                        {SCOPE_TEXT[sc]?.titel ?? sc}
                      </li>
                    ))}
                  </ul>
                </div>
                <dl class="token-daten">
                  <div>
                    <dt>Verbunden</dt>
                    <dd>{datum(a.verbunden)}</dd>
                  </div>
                  <div>
                    <dt>Zuletzt benutzt</dt>
                    <dd>{a.zuletzt ? datum(a.zuletzt) : 'noch nie'}</dd>
                  </div>
                </dl>
                <Knopf klein art="gefahr" icon="kreuz" aria-label={`${a.name} trennen`} onClick={() => setWeg(a)}>
                  Trennen
                </Knopf>
              </li>
            ))}
            {!r.daten.length && <li class="klein-text leer-zeile">Noch keine App verbunden.</li>}
          </ul>
        )}
      </section>
      <section class="artikel-abschnitt" aria-labelledby="anl-titel">
        <h3 id="anl-titel" class="abschnitt-titel">
          So verbindest du
        </h3>
        <dl class="anleitung">
          {CLIENT_ANLEITUNG.map((c) => (
            <div key={c.name}>
              <dt>{c.name}</dt>
              <dd>{c.schritte}</dd>
            </div>
          ))}
          <div>
            <dt>Nur im VPN erreichbar?</dt>
            <dd>
              Lokal über die Kommandozeile: <code class="mono">{PRODUKT.toLowerCase()} mcp --verbinde {mcpUrl}</code> mit einem Schlüssel aus dem nächsten Abschnitt.
            </dd>
          </div>
        </dl>
      </section>
      <section class="artikel-abschnitt" aria-labelledby="schl-titel">
        <h3 id="schl-titel" class="abschnitt-titel">
          Eigene Schlüssel für Skripte und Agenten
        </h3>
        <Zugang />
      </section>
      <Dialog offen={!!weg} schliessen={() => setWeg(null)} titel="App trennen?" beschreibung={weg ? `${weg.name} verliert sofort den Zugriff. Du kannst sie später neu verbinden.` : ''}>
        <div class="knopf-reihe knopf-reihe--ende">
          <Knopf art="leise" onClick={() => setWeg(null)}>
            Abbrechen
          </Knopf>
          <Knopf art="gefahr" onClick={trennen}>
            Ja, trennen
          </Knopf>
        </div>
      </Dialog>
    </div>
  );
}

export function Einstellungen({ route }: { route: Route }) {
  const { ich, einstellungen, setzeEinstellungen, melde } = useApp();
  const alt: Record<string, string> = { export: 'wissen', zugang: 'apps' };
  const abschnitt = alt[route.rest] ?? (route.rest || 'lesen');
  const admin = darf.verwalten(ich);
  const k = useLaden(() => api.konto(), [ich.id]);
  const liste = ABSCHNITTE.filter((a) => !a.wer || (a.wer === 'admin' && admin) || (a.wer === 'freigeber' && darf.freigeben(ich)) || (a.wer === 'konto' && !!k.daten));
  const aktiv = liste.find((a) => a.id === abschnitt) ?? liste[0];

  const speichern = async (e: E) => {
    try {
      setzeEinstellungen(await api.speichereEinstellungen(e));
      melde('Gespeichert.');
    } catch (err) {
      melde(fehlerText(err), 'fehler');
    }
  };

  return (
    <div class="seite seite--einstellungen">
      <Seitenkopf titel="Einstellungen" unterzeile={admin ? `Du verwaltest ${PRODUKT} für den ganzen Betrieb.` : 'Manches hier kann nur ein Admin ändern. Du siehst den Stand.'} />
      <div class="einstellungen-raster">
        <nav aria-label="Einstellungen" class="einstellungen-nav">
          <ul>
            {liste.map((a) => (
              <li key={a.id}>
                <a href={`#/einstellungen/${a.id}`} class={`einst-link${a.id === aktiv.id ? ' aktiv' : ''}${a.betont ? ' einst-link--betont' : ''}`} aria-current={a.id === aktiv.id ? 'page' : undefined}>
                  <Icon name={a.icon} groesse={18} />
                  <span>{a.text}</span>
                </a>
              </li>
            ))}
          </ul>
        </nav>
        <section class="karte einstellungen-inhalt" aria-labelledby="einst-titel">
          <h2 id="einst-titel" class="einst-titel">
            {aktiv.text}
          </h2>
          {!einstellungen && (aktiv.id === 'betrieb' || aktiv.id === 'ki') ? (
            <Laedt />
          ) : (
            <>
              {!admin && aktiv.id === 'betrieb' && (
                <p class="klein-text">
                  <Icon name="schloss" groesse={16} /> Nur Admins können das ändern.
                </p>
              )}
              {aktiv.id === 'lesen' && <MeinLesen />}
              {aktiv.id === 'betrieb' && einstellungen && <Betrieb e={einstellungen} kannAendern={admin} speichern={speichern} />}
              {aktiv.id === 'ki' && einstellungen && <Ki e={einstellungen} kannAendern={admin} speichern={speichern} />}
              {aktiv.id === 'datenweg' && <Datenweg admin={admin} />}
              {aktiv.id === 'benutzer' && admin && <Benutzer />}
              {aktiv.id === 'apps' && <VerbundeneApps />}
              {aktiv.id === 'anmeldung' && <Konto />}
              {aktiv.id === 'konto' && k.daten && <KontoAbo k={k.daten} neu={k.neu} />}
              {aktiv.id === 'kontext' && <KontextbilanzInhalt />}
              {aktiv.id === 'wissen' && <WissenGehoertDir />}
            </>
          )}
        </section>
      </div>
    </div>
  );
}
