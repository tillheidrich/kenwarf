// Produktname zentral. Der Name ist offen (Kern ist Arbeitstitel, Bescheed eine Empfehlung).
// Standard beim Bauen: VITE_PRODUKT_NAME=Bescheed npm run build. Zur Laufzeit überschreibt
// `produkt.name` aus GET /api/ich (Contract v1.4 0.10) den Wert, bevor die App gezeichnet wird.
export let PRODUKT: string = (import.meta.env.VITE_PRODUKT_NAME as string | undefined)?.trim() || 'Kern';

export function setzeProduktName(name: string | null | undefined) {
  const n = name?.trim();
  if (n && n.length <= 40) {
    PRODUKT = n;
    document.title = n;
  }
}
