import { useMemo, useState } from 'preact/hooks';
import { api } from '../api';
import { useLaden } from '../lib/laden';
import { ampel, datum, datumLang, heuteIso } from '../lib/datum';
import { ansichtZuHtml } from '../lib/ansicht';
import { kiHinweis } from '../lib/kennzeichnung';
import { useApp } from '../kontext';
import { href } from '../lib/router';
import { artikelRoute } from '../lib/pfade';
import { Icon } from '../ui/Icon';
import { AmpelMarke, Fehlerhinweis, Laedt, Segment, Seitenkopf } from '../ui/teile';

function vor(tage: number) {
  const d = new Date();
  d.setDate(d.getDate() - tage);
  return heuteIso(d);
}

function linkText(l: string): string {
  if (l.includes('eingang')) return 'Eingang';
  if (l.includes('fakten')) return 'Fakten';
  if (l.includes('/wissen/')) return decodeURIComponent(l.split('/').pop() ?? '').replace(/\.md$/, '').replace(/^\d+-/, '').replace(/-/g, ' ');
  return l.replace(/^#\//, '');
}

export function Briefing() {
  const { einstellungen } = useApp();
  const [seit, setSeit] = useState<'1' | '7' | '30'>('1');
  const b = useLaden(() => api.briefing(vor(Number(seit))), [seit]);
  const f = useLaden(() => api.faellig(), []);
  const html = useMemo(() => (b.daten ? ansichtZuHtml(b.daten.text) : ''), [b.daten]);
  const woerter = b.daten ? b.daten.text.split(/\s+/).filter(Boolean).length : 0;

  return (
    <div class="seite seite--schmal">
      <Seitenkopf
        oberzeile={b.daten ? datumLang(b.daten.datum) : ' '}
        titel="Briefing"
        unterzeile="Was neu ist und was du entscheiden solltest. Höchstens 300 Wörter, damit es in die Kaffeepause passt."
      />
      <Segment
        name="seit"
        legende="Zeitraum"
        wert={seit}
        aendern={setSeit}
        optionen={[
          { wert: '1', text: 'Seit gestern' },
          { wert: '7', text: 'Letzte Woche' },
          { wert: '30', text: 'Letzter Monat' },
        ]}
      />
      {b.laedt && <Laedt text="Briefing wird geschrieben" />}
      {b.fehler && <Fehlerhinweis text={b.fehler} nochmal={b.neu} />}
      {b.daten && !b.laedt && (
        <>
          <section class="karte briefing-text" aria-label="Lage">
            <div class="prosa" dangerouslySetInnerHTML={{ __html: html }} />
            <p class="antwort-warnung">
              <strong class="ki-kennzeichen">{kiHinweis(undefined, einstellungen?.provider, 'Zusammenfassung')}</strong> <span class="mono">{woerter} Wörter</span>
            </p>
          </section>

          {b.daten.entscheidungen.length > 0 && (
            <section aria-labelledby="entsch-titel" class="briefing-abschnitt">
              <h2 id="entsch-titel" class="abschnitt-titel">
                Zu entscheiden <span class="zahl">{b.daten.entscheidungen.length}</span>
              </h2>
              <ol class="entscheidungen">
                {b.daten.entscheidungen.map((e, i) => {
                  const [frage, emp] = e.split(/\s*Empfehlung:\s*/);
                  return (
                    <li key={i}>
                      <span class="entscheidung-nr mono" aria-hidden="true">
                        {i + 1}
                      </span>
                      <div>
                        <p class="entscheidung-frage">{frage}</p>
                        {emp && (
                          <p class="entscheidung-emp">
                            <span class="entscheidung-emp-label">Empfehlung</span> {emp}
                          </p>
                        )}
                      </div>
                    </li>
                  );
                })}
              </ol>
            </section>
          )}

          {b.daten.links.length > 0 && (
            <nav aria-label="Weiter im Briefing" class="briefing-links">
              {b.daten.links.map((l) => (
                <a key={l} href={l.startsWith('#') ? l : href(artikelRoute(l))} class="chip chip--link">
                  <Icon name="pfeil" groesse={14} /> {linkText(l)}
                </a>
              ))}
            </nav>
          )}
        </>
      )}

      <section aria-labelledby="faellig-titel" class="briefing-abschnitt">
        <h2 id="faellig-titel" class="abschnitt-titel">
          Prüftermin überschritten
        </h2>
        {f.laedt ? null : f.fehler ? (
          <Fehlerhinweis text={f.fehler} nochmal={f.neu} />
        ) : f.daten?.length ? (
          <ul class="faellig-liste">
            {f.daten.map((a) => (
              <li key={a.pfad}>
                <a href={href(artikelRoute(a.pfad))}>{a.kopf.titel}</a>
                <span class="faellig-meta">
                  <AmpelMarke ampel={ampel(a.kopf.pruefen_bis)} kurz /> {a.kopf.verantwortlich} · seit {datum(a.kopf.pruefen_bis)}
                </span>
              </li>
            ))}
          </ul>
        ) : (
          <p class="klein-text">Nichts überfällig.</p>
        )}
      </section>
    </div>
  );
}
