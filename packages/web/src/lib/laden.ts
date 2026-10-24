import { useCallback, useEffect, useRef, useState } from 'preact/hooks';
import { ApiFehler } from '../api/types';

export interface Ladezustand<T> {
  daten: T | undefined;
  fehler: string | null;
  status: number | null;
  laedt: boolean;
  neu: () => void;
  setze: (d: T) => void;
}

/** Lädt Daten, bricht veraltete Antworten ab und meldet 401 an die App. */
export function useLaden<T>(fn: () => Promise<T>, abh: unknown[]): Ladezustand<T> {
  const [daten, setDaten] = useState<T | undefined>(undefined);
  const [fehler, setFehler] = useState<string | null>(null);
  const [status, setStatus] = useState<number | null>(null);
  const [laedt, setLaedt] = useState(true);
  const [runde, setRunde] = useState(0);
  const lauf = useRef(0);
  useEffect(() => {
    const meine = ++lauf.current;
    setLaedt(true);
    setFehler(null);
    fn().then(
      (d) => {
        if (meine !== lauf.current) return;
        setDaten(d);
        setLaedt(false);
      },
      (e: unknown) => {
        if (meine !== lauf.current) return;
        const st = e instanceof ApiFehler ? e.status : null;
        if (st === 401) dispatchEvent(new CustomEvent('kern:abgemeldet'));
        setStatus(st);
        setFehler(e instanceof Error ? e.message : 'Unbekannter Fehler');
        setLaedt(false);
      },
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...abh, runde]);
  const neu = useCallback(() => setRunde((r) => r + 1), []);
  return { daten, fehler, status, laedt, neu, setze: setDaten };
}

export function fehlerText(e: unknown): string {
  if (e instanceof ApiFehler && e.status === 401) dispatchEvent(new CustomEvent('kern:abgemeldet'));
  return e instanceof Error ? e.message : 'Unbekannter Fehler';
}
