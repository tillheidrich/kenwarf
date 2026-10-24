import { useEffect, useState } from 'preact/hooks';

// Hash-Routing (#/wissen/…): läuft ohne Server-Fallback für tiefe Links.

export interface Route {
  teile: string[]; // ["wissen", "wissen", "ablaeufe", "18-reklamation.md"]
  bereich: string; // erstes Segment
  rest: string; // alles nach dem Bereich, dekodiert
  query: URLSearchParams;
}

export function leseRoute(hash = typeof location !== 'undefined' ? location.hash : ''): Route {
  const roh = hash.replace(/^#\/?/, '');
  const [pfad, q = ''] = roh.split('?');
  const teile = pfad
    .split('/')
    .filter(Boolean)
    .map((t) => {
      try {
        return decodeURIComponent(t);
      } catch {
        return t;
      }
    });
  return { teile, bereich: teile[0] ?? '', rest: teile.slice(1).join('/'), query: new URLSearchParams(q) };
}

export function href(pfad: string, query?: Record<string, string | number | undefined>): string {
  const p = pfad.replace(/^#?\/?/, '');
  const kodiert = p
    .split('/')
    .map((t) => encodeURIComponent(t))
    .join('/');
  const qs = new URLSearchParams();
  if (query) for (const [k, v] of Object.entries(query)) if (v !== undefined && v !== '') qs.set(k, String(v));
  const s = qs.toString();
  return `#/${kodiert}${s ? `?${s}` : ''}`;
}

export function geheZu(pfad: string, query?: Record<string, string | number | undefined>) {
  const ziel = href(pfad, query);
  if (location.hash !== ziel) location.hash = ziel;
}

export function useRoute(): Route {
  const [r, setR] = useState(leseRoute);
  useEffect(() => {
    const f = () => setR(leseRoute());
    addEventListener('hashchange', f);
    return () => removeEventListener('hashchange', f);
  }, []);
  return r;
}
