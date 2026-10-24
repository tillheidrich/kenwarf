import type { Konto } from '../api/types';
import { datum } from '../lib/datum';
import { Icon } from './Icon';

/**
 * Testphase und Modus-Hinweise (CONTRACT v1.4 3.2, 3.3): sichtbar, aber ruhig.
 * Kein Countdown, keine vorausgewählte Option, kein Popup. Export ist immer einen Klick entfernt.
 */
export function TestphaseLeiste({ k }: { k: Konto }) {
  if (k.status === 'test' && k.test_ende) {
    return (
      <aside class="testphase" aria-label="Testphase">
        <p class="testphase-text">
          <Icon name="uhr" groesse={16} />
          <span>
            Testphase bis <strong class="mono">{datum(k.test_ende)}</strong>. <span class="testphase-leise">Wenn du nichts tust, wird nichts abgebucht. Danach ist alles 30 Tage nur lesbar und exportierbar.</span>
          </span>
        </p>
        <div class="testphase-aktionen">
          <a class="testphase-link" href="#/einstellungen/wissen">
            <Icon name="herunterladen" groesse={16} /> Wissen exportieren
          </a>
          <a class="testphase-link testphase-link--leise" href="#/einstellungen/konto">
            Konto
          </a>
        </div>
      </aside>
    );
  }
  return null;
}

/** Modus `nur_lesen` (v1.4 3.2): ehrlich sagen, was geht und was nicht. Kommt vom Konto oder von einer 423-Antwort. */
export function NurLesenLeiste({ k }: { k: Konto | null }) {
  const text =
    k?.status === 'test_abgelaufen'
      ? `Die Testphase ist vorbei. Alles bleibt ${k.loeschen_am ? `bis ${datum(k.loeschen_am)}` : '30 Tage'} lesbar und exportierbar.`
      : k?.status === 'umzug_laeuft'
        ? 'Der Umzug läuft. Bis er bestätigt ist, ist hier alles nur lesbar.'
        : k?.kuendigung_zum
          ? `Gekündigt. Alles bleibt ${k.loeschen_am ? `bis ${datum(k.loeschen_am)}` : '30 Tage'} lesbar und exportierbar.`
          : 'Gerade ist alles nur lesbar. Fragen laufen ohne KI, Export und Anmelden gehen weiter.';
  return (
    <aside class="testphase testphase--ende" aria-label="Nur lesen">
      <p class="testphase-text">
        <Icon name="schloss" groesse={16} />
        <span>
          <strong>Nur lesen.</strong> {text}
        </span>
      </p>
      <div class="testphase-aktionen">
        <a class="testphase-link" href="#/einstellungen/wissen">
          <Icon name="herunterladen" groesse={16} /> Wissen exportieren
        </a>
      </div>
    </aside>
  );
}
