// Produktname zentral. Der Name ist offen (Kern ist Arbeitstitel).
// Reihenfolge: `<meta name="kern-produkt">`, die der Server aus seiner Konfiguration (kern.yaml `produkt.name`
// oder KERN_PRODUKT_NAME) in die Seite schreibt, dann VITE_PRODUKT_NAME beim Bauen, sonst „Kern“.
// Zur Laufzeit überschreibt `produkt.name` aus GET /api/ich (Contract v1.4 0.10) den Wert.
function ausSeite(): string | undefined {
  try {
    const n = document.querySelector('meta[name="kern-produkt"]')?.getAttribute('content')?.trim();
    return n && n.length <= 40 ? n : undefined;
  } catch {
    return undefined;
  }
}

export let PRODUKT: string = ausSeite() || (import.meta.env.VITE_PRODUKT_NAME as string | undefined)?.trim() || 'Kern';

export function setzeProduktName(name: string | null | undefined) {
  const n = name?.trim();
  if (n && n.length <= 40) {
    PRODUKT = n;
    document.title = n;
  }
}
