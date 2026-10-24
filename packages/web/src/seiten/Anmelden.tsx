import { useState } from 'preact/hooks';
import { PRODUKT } from '../produkt';
import { api, MOCK } from '../api';
import type { User } from '../api/types';
import { Feld, Knopf } from '../ui/teile';
import { Icon } from '../ui/Icon';

export function Anmelden({ angemeldet }: { angemeldet: (u: User, passwort: string) => void }) {
  const [name, setName] = useState('');
  const [passwort, setPasswort] = useState('');
  const [zeigen, setZeigen] = useState(false);
  const [fehler, setFehler] = useState<string | null>(null);
  const [laedt, setLaedt] = useState(false);

  const senden = async (e: Event) => {
    e.preventDefault();
    if (!name.trim() || !passwort) {
      setFehler('Bitte Name und Passwort eingeben.');
      return;
    }
    setLaedt(true);
    setFehler(null);
    try {
      angemeldet(await api.login(name.trim(), passwort), passwort);
    } catch (err) {
      setFehler(err instanceof Error ? err.message : 'Anmelden hat nicht geklappt.');
      setLaedt(false);
    }
  };

  return (
    <div class="anmelden">
      <main class="anmelden-karte">
        <div class="anmelden-kopf">
          <span class="marke-zeichen marke-zeichen--gross" aria-hidden="true" />
          <h1>Anmelden</h1>
          <p>Das Wissen eures Betriebs, mit Beleg für jede Antwort.</p>
        </div>
        <form onSubmit={senden} noValidate>
          <Feld label="Name">
            {(p) => (
              <input
                {...p}
                class="eingabe"
                type="text"
                autocomplete="username"
                autocapitalize="none"
                value={name}
                onInput={(e) => setName((e.target as HTMLInputElement).value)}
                required
              />
            )}
          </Feld>
          <Feld label="Passwort">
            {(p) => (
              <div class="eingabe-mit-knopf">
                <input
                  {...p}
                  class="eingabe"
                  type={zeigen ? 'text' : 'password'}
                  autocomplete="current-password"
                  value={passwort}
                  onInput={(e) => setPasswort((e.target as HTMLInputElement).value)}
                  required
                />
                <button type="button" class="symbol-knopf" aria-pressed={zeigen} aria-label="Passwort anzeigen" onClick={() => setZeigen((z) => !z)}>
                  <Icon name="auge" groesse={18} />
                </button>
              </div>
            )}
          </Feld>
          {fehler && (
            <p class="formular-fehler" role="alert">
              <Icon name="warnung" groesse={18} /> {fehler}
            </p>
          )}
          <Knopf art="primaer" type="submit" laedt={laedt} iconRechts="pfeil" klasse="knopf--voll">
            Anmelden
          </Knopf>
        </form>
        <p class="anmelden-hilfe">Passwort vergessen? Frag die Person, die {PRODUKT} bei euch verwaltet.</p>
        {MOCK && (
          <div class="anmelden-demo">
            <p class="hinweis-titel">Demo: Tischlerei Wendt (erfunden)</p>
            <p>
              Name <code>Jörn</code> (Admin), <code>Sabine</code> (Freigeberin), <code>Kai</code> (Autor) oder <code>Lena</code> (Leserin). Passwort jeweils <code>demo</code>.
            </p>
          </div>
        )}
      </main>
    </div>
  );
}
