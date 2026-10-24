import { useMemo, useState } from 'preact/hooks';
import { PRODUKT } from '../produkt';
import { api } from '../api';
import type { FaktArt } from '../api/types';
import { useApp } from '../kontext';
import { useLaden } from '../lib/laden';
import { gueltigkeit, heuteIso } from '../lib/datum';
import { filtere } from '../lib/finden';
import type { Route } from '../lib/router';
import { Icon } from '../ui/Icon';
import { Fehlerhinweis, Laedt, Leer, Seitenkopf } from '../ui/teile';
import { FAKT_ARTEN, FaktenTabelle } from '../ui/FaktenTabelle';

export function Fakten({ route }: { route: Route }) {
  const { artikelListe } = useApp();
  const [art, setArt] = useState<FaktArt | ''>((route.query.get('art') as FaktArt) ?? '');
  const [q, setQ] = useState(route.query.get('gegenstand') ?? '');
  const [stichtag, setStichtag] = useState('');
  const [nurAblaufend, setNurAblaufend] = useState(false);
  const r = useLaden(() => api.fakten({ art: art || undefined, gueltig_am: stichtag || undefined }), [art, stichtag]);
  const titel = useMemo(() => new Map(artikelListe.map((a) => [a.pfad, a.kopf.titel])), [artikelListe]);

  const liste = useMemo(() => {
    let l = r.daten ?? [];
    if (q.trim()) l = filtere(l, q, (f) => `${f.gegenstand} ${f.wert}`);
    if (nurAblaufend) l = l.filter((f) => ['bald', 'ueberfaellig'].includes(gueltigkeit(f.gilt_bis).stufe));
    return l;
  }, [r.daten, q, nurAblaufend]);
  const ablaufend = (r.daten ?? []).filter((f) => ['bald', 'ueberfaellig'].includes(gueltigkeit(f.gilt_bis).stufe)).length;

  return (
    <div class="seite">
      <Seitenkopf
        titel="Fakten"
        unterzeile="Preise, Fristen, Zuständigkeiten und Regeln aus den Artikeln, jeweils mit Fundstelle. Ändern geht nur über einen Vorschlag im Artikel."
      />
      <form class="filterleiste" onSubmit={(e) => e.preventDefault()} role="search" aria-label="Fakten filtern">
        <div class="feld feld--kompakt feld--wachsen">
          <label class="feld-label" for="fakt-q">
            Gegenstand
          </label>
          <div class="eingabe-mit-icon">
            <Icon name="suche" groesse={18} />
            <input id="fakt-q" class="eingabe" type="search" placeholder="z. B. Anzahlung" value={q} onInput={(e) => setQ((e.target as HTMLInputElement).value)} />
          </div>
        </div>
        <div class="feld feld--kompakt">
          <label class="feld-label" for="fakt-art">
            Art
          </label>
          <div class="auswahl">
            <select id="fakt-art" class="eingabe" value={art} onChange={(e) => setArt((e.target as HTMLSelectElement).value as FaktArt | '')}>
              <option value="">Alle Arten</option>
              {Object.entries(FAKT_ARTEN).map(([k, v]) => (
                <option key={k} value={k}>
                  {v}
                </option>
              ))}
            </select>
            <Icon name="pfeilRunter" groesse={16} klasse="auswahl-pfeil" />
          </div>
        </div>
        <div class="feld feld--kompakt">
          <label class="feld-label" for="fakt-tag">
            Gültig am
          </label>
          <input id="fakt-tag" class="eingabe" type="date" value={stichtag} max="2100-12-31" onInput={(e) => setStichtag((e.target as HTMLInputElement).value)} />
        </div>
        <label class="schalter-zeile">
          <input type="checkbox" class="schalter" checked={nurAblaufend} onChange={(e) => setNurAblaufend((e.target as HTMLInputElement).checked)} />
          <span>
            Nur ablaufende <span class="zahl zahl--warn">{ablaufend}</span>
          </span>
        </label>
      </form>
      {stichtag && (
        <p class="klein-text">
          Zeigt, was am {stichtag.split('-').reverse().join('.')} galt. <button type="button" class="text-knopf" onClick={() => setStichtag('')}>Auf heute zurück</button>
        </p>
      )}
      {r.laedt && !r.daten && <Laedt text="Fakten werden geladen" />}
      {r.fehler && <Fehlerhinweis text={r.fehler} nochmal={r.neu} />}
      {r.daten && (liste.length ? (
        <>
          <p class="treffer-zahl" role="status">
            {liste.length} {liste.length === 1 ? 'Fakt' : 'Fakten'}
            {stichtag ? '' : `, Stand heute ${heuteIso().split('-').reverse().join('.')}`}
          </p>
          <FaktenTabelle fakten={liste} mitArtikel artikelTitel={titel} beschriftung="Fakten aus allen Artikeln" />
        </>
      ) : (
        <Leer icon="fakten" titel={r.daten.length ? 'Kein Fakt passt zum Filter' : 'Noch keine Fakten erfasst'}>
          {r.daten.length ? (
            <p>Nimm einen Filter weg oder such nach einem anderen Wort.</p>
          ) : (
            <p>Fakten stehen im Kopf eines Artikels unter „fakten:“. {PRODUKT} schlägt sie beim Kompilieren vor, du gibst sie im Eingang frei.</p>
          )}
        </Leer>
      ))}
    </div>
  );
}
