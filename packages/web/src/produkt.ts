// Produktname zentral. Der Name ist offen (Kern ist Arbeitstitel, Bescheed eine Empfehlung).
// Beim Bauen setzen: VITE_PRODUKT_NAME=Bescheed npm run build
export const PRODUKT: string = (import.meta.env.VITE_PRODUKT_NAME as string | undefined)?.trim() || 'Kern';
