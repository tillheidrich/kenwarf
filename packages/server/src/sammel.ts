import type { KernLike, SammelErgebnis, SammelFilter, User, Vorschlag } from './types.js';
import { REGEL_ORDNER } from './types.js';
import { KernFehler, keineRechte, ungueltig } from './fehler.js';
import { darf } from './rechte.js';

/**
 * v1.4.1 U10: Sammelfreigabe für REST und MCP mit denselben Rechten wie die Einzelfreigabe:
 * nur freigeber/admin, Regeln (wissen/_regeln/) nur admin. Der Server ermittelt die passenden Vorschläge selbst,
 * nimmt Regel-Vorschläge für Nicht-Admins heraus (sie stehen in `fehler`) und übergibt core nur noch IDs.
 * core entscheidet jeden Vorschlag einzeln über `entscheide` (Konflikte, Commits wie dort).
 */
export async function sammelEntscheiden(kern: KernLike, u: User, filter: SammelFilter, e: { aktion: 'freigeben' | 'ablehnen'; begruendung?: string }, opt: { ohneRegeln?: boolean } = {}): Promise<SammelErgebnis & { gefunden: number }> {
  if (!darf(u, 'entscheiden')) throw keineRechte('Sammelfreigabe brauchen die Rolle "freigeber" oder "admin".');
  if (!filter.ids?.length && !filter.grund && !filter.quelle && !filter.von) throw ungueltig('Sammelfreigabe braucht ids, grund, quelle oder von.');
  if (typeof kern.entscheideSammel !== 'function') throw new KernFehler(501, 'Die Sammelfreigabe kommt mit core (v1.4.1 U10).', 'nicht_verfuegbar');
  const offen = (await kern.eingang(u, { alle: true })).filter((v: Vorschlag) =>
    v.status === 'offen'
    && (!filter.ids || filter.ids.includes(v.id))
    && (!filter.grund || v.grund === filter.grund)
    && (!filter.quelle || (v as { quelle?: string }).quelle === filter.quelle)
    && (!filter.von || v.von === filter.von)
    && (!filter.art || v.art === filter.art),
  ).slice(0, 500);
  const fehler: SammelErgebnis['fehler'] = [];
  const ids: string[] = [];
  for (const v of offen) {
    if (e.aktion === 'freigeben' && opt.ohneRegeln && v.ziel.startsWith(REGEL_ORDNER)) fehler.push({ id: v.id, meldung: 'Regeln (wissen/_regeln/) nur in der Weboberfläche durch einen Admin freigeben.' });
    else if (e.aktion === 'freigeben' && !u.rollen.includes('admin') && v.ziel.startsWith(REGEL_ORDNER)) fehler.push({ id: v.id, meldung: 'Regeln (wissen/_regeln/) darf nur ein Admin freigeben.' });
    else ids.push(v.id);
  }
  if (!ids.length) return { erledigt: [], konflikte: [], fehler, gefunden: offen.length };
  const r = await kern.entscheideSammel(u, { ids }, e);
  return { erledigt: r.erledigt, konflikte: r.konflikte, fehler: [...fehler, ...r.fehler], gefunden: offen.length };
}
