import { createContext, type ComponentChildren } from 'preact';
import { PRODUKT } from './produkt';
import { useCallback, useContext, useEffect, useMemo, useRef, useState } from 'preact/hooks';
import type { Artikel, Einstellungen, User } from './api/types';
import { api } from './api';

export interface Meldung {
  id: number;
  text: string;
  art: 'ok' | 'fehler' | 'info';
  link?: { text: string; href: string };
}

interface AppKontext {
  ich: User;
  einstellungen: Einstellungen | null;
  setzeEinstellungen: (e: Einstellungen) => void;
  offen: number; // offene Vorschläge im Eingang
  ladeZaehler: () => void;
  melde: (text: string, art?: Meldung['art'], link?: Meldung['link']) => void;
  abmelden: () => Promise<void>;
  artikelListe: Artikel[];
  ladeArtikelListe: () => void;
}

const Ctx = createContext<AppKontext | null>(null);

export function useApp(): AppKontext {
  const c = useContext(Ctx);
  if (!c) throw new Error('useApp außerhalb von AppAnbieter');
  return c;
}

export const darf = {
  vorschlagen: (u: User) => u.rollen.some((r) => r === 'autor' || r === 'freigeber' || r === 'admin'),
  freigeben: (u: User) => u.rollen.some((r) => r === 'freigeber' || r === 'admin'),
  verwalten: (u: User) => u.rollen.includes('admin'),
};

export const ROLLEN_TEXT: Record<string, string> = {
  leser: 'Lesen',
  autor: 'Vorschlagen',
  freigeber: 'Freigeben',
  admin: 'Verwalten',
};

/** Marke je Betrieb: Akzentfarbe und Logo aus den Einstellungen auf die CSS-Variablen legen. */
function wendeMarkeAn(e: Einstellungen | null) {
  const s = document.documentElement.style;
  const akzent = e?.marke?.akzent;
  if (akzent && /^#[0-9a-f]{6}$/i.test(akzent)) {
    s.setProperty('--kern-akzent', akzent);
    s.setProperty('--kern-akzent-dunkel', `color-mix(in oklab, ${akzent} 82%, #000)`);
  } else {
    s.removeProperty('--kern-akzent');
    s.removeProperty('--kern-akzent-dunkel');
  }
  if (e?.marke?.logo && /^(https?:|\/|\.\/|data:image\/)/.test(e.marke.logo)) {
    s.setProperty('--kern-logo', `url("${e.marke.logo.replace(/"/g, '')}")`);
    s.setProperty('--kern-logo-grund', 'transparent');
  } else {
    s.removeProperty('--kern-logo');
    s.removeProperty('--kern-logo-grund');
  }
}

export function AppAnbieter({ ich, abmelden, children }: { ich: User; abmelden: () => Promise<void>; children: ComponentChildren }) {
  const [einstellungen, setEinst] = useState<Einstellungen | null>(null);
  const [offen, setOffen] = useState(0);
  const [meldungen, setMeldungen] = useState<Meldung[]>([]);
  const [artikelListe, setArtikel] = useState<Artikel[]>([]);
  const zaehler = useRef(0);

  const ladeZaehler = useCallback(() => {
    api.eingang().then(
      (l) => setOffen(l.filter((v) => v.status === 'offen' || v.status === 'konflikt').length),
      () => undefined,
    );
  }, []);
  const ladeArtikelListe = useCallback(() => {
    api.wissen().then(setArtikel, () => undefined);
  }, []);
  const setzeEinstellungen = useCallback((e: Einstellungen) => {
    setEinst(e);
    wendeMarkeAn(e);
  }, []);

  useEffect(() => {
    api.einstellungen().then(setzeEinstellungen, () => undefined);
    ladeZaehler();
    ladeArtikelListe();
  }, [ich.id]);

  useEffect(() => {
    if (einstellungen?.betrieb) document.title = `${PRODUKT} · ${einstellungen.betrieb}`;
  }, [einstellungen?.betrieb]);

  const melde = useCallback((text: string, art: Meldung['art'] = 'ok', link?: Meldung['link']) => {
    const id = ++zaehler.current;
    setMeldungen((m) => [...m.slice(-2), { id, text, art, link }]);
    setTimeout(() => setMeldungen((m) => m.filter((x) => x.id !== id)), art === 'fehler' ? 9000 : 6000);
  }, []);

  const wert = useMemo<AppKontext>(
    () => ({ ich, einstellungen, setzeEinstellungen, offen, ladeZaehler, melde, abmelden, artikelListe, ladeArtikelListe }),
    [ich, einstellungen, offen, artikelListe],
  );

  return (
    <Ctx.Provider value={wert}>
      {children}
      <div class="meldungen" role="status" aria-live="polite" aria-atomic="false">
        {meldungen.map((m) => (
          <div key={m.id} class={`meldung meldung--${m.art}`}>
            <span>{m.text}</span>
            {m.link && (
              <a href={m.link.href} class="meldung-link">
                {m.link.text}
              </a>
            )}
            <button type="button" class="symbol-knopf" aria-label="Meldung schließen" onClick={() => setMeldungen((x) => x.filter((y) => y.id !== m.id))}>
              ×
            </button>
          </div>
        ))}
      </div>
    </Ctx.Provider>
  );
}
