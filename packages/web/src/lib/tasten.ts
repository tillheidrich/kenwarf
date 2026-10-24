// Tastenkürzel: Einzeltasten ("/", "?") und Folgen wie "g w". Gilt nicht, solange der Fokus in einem Eingabefeld liegt.

export interface Kuerzel {
  folge: string; // z. B. "g w" oder "/"
  ziel: string; // Beschriftung für die Hilfe
  aktion: () => void;
}

export function istEingabe(el: EventTarget | null): boolean {
  if (!el || !(el instanceof HTMLElement)) return false;
  if (el.isContentEditable) return true;
  const tag = el.tagName;
  if (tag === 'TEXTAREA' || tag === 'SELECT') return true;
  if (tag === 'INPUT') {
    const typ = (el as HTMLInputElement).type;
    return !['checkbox', 'radio', 'button', 'submit', 'reset', 'file'].includes(typ);
  }
  return false;
}

/** Zustandsautomat für Tastenfolgen; gibt das passende Kürzel zurück oder null. */
export class FolgenErkenner {
  private puffer: string[] = [];
  private zeit = 0;
  constructor(
    private kuerzel: Pick<Kuerzel, 'folge'>[],
    private fenster = 1200,
  ) {}

  taste(key: string, jetzt = Date.now()): string | null {
    if (jetzt - this.zeit > this.fenster) this.puffer = [];
    this.zeit = jetzt;
    this.puffer.push(key.length === 1 ? key.toLowerCase() : key);
    const s = this.puffer.join(' ');
    const treffer = this.kuerzel.find((k) => k.folge === s);
    if (treffer) {
      this.puffer = [];
      return treffer.folge;
    }
    const moeglich = this.kuerzel.some((k) => k.folge.startsWith(s + ' '));
    if (!moeglich) {
      // neuer Anfang mit der letzten Taste?
      this.puffer = [this.puffer[this.puffer.length - 1]];
      const neu = this.kuerzel.find((k) => k.folge === this.puffer[0]);
      if (neu) {
        this.puffer = [];
        return neu.folge;
      }
      if (!this.kuerzel.some((k) => k.folge.startsWith(this.puffer[0] + ' '))) this.puffer = [];
    }
    return null;
  }

  zuruecksetzen() {
    this.puffer = [];
  }
}

export function istMac(): boolean {
  return typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
}
