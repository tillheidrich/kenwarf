import { useState } from 'preact/hooks';
import { api } from '../api';
import type { User } from '../api/types';
import { fehlerText } from '../lib/laden';
import { PRODUKT } from '../produkt';
import { Feld, Knopf } from '../ui/teile';
import { Icon } from '../ui/Icon';

/** Nach Zurücksetzen durch den Admin: erst ein eigenes Passwort, dann geht es weiter (Server F1, code passwort_aendern). */
export function PasswortNeu({ ich, fertig, abmelden }: { ich: User; fertig: () => void; abmelden: () => void }) {
  const [alt, setAlt] = useState('');
  const [neu, setNeu] = useState('');
  const [wdh, setWdh] = useState('');
  const [fehler, setFehler] = useState<string | null>(null);
  const [laedt, setLaedt] = useState(false);
  const senden = async (e: Event) => {
    e.preventDefault();
    if (neu.length < 10) return setFehler('Das neue Passwort braucht mindestens 10 Zeichen.');
    if (neu !== wdh) return setFehler('Die beiden neuen Passwörter sind nicht gleich.');
    setFehler(null);
    setLaedt(true);
    try {
      await api.aenderePasswort(alt, neu);
      fertig();
    } catch (err) {
      setFehler(fehlerText(err));
    } finally {
      setLaedt(false);
    }
  };
  return (
    <div class="anmelden">
      <main class="anmelden-karte">
        <div class="anmelden-kopf">
          <span class="marke-zeichen marke-zeichen--gross" aria-hidden="true" />
          <h1 id="seitentitel" tabIndex={-1}>
            Eigenes Passwort festlegen
          </h1>
          <p>
            {ich.name.split(' ')[0]}, dein Zugang zu {PRODUKT} wurde zurückgesetzt. Bevor es weitergeht, brauchst du ein Passwort, das nur du kennst.
          </p>
        </div>
        <form onSubmit={senden} noValidate>
          <Feld label="Einmal-Passwort vom Admin">
            {(p) => <input {...p} class="eingabe" type="password" autocomplete="current-password" value={alt} onInput={(x) => setAlt((x.target as HTMLInputElement).value)} />}
          </Feld>
          <Feld label="Neues Passwort" hilfe="Mindestens 10 Zeichen. Ein Satz, den du dir merken kannst, ist besser als ein kurzes Wort mit Sonderzeichen.">
            {(p) => <input {...p} class="eingabe" type="password" autocomplete="new-password" value={neu} onInput={(x) => setNeu((x.target as HTMLInputElement).value)} />}
          </Feld>
          <Feld label="Neues Passwort wiederholen">
            {(p) => <input {...p} class="eingabe" type="password" autocomplete="new-password" value={wdh} onInput={(x) => setWdh((x.target as HTMLInputElement).value)} />}
          </Feld>
          {fehler && (
            <p class="formular-fehler" role="alert">
              <Icon name="warnung" groesse={18} /> {fehler}
            </p>
          )}
          <Knopf art="primaer" type="submit" laedt={laedt} icon="schloss" klasse="knopf--voll">
            Passwort speichern
          </Knopf>
        </form>
        <p class="anmelden-hilfe">
          <button type="button" class="text-knopf" onClick={abmelden}>
            Abmelden
          </button>
        </p>
      </main>
    </div>
  );
}
