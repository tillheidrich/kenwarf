/**
 * Alle Mails des Leitstands als Klartext (CONTRACT v1.4 3.3, G1 Z-2 bis Z-6). Regeln:
 *  - Du-Form; Kanzleien und andere Berufsgeheimnisträger (`Kunde.berufsgeheimnis`) bekommen die Sie-Form.
 *  - Keine Dark Patterns: kein Countdown, keine Dringlichkeitswörter, kein Rabatt beim Ablauf, Knöpfe gleichrangig
 *    als gleich gestaltete Zeilen, immer der Satz, was passiert, wenn man nichts tut.
 *  - Vertrags- und Fristmails sind keine Werbung und haben deshalb keinen Abmeldelink. Abbestellbar ist nur der Hinweis
 *    zur Halbzeit (`art: 'hinweis'`), weil er über das Nötige hinausgeht (§ 7 Abs. 3 UWG sinngemäß).
 *  - Produktname nur aus `produkt` (Schalter S-3).
 */
export type Anrede = 'du' | 'sie';
export interface MailText { betreff: string; text: string; art: 'vertrag' | 'hinweis' | 'geheim' }
export interface Kontext { anrede: Anrede; produkt: string; datum: (iso: string | null) => string; konto_url?: string; abmelden_url?: string }

const gruss = (k: Kontext) => `\n\nViele Grüße\nTill Heidrich, ${k.produkt}`;
const w = (k: Kontext, du: string, sie: string) => (k.anrede === 'sie' ? sie : du);
const knoepfe = (k: Kontext, eintraege: string[]) => `\n\n${eintraege.map((e) => `- ${e}`).join('\n')}${k.konto_url ? `\n\nAlles davon unter ${k.konto_url}` : ''}`;

export const MAILS = {
  zugang_test: (k: Kontext, e: { test_ende: string | null }): MailText => ({ art: 'vertrag', betreff: w(k, 'Dein Zugang ist da', 'Ihr Zugang ist da'),
    text: w(k, `Hallo,\n\ndeine Testphase läuft bis ${k.datum(e.test_ende)}, 23:59 Uhr.\n\nDrei Schritte bis zur ersten Antwort: anmelden, ein Dokument hinzufügen oder deine eigene KI anbinden, eine Frage stellen. Antworten kommen meist in wenigen Sekunden, bei großen Dokumenten dauert das Einlesen länger.\n\nDer Export-Knopf liegt unter Einstellungen › Konto. Wenn du nichts tust, wird nichts abgebucht.`,
      `Guten Tag,\n\nIhre Testphase läuft bis ${k.datum(e.test_ende)}, 23:59 Uhr.\n\nDrei Schritte bis zur ersten Antwort: anmelden, ein Dokument hinzufügen oder Ihre eigene KI anbinden, eine Frage stellen.\n\nDer Export-Knopf liegt unter Einstellungen › Konto. Wenn Sie nichts tun, wird nichts abgebucht.`) + gruss(k) }),
  zugang_aktiv: (k: Kontext): MailText => ({ art: 'vertrag', betreff: w(k, 'Dein Zugang ist da', 'Ihr Zugang ist da'),
    text: w(k, 'Hallo,\n\ndeine Instanz ist eingerichtet. Das Einmal-Passwort kommt in einer eigenen Mail. Export jederzeit unter Einstellungen › Konto.', 'Guten Tag,\n\nIhre Instanz ist eingerichtet. Das Einmal-Passwort kommt in einer eigenen Mail. Export jederzeit unter Einstellungen › Konto.') + gruss(k) }),
  einladung: (k: Kontext, e: { url: string; name: string; passwort: string }): MailText => ({ art: 'geheim', betreff: w(k, 'Dein Einmal-Zugang', 'Ihr Einmal-Zugang'),
    text: w(k, `Hallo,\n\nAdresse: ${e.url}\nAnmeldename: ${e.name}\nEinmal-Passwort: ${e.passwort}\n\nBeim ersten Anmelden legst du ein eigenes Passwort fest. Danach gilt dieses nicht mehr. Wir speichern es nicht.`,
      `Guten Tag,\n\nAdresse: ${e.url}\nAnmeldename: ${e.name}\nEinmal-Passwort: ${e.passwort}\n\nBeim ersten Anmelden legen Sie ein eigenes Passwort fest. Danach gilt dieses nicht mehr. Wir speichern es nicht.`) + gruss(k) }),
  halbzeit: (k: Kontext): MailText => ({ art: 'hinweis', betreff: 'Halbzeit',
    text: w(k, 'Hallo,\n\ndie Hälfte deiner Testphase ist um. Die Kontextbilanz in deiner Instanz zeigt, was schon drin ist, welche Fragen beantwortet wurden und wo noch Lücken sind. Ein guter nächster Schritt: die drei Dokumente hinzufügen, nach denen am häufigsten gefragt wird.',
      'Guten Tag,\n\ndie Hälfte Ihrer Testphase ist um. Die Kontextbilanz in Ihrer Instanz zeigt, was schon drin ist, welche Fragen beantwortet wurden und wo noch Lücken sind. Ein guter nächster Schritt: die drei Dokumente hinzufügen, nach denen am häufigsten gefragt wird.')
      + gruss(k) + (k.abmelden_url ? `\n\n${w(k, 'Solche Hinweise nicht mehr bekommen', 'Solche Hinweise nicht mehr erhalten')}: ${k.abmelden_url}` : '') }),
  test_endet: (k: Kontext, e: { test_ende: string | null; verlaengern_moeglich: boolean; lesefrist: number }): MailText => ({ art: 'vertrag', betreff: w(k, `Deine Testphase endet am ${k.datum(e.test_ende)}`, `Ihre Testphase endet am ${k.datum(e.test_ende)}`),
    text: w(k, 'Hallo,\n\ndu kannst jetzt eins davon tun, alle Wege sind gleichwertig:', 'Guten Tag,\n\nSie können jetzt eins davon tun, alle Wege sind gleichwertig:')
      + knoepfe(k, ['Kaufen', ...(e.verlaengern_moeglich ? ['Einmal 14 Tage verlängern'] : []), 'Alles herunterladen', 'Jetzt löschen'])
      + `\n\n${w(k, `Wenn du nichts tust, wird nichts abgebucht. Danach ist alles ${e.lesefrist} Tage nur lesbar, du kannst alles herunterladen, dann löschen wir und sagen vorher Bescheid.`, `Wenn Sie nichts tun, wird nichts abgebucht. Danach ist alles ${e.lesefrist} Tage nur lesbar, Sie können alles herunterladen, dann löschen wir und sagen vorher Bescheid.`)}` + gruss(k) }),
  test_beendet: (k: Kontext, e: { loeschen_am: string }): MailText => ({ art: 'vertrag', betreff: 'Testphase beendet',
    text: w(k, `Hallo,\n\ndeine Testphase ist vorbei. Abgebucht wurde nichts. Alles bleibt bis ${k.datum(e.loeschen_am)} lesbar und herunterladbar, dann löschen wir es und sagen vorher noch einmal Bescheid.`, `Guten Tag,\n\nIhre Testphase ist vorbei. Abgebucht wurde nichts. Alles bleibt bis ${k.datum(e.loeschen_am)} lesbar und herunterladbar, dann löschen wir es und sagen vorher noch einmal Bescheid.`) + gruss(k) }),
  nur_lesen: (k: Kontext, e: { grund: string; loeschen_am: string }): MailText => ({ art: 'vertrag', betreff: w(k, 'Deine Instanz ist jetzt nur lesbar', 'Ihre Instanz ist jetzt nur lesbar'),
    text: w(k, `Hallo,\n\n${e.grund}. Alles bleibt bis ${k.datum(e.loeschen_am)} lesbar und herunterladbar, dann löschen wir und sagen vorher Bescheid. Wenn du wieder buchst, geht es ohne Datenverlust weiter.`, `Guten Tag,\n\n${e.grund}. Alles bleibt bis ${k.datum(e.loeschen_am)} lesbar und herunterladbar, dann löschen wir und sagen vorher Bescheid. Wenn Sie wieder buchen, geht es ohne Datenverlust weiter.`) + gruss(k) }),
  /** v1.4 3.3: Lesephase nach Kündigung oder Zahlungsausfall, Mails an Tag 1, 14 und 28. */
  lesephase: (k: Kontext, e: { tag: 1 | 14 | 28; loeschen_am: string }): MailText => ({ art: 'vertrag', betreff: w(k, `Lesephase Tag ${e.tag}: Löschung am ${k.datum(e.loeschen_am)}`, `Lesephase Tag ${e.tag}: Löschung am ${k.datum(e.loeschen_am)}`),
    text: w(k, `Hallo,\n\ndeine Instanz ist nur lesbar. Am ${k.datum(e.loeschen_am)} löschen wir sie.`, `Guten Tag,\n\nIhre Instanz ist nur lesbar. Am ${k.datum(e.loeschen_am)} löschen wir sie.`)
      + knoepfe(k, ['Wieder buchen', 'Alles herunterladen', 'Jetzt löschen']) + `\n\n${w(k, 'Wenn du nichts tust, löschen wir zum genannten Tag und schicken dir das Löschprotokoll.', 'Wenn Sie nichts tun, löschen wir zum genannten Tag und schicken Ihnen das Löschprotokoll.')}` + gruss(k) }),
  loeschung_am: (k: Kontext, e: { loeschen_am: string }): MailText => ({ art: 'vertrag', betreff: `Löschung am ${k.datum(e.loeschen_am)}`,
    text: w(k, `Hallo,\n\nam ${k.datum(e.loeschen_am)} löschen wir deine Instanz. Bis dahin kannst du alles herunterladen.`, `Guten Tag,\n\nam ${k.datum(e.loeschen_am)} löschen wir Ihre Instanz. Bis dahin können Sie alles herunterladen.`) + (k.konto_url ? `\n\nHerunterladen: ${k.konto_url}` : '') + gruss(k) }),
  geloescht: (k: Kontext, e: { am: string; umfang: string }): MailText => ({ art: 'vertrag', betreff: 'Gelöscht',
    text: `${w(k, 'Hallo', 'Guten Tag')},\n\nLöschprotokoll\nZeitpunkt: ${e.am}\nUmfang: ${e.umfang}` + gruss(k) }),
  verlaengert: (k: Kontext, e: { test_ende: string | null }): MailText => ({ art: 'vertrag', betreff: w(k, 'Deine Testphase wurde verlängert', 'Ihre Testphase wurde verlängert'), text: `${w(k, 'Hallo', 'Guten Tag')},\n\nneues Testende: ${k.datum(e.test_ende)}, 23:59 Uhr.` + gruss(k) }),
  kuendigung: (k: Kontext, e: { zum: string; lesefrist: number }): MailText => ({ art: 'vertrag', betreff: 'Kündigung bestätigt',
    text: w(k, `Hallo,\n\ndeine Buchung endet am ${k.datum(e.zum)}. Bis dahin läuft alles wie gewohnt, danach ist alles ${e.lesefrist} Tage lesbar und herunterladbar. Du kannst die Kündigung bis dahin im Konto zurücknehmen.`, `Guten Tag,\n\nIhre Buchung endet am ${k.datum(e.zum)}. Bis dahin läuft alles wie gewohnt, danach ist alles ${e.lesefrist} Tage lesbar und herunterladbar. Sie können die Kündigung bis dahin im Konto zurücknehmen.`) + gruss(k) }),
  /** G1 Z-2: spätestens 3 Tage vor jedem Einzug Betrag und Datum (zugleich SEPA-Vorabinformation). */
  vorankuendigung: (k: Kontext, e: { betrag: string; am: string }): MailText => ({ art: 'vertrag', betreff: `Einzug am ${k.datum(e.am)}: ${e.betrag}`,
    text: w(k, `Hallo,\n\nam ${k.datum(e.am)} buchen wir ${e.betrag} über deinen hinterlegten Zahlungsweg ab. Die Rechnung kommt binnen 7 Tagen per Mail.`, `Guten Tag,\n\nam ${k.datum(e.am)} buchen wir ${e.betrag} über Ihren hinterlegten Zahlungsweg ab. Die Rechnung kommt binnen 7 Tagen per Mail.`) + gruss(k) }),
  zahlung_offen: (k: Kontext, e: { kulanz_bis: string }): MailText => ({ art: 'vertrag', betreff: 'Abbuchung hat nicht geklappt',
    text: w(k, `Hallo,\n\ndie letzte Abbuchung ist fehlgeschlagen. Alles läuft weiter. Mollie versucht es in den nächsten Tagen erneut; du kannst auch im Konto einen anderen Zahlungsweg hinterlegen. Klappt bis ${k.datum(e.kulanz_bis)} keine Zahlung, ist die Instanz danach nur lesbar, gelöscht wird nichts ohne weitere Ankündigung.`,
      `Guten Tag,\n\ndie letzte Abbuchung ist fehlgeschlagen. Alles läuft weiter. Mollie versucht es in den nächsten Tagen erneut; Sie können auch im Konto einen anderen Zahlungsweg hinterlegen. Klappt bis ${k.datum(e.kulanz_bis)} keine Zahlung, ist die Instanz danach nur lesbar, gelöscht wird nichts ohne weitere Ankündigung.`) + gruss(k) }),
  stufe: (k: Kontext, e: { stufe: string; betrag?: string }): MailText => ({ art: 'vertrag', betreff: w(k, `Deine Instanz läuft jetzt auf: ${e.stufe}`, `Ihre Instanz läuft jetzt auf: ${e.stufe}`),
    text: `${w(k, 'Hallo', 'Guten Tag')},\n\nder Wechsel ist abgeschlossen und geprüft (gleiche Prüfsumme an beiden Orten). Adresse und Zugänge bleiben gleich.${e.betrag ? ` Neuer Monatsbetrag ab heute: ${e.betrag}.` : ''}` + gruss(k) }),
  loeschwunsch: (k: Kontext, e: { subdomain: string; link: string }): MailText => ({ art: 'vertrag', betreff: 'Löschung bestätigen',
    text: w(k, `Hallo,\n\nklicke diesen Link, um ${e.subdomain} endgültig zu löschen (48 Stunden gültig): ${e.link}\n\nWenn du das nicht warst, ignoriere diese Mail, dann passiert nichts.`, `Guten Tag,\n\nklicken Sie diesen Link, um ${e.subdomain} endgültig zu löschen (48 Stunden gültig): ${e.link}\n\nWenn Sie das nicht waren, ignorieren Sie diese Mail, dann passiert nichts.`) }),
} as const;

/** Prüft einen Text auf Dark Patterns (für Tests und als Schutz beim Ändern). */
export function darkPatterns(t: string): string[] {
  const muster: [RegExp, string][] = [[/nur noch \d+|letzte chance|jetzt zugreifen|beeil|sofort handeln|countdown|läuft ab in/i, 'Dringlichkeit'], [/rabatt|% günstiger|nachlass/i, 'Ablauf-Rabatt'], [/\[x\]|vorausgewählt/i, 'Vorauswahl']];
  return muster.filter(([m]) => m.test(t)).map(([, n]) => n);
}
