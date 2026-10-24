import { useEffect, useMemo, useState } from 'preact/hooks';
import { PRODUKT } from '../produkt';
import { api } from '../api';
import type { Lesestil, Punkt, PunktBlock } from '../api/types';
import { darf, useApp } from '../kontext';
import { KontextKarte } from './Kontextbilanz';
import { fehlerText, useLaden } from '../lib/laden';
import { datum, datumLang } from '../lib/datum';
import { AMPEL_WORT, BLOCK_TITEL, ersterUeberBudget, minutenText, schneideZu, sortiere } from '../lib/lesen';
import { markdownZuHtml } from '../lib/markdown';
import { istKi, kiHinweis, modellText } from '../lib/kennzeichnung';
import { zeilenText } from '../lib/fundstelle';
import { fundstelleHref } from '../lib/artikel';
import { Icon } from '../ui/Icon';
import { Fehlerhinweis, Knopf, KnopfLink, Laedt, Segment, Seitenkopf } from '../ui/teile';

function uhrzeit(iso: string) {
  const m = /T(\d{2}):(\d{2})/.exec(iso);
  return m ? `${m[1]}:${m[2]}` : '';
}

/** Ein Punkt mit vier Stufen: Satz, Absatz, Zitat, Rohtext. Jede Stufe öffnet man selbst. */
function PunktKarte({ p, objekt }: { p: Punkt; objekt: string }) {
  const [stufe, setStufe] = useState(1);
  const oeffne = (s: 2 | 3) => {
    const neu = stufe >= s ? s - 1 : s;
    setStufe(neu);
    if (neu >= 2) void api.gelesen({ objekt, punkt: p.id, stufe: neu as 2 | 3 });
  };
  const hatAbsatz = !!p.absatz;
  const hatBeleg = p.belege.length > 0;
  return (
    <li class={`punkt punkt--${p.ampel.farbe}`}>
      <div class="punkt-kopf">
        <p class="punkt-satz">{p.satz}</p>
        <span class={`lese-ampel lese-ampel--${p.ampel.farbe}`} title={p.ampel.grund}>
          <span class="lese-ampel-punkt" aria-hidden="true" />
          <span>
            <span class="sr-only">Muss ich das lesen? </span>
            {AMPEL_WORT[p.ampel.farbe]}
          </span>
        </span>
      </div>
      <p class="punkt-grund">
        <span class="punkt-grund-label">Warum:</span> {p.ampel.grund}
      </p>
      {stufe >= 2 && hatAbsatz && (
        <p class="punkt-absatz" id={`absatz-${p.id}`}>
          {p.absatz}
        </p>
      )}
      {stufe >= 3 &&
        p.belege.map((b, i) => (
          <div key={i} class="punkt-beleg" id={`beleg-${p.id}`}>
            <blockquote class="zitat">
              <p>
                <mark>{b.zitat}</mark>
              </p>
            </blockquote>
            <p class="quelle-ort">
              {b.abschnitt} · {zeilenText(b.zeilen)}
            </p>
            <a class="quelle-oeffnen" href={fundstelleHref(b)} onClick={() => void api.gelesen({ objekt, punkt: p.id, stufe: 4 })}>
              Original öffnen <Icon name="pfeil" groesse={16} />
            </a>
          </div>
        ))}
      <div class="punkt-stufen">
        {hatAbsatz && (
          <button type="button" class="stufe-knopf" aria-expanded={stufe >= 2} aria-controls={`absatz-${p.id}`} onClick={() => oeffne(2)}>
            <Icon name={stufe >= 2 ? 'pfeilRunter' : 'pfeilRechts'} groesse={16} /> {stufe >= 2 ? 'Weniger' : 'Mehr dazu'}
          </button>
        )}
        {hatBeleg && (
          <button type="button" class="stufe-knopf" aria-expanded={stufe >= 3} aria-controls={`beleg-${p.id}`} onClick={() => oeffne(3)}>
            <Icon name="dokumente" groesse={16} /> {stufe >= 3 ? 'Beleg zu' : 'Beleg'}
          </button>
        )}
        {!hatBeleg && p.block !== 'unsicher' && <span class="meta-klein">ohne Beleg</span>}
      </div>
    </li>
  );
}

function Block({ block, punkte, objekt, grenzeNach }: { block: PunktBlock; punkte: Punkt[]; objekt: string; grenzeNach?: string | null }) {
  return (
    <section class={`heute-block heute-block--${block}`} aria-labelledby={`hb-${block}`}>
      <h2 id={`hb-${block}`} class="abschnitt-titel">
        {BLOCK_TITEL[block]} <span class="zahl">{punkte.length}</span>
      </h2>
      {punkte.length ? (
        <ol class="punkte">
          {punkte.map((p) => (
            <>
              {grenzeNach === p.id && (
                <li class="budget-grenze" aria-label="Ab hier über deinem Lesebudget">
                  <span>Ab hier über deinem Lesebudget</span>
                </li>
              )}
              <PunktKarte key={p.id} p={p} objekt={objekt} />
            </>
          ))}
        </ol>
      ) : (
        <p class="klein-text block-leer">{block === 'unsicher' ? 'Keine. Alles ist durchgelaufen.' : 'Nichts.'}</p>
      )}
    </section>
  );
}

const STILE: { wert: Lesestil; text: string }[] = [
  { wert: 'zusammenfassung', text: 'Zusammenfassung' },
  { wert: 'entscheidung', text: 'Entscheidungsvorlage' },
  { wert: 'fokus', text: 'Fokus' },
];

function hinweisSchluessel() {
  const d = new Date();
  const woche = Math.floor((Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) / 86400000 + 3) / 7);
  return `kern-hinweis-zu-${woche}`;
}
function hinweisWeg(): boolean {
  try {
    return localStorage.getItem(hinweisSchluessel()) === '1';
  } catch {
    return false;
  }
}

export function Heute() {
  const { ich, melde, einstellungen } = useApp();
  const r = useLaden(() => api.heute(), []);
  const l = useLaden(() => api.lesen(), []);
  const bilanz = useLaden(() => api.lesebilanz(), []);
  const [stil, setStil] = useState<Lesestil | null>(null);
  const [vorschau, setVorschau] = useState(false); // „Als Entscheidungsvorlage“ aus der Zusammenfassung heraus
  const [nurAbw, setNurAbw] = useState(false);
  const [zusammenAuf, setZusammenAuf] = useState(false);
  const [hinweisZu, setHinweisZu] = useState(hinweisWeg);
  const [neuLaedt, setNeuLaedt] = useState(false);

  useEffect(() => {
    if (l.daten && !stil) setStil(l.daten.stil);
  }, [l.daten]);

  const waehleStil = async (s: Lesestil) => {
    setStil(s);
    setVorschau(false);
    if (s !== 'fokus') r.neu();
    if (!l.daten) return;
    try {
      const neu = await api.speichereLesen({ ...l.daten, stil: s });
      l.setze(neu);
      if (s === 'fokus') r.neu();
    } catch (e) {
      melde(fehlerText(e), 'fehler');
    }
  };

  const neuErstellen = async () => {
    setNeuLaedt(true);
    try {
      await api.neueAnsicht({ zweck: 'briefing' });
      r.neu();
      melde('Neu aus den Rohdaten erstellt.');
    } catch (e) {
      melde(fehlerText(e), 'fehler');
    } finally {
      setNeuLaedt(false);
    }
  };

  const h = r.daten;
  const e = l.daten;
  const aktiv: Lesestil = vorschau ? 'entscheidung' : (stil ?? e?.stil ?? 'zusammenfassung');
  const budgetAn = !!e && (aktiv === 'fokus' || e.lesebudget_an) && aktiv !== 'zusammenfassung';
  const hart = !!e && aktiv === 'fokus' && e.lesebudget_an && e.budget_hart;
  const z = useMemo(() => {
    if (!h) return null;
    const filtern = aktiv === 'fokus' && (e?.nur_abweichungen ?? true);
    const basis = filtern ? { ...h, punkte: h.punkte.filter((p) => p.neu_seit !== null) } : h;
    return { ...schneideZu(basis, budgetAn ? hart : false), ueber: budgetAn && !hart ? ersterUeberBudget(sortiere(basis.punkte.filter((p) => p.block !== 'ignorieren')), basis) : -1, ausgeblendet: h.punkte.length - basis.punkte.length };
  }, [h, aktiv, budgetAn, hart, e?.nur_abweichungen]);
  const budget = h?.budget.minuten ?? 0;
  const anteil = z && budget ? Math.min(1, z.minuten / budget) : 0;
  const nach = (b: PunktBlock) => (z ? z.zeigen.filter((p) => p.block === b) : []);
  const grenzeId = z && z.ueber >= 0 ? sortiere(z.zeigen)[z.ueber]?.id ?? null : null;
  const zusammenText = h ? (nurAbw ? h.abweichungen : h.zusammenfassung) : '';
  const zusammenHtml = useMemo(() => (zusammenText ? markdownZuHtml(zusammenText) : ''), [zusammenText]);
  const hinweis = bilanz.daten?.hinweis;

  return (
    <div class="seite seite--schmal seite--heute">
      <Seitenkopf oberzeile={h ? datumLang(h.datum) : ' '} titel="Heute" unterzeile={`${ich.name.split(' ')[0]}, das hat sich getan und das wartet auf dich.`} />
      {e && (
        <Segment name="lesestil" legende="Lesestil" wert={aktiv} optionen={STILE} aendern={waehleStil} />
      )}
      {r.laedt && <Laedt text="Heute wird geladen" />}
      {r.fehler && <Fehlerhinweis text={r.fehler} nochmal={r.neu} />}

      {hinweis && !hinweisZu && aktiv === 'zusammenfassung' && (
        <aside class="sanfter-hinweis" aria-label="Hinweis nur für dich">
          <Icon name="lampe" groesse={20} />
          <div>
            <p>{hinweis.text}</p>
            <p class="meta-klein">Nur du siehst diesen Hinweis.</p>
            <div class="knopf-reihe">
              <Knopf klein onClick={() => void waehleStil(hinweis.vorschlag)}>
                Ausprobieren
              </Knopf>
              <Knopf
                klein
                art="leise"
                onClick={() => {
                  setHinweisZu(true);
                  try {
                    localStorage.setItem(hinweisSchluessel(), '1');
                  } catch {
                    /* dann eben nur bis zum Neuladen */
                  }
                }}
              >
                Nein danke
              </Knopf>
            </div>
          </div>
          <button type="button" class="symbol-knopf" aria-label="Hinweis schließen" onClick={() => setHinweisZu(true)}>
            <Icon name="schliessen" groesse={18} />
          </button>
        </aside>
      )}

      {h && z && (
        <>
          {budgetAn && (
            <section class="budget" aria-labelledby="budget-titel">
              <div class="budget-kopf">
                <h2 id="budget-titel" class="budget-titel">
                  Lesezeit heute
                </h2>
                <p class="budget-zahl mono">
                  {minutenText(z.minuten)} von {minutenText(budget)}
                </p>
              </div>
              <div
                class={`budget-balken${z.minuten > budget ? ' ueber' : ''}`}
                role="meter"
                aria-valuemin={0}
                aria-valuemax={budget}
                aria-valuenow={Math.round(Math.min(z.minuten, budget) * 10) / 10}
                aria-valuetext={`${minutenText(z.minuten)} von ${minutenText(budget)}`}
                aria-labelledby="budget-titel"
              >
                <span style={{ transform: `scaleX(${anteil})` }} />
              </div>
              <p class="budget-rest">
                {hart
                  ? budget - z.minuten >= 1
                    ? `Rest: ${minutenText(budget - z.minuten)}. Harte Grenze: mehr zeigt ${PRODUKT} heute nicht.`
                    : `Budget voll. Harte Grenze: mehr zeigt ${PRODUKT} heute nicht.`
                  : z.minuten > budget
                    ? `Heute ist es mehr als dein Budget. Die Stelle ist unten markiert.`
                    : `Rest: ${minutenText(budget - z.minuten)} bleiben frei.`}{' '}
                <a href="#/einstellungen/lesen">Einstellen</a>
              </p>
            </section>
          )}

          <p class={`ansicht-hinweis${h.ansicht.status !== 'aktuell' ? ' ansicht-hinweis--warn' : ''}`}>
            <Icon name={h.ansicht.status === 'aktuell' ? 'info' : 'warnung'} groesse={16} />
            <span>
              {istKi(h.ansicht, einstellungen?.provider) ? `Mit KI erstellte Ansicht (${modellText(h.ansicht, einstellungen?.provider)})` : 'Ansicht ohne KI'} vom {datum(h.ansicht.generated.at)}, {uhrzeit(h.ansicht.generated.at)} Uhr aus Rohdaten (Stand {uhrzeit(h.ansicht.basis_stand) || datum(h.ansicht.basis_stand)} Uhr), läuft ab am {datum(h.ansicht.gilt_bis)}.
              {h.ansicht.status === 'basis_geaendert' && ' Die Rohdaten haben sich seitdem geändert.'}
              {h.ansicht.status === 'abgelaufen' && ' Sie ist abgelaufen.'}
            </span>
            {h.ansicht.status !== 'aktuell' && (
              <Knopf klein laedt={neuLaedt} icon="verlauf" onClick={neuErstellen}>
                Neu erstellen
              </Knopf>
            )}
          </p>

          {(aktiv === 'zusammenfassung' || zusammenAuf) && zusammenText && (
            <section class="karte zusammenfassung-karte" aria-labelledby="zf-titel">
              <h2 id="zf-titel" class="abschnitt-titel">
                {nurAbw ? 'Nur Abweichungen' : 'Zusammenfassung'}
              </h2>
              <div class="prosa" dangerouslySetInnerHTML={{ __html: zusammenHtml }} />
              <p class="antwort-warnung">
                <strong class="ki-kennzeichen">{kiHinweis(h.ansicht, einstellungen?.provider, 'Zusammenfassung')}</strong> Grundlage sind die Rohdaten, nie frühere Zusammenfassungen.
              </p>
              {aktiv === 'zusammenfassung' && (
                <div class="knopf-reihe">
                  <Knopf klein icon="haken" onClick={() => setVorschau(true)}>
                    Als Entscheidungsvorlage
                  </Knopf>
                  <Knopf klein icon="filter" aria-pressed={nurAbw} onClick={() => setNurAbw((x) => !x)}>
                    {nurAbw ? 'Alles zeigen' : 'Nur Abweichungen'}
                  </Knopf>
                  <KnopfLink klein art="leise" href="#/eingang" icon="eingang">
                    Zum Eingang
                  </KnopfLink>
                </div>
              )}
            </section>
          )}

          {aktiv !== 'zusammenfassung' && (
            <>
              {vorschau && (
                <p class="klein-text">
                  Du siehst die Entscheidungsvorlage zur Probe. <button type="button" class="text-knopf" onClick={() => setVorschau(false)}>Zurück zur Zusammenfassung</button> oder{' '}
                  <button type="button" class="text-knopf" onClick={() => void waehleStil('entscheidung')}>als Standard nehmen</button>.
                </p>
              )}
              {aktiv === 'fokus' && z.ausgeblendet > 0 && (
                <p class="klein-text">
                  {z.ausgeblendet} {z.ausgeblendet === 1 ? 'Punkt ist' : 'Punkte sind'} seit deiner letzten Ansicht unverändert und ausgeblendet.
                </p>
              )}
              <Block block="unsicher" punkte={nach('unsicher')} objekt={h.ansicht.id} grenzeNach={grenzeId} />
              <Block block="entscheiden" punkte={nach('entscheiden')} objekt={h.ansicht.id} grenzeNach={grenzeId} />
              <Block block="aendert_sich" punkte={nach('aendert_sich')} objekt={h.ansicht.id} grenzeNach={grenzeId} />
              <details class="heute-block heute-ignorieren">
                <summary class="abschnitt-titel">
                  Darfst du ignorieren <span class="zahl">{h.ignorieren_anzahl}</span>
                </summary>
                <p class="klein-text">
                  {h.ignorieren_anzahl} Änderungen betreffen dich nach deinen Regeln nicht. Sie liegen bereit: im <a href="#/wissen">Wissen</a> und unter <a href="#/dokumente">Dokumente</a>.
                </p>
              </details>
              {!zusammenAuf && h.zusammenfassung && aktiv === 'entscheidung' && (
                <Knopf klein art="leise" icon="briefing" onClick={() => setZusammenAuf(true)}>
                  Zusammenfassung zeigen
                </Knopf>
              )}
            </>
          )}

          {darf.freigeben(ich) && <KontextKarte />}

          <footer class="heute-fuss">
            {hart && z.zurueck > 0 ? (
              <p class="zurueck">
                <Icon name="uhr" groesse={18} /> Für morgen zurückgelegt: <strong>{z.zurueck} {z.zurueck === 1 ? 'Punkt' : 'Punkte'}</strong>. Gekürzt wird nichts.
              </p>
            ) : (
              <p class="zurueck">
                <Icon name="haken" groesse={18} /> Das war alles für heute.
              </p>
            )}
            <div class="knopf-reihe">
              <KnopfLink art="leise" klein href="#/briefing" icon="briefing">
                Als Text
              </KnopfLink>
            </div>
          </footer>
        </>
      )}
    </div>
  );
}
