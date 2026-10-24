/** Fehler mit HTTP-Status. Meldungen sind deutsch und für Laien lesbar. */
export class KernFehler extends Error {
  constructor(public status: number, message: string, public code?: string) {
    super(message);
    this.name = 'KernFehler';
  }
}

export const nichtGefunden = (was = 'Nicht gefunden.') => new KernFehler(404, was, 'nicht_gefunden');
export const keineRechte = (was = 'Dafür fehlen dir die Rechte.') => new KernFehler(403, was, 'keine_rechte');
export const ungueltig = (was: string) => new KernFehler(400, was, 'ungueltig');

/**
 * Übersetzt Fehler aus @kern/core oder der Attrappe in HTTP-Status.
 * Annahme (NOTES/server.md): core wirft Fehler mit `status` (Zahl) oder `code`
 * (`nicht_gefunden`, `keine_rechte`, `ungueltig`, `ENOENT`). Sonst Textsuche, sonst 500.
 */
export function statusAusFehler(err: unknown): { status: number; meldung: string } {
  const e = err as { status?: unknown; statusCode?: unknown; code?: unknown; message?: unknown; name?: unknown };
  // P2 (N5): keine Dateisystempfade aus fremden Fehlern an den Client.
  const roh = typeof e?.message === 'string' ? e.message : 'Interner Fehler.';
  const msg = err instanceof KernFehler ? roh : ohnePfade(roh);
  const st = typeof e?.status === 'number' ? e.status : typeof e?.statusCode === 'number' ? e.statusCode : undefined;
  if (st && st >= 400 && st < 600) return { status: st, meldung: msg };
  const code = typeof e?.code === 'string' ? e.code.toLowerCase() : '';
  if (code === 'enoent' || code.includes('nicht_gefunden') || code === 'not_found') return { status: 404, meldung: 'Nicht gefunden.' };
  if (code.includes('rechte') || code === 'forbidden' || code === 'eacces') return { status: 403, meldung: 'Dafür fehlen dir die Rechte.' };
  if (code.includes('ungueltig') || code === 'invalid') return { status: 400, meldung: msg };
  if (code === 'konflikt' || code === 'conflict') return { status: 409, meldung: msg };
  if (/nicht gefunden|not found|existiert nicht/i.test(msg)) return { status: 404, meldung: msg };
  if (/keine rechte|nicht erlaubt|verboten|forbidden|darf nicht/i.test(msg)) return { status: 403, meldung: msg };
  if (/ungültig|ungueltig|invalid|pfad/i.test(msg)) return { status: 400, meldung: msg };
  if (e?.name === 'ZodError') return { status: 400, meldung: msg };
  return { status: 500, meldung: 'Interner Fehler.' };
}

/** Ersetzt absolute Pfade (Unix und Windows) in Fehlermeldungen. */
export function ohnePfade(s: string): string {
  return s.replace(/(?:[A-Za-z]:\\|\/)(?:[^\s'"`:,()]+[\\/])+[^\s'"`:,()]*/g, '…').slice(0, 500);
}
