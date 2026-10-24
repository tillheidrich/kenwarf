import type { Fakt, FaktArt, FundstelleKopf } from '../api/types';
import { datum, gueltigkeit } from '../lib/datum';
import { fundstelleHref } from '../lib/artikel';
import { href } from '../lib/router';
import { artikelRoute } from '../lib/pfade';
import { AmpelMarke } from './teile';

export const FAKT_ARTEN: Record<FaktArt, string> = {
  preis: 'Preis',
  frist: 'Frist',
  zustaendigkeit: 'Zuständigkeit',
  kennzahl: 'Kennzahl',
  kontakt: 'Kontakt',
  regel: 'Regel',
};

export function FaktenTabelle({
  fakten,
  fundstellen,
  mitArtikel,
  artikelTitel,
  beschriftung,
}: {
  fakten: Fakt[];
  fundstellen?: FundstelleKopf[];
  mitArtikel?: boolean;
  artikelTitel?: Map<string, string>;
  beschriftung: string;
}) {
  return (
    <div class="fakten-rahmen">
      <table class="fakten">
        <caption class="sr-only">{beschriftung}</caption>
        <thead>
          <tr>
            <th scope="col">Art</th>
            <th scope="col">Gegenstand</th>
            <th scope="col">Wert</th>
            <th scope="col">Gilt</th>
            <th scope="col">{mitArtikel ? 'Steht in' : 'Fundstelle'}</th>
          </tr>
        </thead>
        <tbody>
          {fakten.map((f) => {
            const g = gueltigkeit(f.gilt_bis);
            const fs = fundstellen?.find((x) => x.id === f.fundstelle);
            const nr = fundstellen ? fundstellen.findIndex((x) => x.id === f.fundstelle) + 1 : 0;
            return (
              <tr key={f.id} class={g.stufe === 'ueberfaellig' ? 'abgelaufen' : ''}>
                <td data-label="Art">
                  <span class={`fakt-art fakt-art--${f.art}`}>{FAKT_ARTEN[f.art] ?? f.art}</span>
                </td>
                <th scope="row" data-label="Gegenstand" class="fakt-gegenstand">
                  {f.gegenstand}
                </th>
                <td data-label="Wert" class="fakt-wert">
                  {f.wert}
                  {f.einheit && <span class="fakt-einheit"> {f.einheit}</span>}
                </td>
                <td data-label="Gilt" class="fakt-gilt">
                  <span class="fakt-zeitraum">
                    {f.gilt_ab ? `ab ${datum(f.gilt_ab)}` : 'seit jeher'}
                    {f.gilt_bis ? ` bis ${datum(f.gilt_bis)}` : ''}
                  </span>
                  {(g.stufe === 'bald' || g.stufe === 'ueberfaellig') && <AmpelMarke ampel={g} />}
                </td>
                <td data-label={mitArtikel ? 'Steht in' : 'Fundstelle'}>
                  {mitArtikel && f.artikel ? (
                    <a href={href(artikelRoute(f.artikel))}>{artikelTitel?.get(f.artikel) ?? f.artikel.split('/').pop()}</a>
                  ) : fs ? (
                    <a href={fundstelleHref(fs)} aria-label={`Fundstelle ${nr}: ${fs.abschnitt}`}>
                      <span class="fussnote fussnote--inline" aria-hidden="true">
                        {nr}
                      </span>{' '}
                      {fs.abschnitt}
                    </a>
                  ) : (
                    <span class="leise">{f.fundstelle}</span>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
