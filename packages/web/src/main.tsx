import { render } from 'preact';
import { useCallback, useEffect, useState } from 'preact/hooks';
import './styles/fonts.css';
import './styles/tokens.css';
import './styles/basis.css';
import './styles/app.css';
import { api, starteApi } from './api';
import type { User } from './api/types';
import { App } from './app';
import { Anmelden } from './seiten/Anmelden';
import { AppAnbieter } from './kontext';
import { PasswortNeu } from './seiten/PasswortNeu';
import { PRODUKT } from './produkt';

function Wurzel() {
  const [ich, setIch] = useState<User | null | undefined>(undefined);
  const [startFehler, setStartFehler] = useState<string | null>(null);

  const pruefe = useCallback(() => {
    setStartFehler(null);
    starteApi()
      .then((a) => a.ich())
      .then(setIch, (e: unknown) => setStartFehler(e instanceof Error ? e.message : 'Server nicht erreichbar'));
  }, []);

  useEffect(() => {
    pruefe();
    const weg = () => setIch(null);
    const pw = () => setIch((u) => (u ? { ...u, mussPasswortAendern: true } : u));
    addEventListener('kern:abgemeldet', weg);
    addEventListener('kern:passwort-aendern', pw);
    document.title = PRODUKT;
    return () => {
      removeEventListener('kern:abgemeldet', weg);
      removeEventListener('kern:passwort-aendern', pw);
    };
  }, []);

  const abmelden = useCallback(async () => {
    try {
      await api.logout();
    } finally {
      setIch(null);
      location.hash = '#/';
    }
  }, []);

  if (startFehler)
    return (
      <main class="start-fehler">
        <h1>{PRODUKT} ist gerade nicht erreichbar</h1>
        <p>{startFehler}</p>
        <button type="button" class="knopf knopf--primaer" onClick={pruefe}>
          Nochmal versuchen
        </button>
      </main>
    );
  if (ich === undefined)
    return (
      <div class="start-laedt" role="status">
        <span class="marke-zeichen" aria-hidden="true" />
        <span class="sr-only">{PRODUKT} wird geladen …</span>
      </div>
    );
  if (!ich) return <Anmelden angemeldet={setIch} />;
  if (ich.mussPasswortAendern) return <PasswortNeu ich={ich} fertig={() => setIch({ ...ich, mussPasswortAendern: false })} abmelden={abmelden} />;
  return (
    <AppAnbieter ich={ich} abmelden={abmelden}>
      <App />
    </AppAnbieter>
  );
}

render(<Wurzel />, document.getElementById('app')!);
