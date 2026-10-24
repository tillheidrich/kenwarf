/**
 * Vorführdaten für die Konsole (Screenshots, Pitch der Konsole selbst). Alle Firmen und Personen sind erfunden.
 * Läuft mit einer verschiebbaren Uhr, damit Tests, Fristen und Zahlungen echte Abläufe durchlaufen.
 */
import { Leitstand } from './leitstand.js';
import { DummyBereitsteller } from './bereitsteller/dummy.js';
import { MollieFake } from './mollie.js';
import type { DB } from './db.js';

export async function fuelleVorfuehrung(db: DB, uhr: { t: number }, opt: { bereitsteller?: DummyBereitsteller; mollie?: MollieFake } = {}) {
  const b = opt.bereitsteller ?? new DummyBereitsteller('kenwarf.example.org');
  const m = opt.mollie ?? new MollieFake();
  const echt = uhr.t;
  const tag = 86_400_000;
  uhr.t = echt - 40 * tag;
  const l = new Leitstand({
    db, bereitsteller: b, mollie: m, jetzt: () => new Date(uhr.t), domain: 'kenwarf.example.org', rechnungLink: 'https://rechnungen.example.org/kunden/{ref}',
    schalter: { tests_offen: true, managed_domain: 'kenwarf.example.org' },
    geteilteHosts: [
      { id: 'host-01', name: 'Bestand CX33 (nur Demo und Pitch)', region: 'de-nbg', aktiv: true, zweck: ['pitch'], kapazitaet: { container_max: 10, ram_mb: 4096, speicher_bytes: 40 * 1024 ** 3 } },
      { id: 'kern-01', name: 'Kern-Host CX43 Nürnberg', region: 'de-nbg', aktiv: true, zweck: ['test', 'kunde'], kapazitaet: { container_max: 24, ram_mb: 12288, speicher_bytes: 300 * 1024 ** 3 } },
    ],
  });
  const wer = 'till';

  l.partnerAnlegen({ code: 'LINKEDIN-ANNA', name: 'Anna Rehders (Creatorin, Handwerk digital)', art: 'influencer', provision_prozent: 15, laufzeit_monate: 12, aktiv: true, vereinbarung: 'Mail vom 02.10.2026' }, wer);
  l.partnerAnlegen({ code: 'NORDIT', name: 'Nord-IT Buchholz GmbH', art: 'systemhaus', provision_prozent: 0, laufzeit_monate: 0, aktiv: true, vereinbarung: 'keine Provision, Einweisung als Leistung' }, wer);
  l.partnerAnlegen({ code: 'STB-HOLM', name: 'Steuerkanzlei Holm (Empfehler)', art: 'empfehler', provision_prozent: 10, laufzeit_monate: 6, aktiv: true }, wer);

  // Selbstbucher über Mollie mit Code aus LinkedIn (Zustimmung im Checkout)
  m.zahlungen.set('tr_7Kq2Wm9ZpL', { id: 'tr_7Kq2Wm9ZpL', status: 'paid', amount: { value: '129.00', currency: 'EUR' }, sequenceType: 'first', customerId: 'cst_Rf4gH8', subscriptionId: 'sub_Lp3Q9x', createdAt: new Date(uhr.t).toISOString(), paidAt: new Date(uhr.t).toISOString(),
    metadata: { kunde: { firma: 'Elektro Tamsen GmbH', name: 'Hauke Tamsen', mail: 'hauke@elektro-tamsen.example' }, paket: 'betrieb', empfehlungscode: 'LINKEDIN-ANNA', zuordnung_zustimmung: true, code_weg: 'link', ki_vorlage: 'mistral' } });
  m.abos.set('sub_Lp3Q9x', { id: 'sub_Lp3Q9x', status: 'active', amount: { value: '129.00', currency: 'EUR' }, interval: '1 month', nextPaymentDate: new Date(echt + 9 * tag).toISOString().slice(0, 10), customerId: 'cst_Rf4gH8' });
  await l.mollieWebhook('tr_7Kq2Wm9ZpL');

  uhr.t += 3 * tag;
  // Selbst akquiriert, Rechnung, später hochgestuft
  const wiese = l.kundeAnlegen({ firma: 'Zimmerei Wiese & Söhne', ansprechpartner: 'Gesa Wiese', mail: 'gesa@zimmerei-wiese.example', typ: 'direkt', rechnungsweg: 'rechnung', quelle: 'Handwerkerstammtisch Tostedt', rechnung_ref: '10042', notizen: 'Will Meisterwissen vor Übergabe an Sohn sichern. Termin Einarbeitung 12.11.' }, wer);
  const rw = await l.instanzAnlegen({ kunde_id: wiese.id, herkunft: { art: 'manuell' }, paket: 'team', zahlung: 'rechnung', ki_vorlage: 'ionos' }, wer);
  b.setzeStatus(rw.instanz.id, { speicher_bytes: 2_731_904_118, benutzer: 11, letzte_anmeldung_tag: new Date(echt - tag).toISOString().slice(0, 10), backup_letztes: new Date(echt - 6 * 3600_000).toISOString() });

  // Systemhaus-Kunde
  const nordit = l.kundeAnlegen({ firma: 'Nord-IT Buchholz GmbH', ansprechpartner: 'Jens Oltmanns', mail: 'j.oltmanns@nord-it.example', typ: 'systemhaus', rechnungsweg: 'rechnung', quelle: 'Anfrage über Website', rechnung_ref: '10043' }, wer);
  const rn = await l.instanzAnlegen({ kunde_id: nordit.id, herkunft: { art: 'manuell' }, paket: 'klein', zahlung: 'rechnung', ki_vorlage: 'ollama', region: 'de-fsn' }, wer);
  b.setzeStatus(rn.instanz.id, { speicher_bytes: 391_220_118, benutzer: 3 });

  uhr.t += 12 * tag;
  // Verein, kostenfrei
  const verein = l.kundeAnlegen({ firma: 'TSV Todtglüsingen e. V.', ansprechpartner: 'Birte Heins', mail: 'vorstand@tsv-todtgluesingen.example', typ: 'gemeinnuetzig', rechnungsweg: 'keiner', quelle: 'Vereinsabend' }, wer);
  await l.instanzAnlegen({ kunde_id: verein.id, herkunft: { art: 'manuell' }, paket: 'klein', zahlung: 'frei', ki_vorlage: 'mistral' }, wer);

  uhr.t += 8 * tag;
  // Tests in verschiedenen Phasen
  const bau = l.kundeAnlegen({ firma: 'Bauunternehmung Peters', ansprechpartner: 'Ole Peters', mail: 'ole@bau-peters.example', typ: 'selbstbucher', rechnungsweg: 'mollie', quelle: 'Testformular' }, wer);
  await l.instanzAnlegen({ kunde_id: bau.id, herkunft: { art: 'formular' }, paket: 'betrieb', ki_vorlage: 'mistral' }, 'formular');
  uhr.t += 6 * tag;
  const ing = l.kundeAnlegen({ firma: 'Ingenieurbüro Marten', ansprechpartner: 'Fenja Marten', mail: 'f.marten@ib-marten.example', typ: 'direkt', rechnungsweg: 'rechnung', quelle: 'Empfehlung Steuerkanzlei', empfehlungscode: 'STB-HOLM', zuordnung_zustimmung: true, zuordnung_weg: 'manuell', notizen: 'Will eigenes Modell im Firmennetz anbinden.' }, wer);
  const ri = await l.instanzAnlegen({ kunde_id: ing.id, herkunft: { art: 'manuell', empfehlungscode: 'STB-HOLM' }, paket: 'betrieb', ki_vorlage: 'eigener' }, wer);
  l.kontoEgressAnfrage(ri.instanz.id, 'llm.ib-marten.example', 'Eigenes Modell (vLLM) im Rechenzentrum des Büros');
  // Kanzlei: Berufsgeheimnisträger, Managed bis S-12 gesperrt; bleibt Interessent (lokal)
  l.kundeAnlegen({ firma: 'Kanzlei Thormählen', ansprechpartner: 'Ole Thormählen', mail: 'ot@kanzlei-thormaehlen.example', typ: 'direkt', rechnungsweg: 'rechnung', quelle: 'Anwaltverein Stade', berufsgeheimnis: true, notizen: 'Lokale Installation mit Ollama, Konzept geschickt.' }, wer);

  // Zahlung schlägt fehl (Folgeabbuchung Tamsen? nein: zweiter Selbstbucher)
  m.zahlungen.set('tr_Hn5vB2c8Qe', { id: 'tr_Hn5vB2c8Qe', status: 'paid', amount: { value: '59.00', currency: 'EUR' }, sequenceType: 'first', customerId: 'cst_Wq81Zt', subscriptionId: 'sub_Mz7Tr2', createdAt: new Date(uhr.t).toISOString(), paidAt: new Date(uhr.t).toISOString(),
    metadata: { kunde: { firma: 'Hofladen Brunsmeier', name: 'Insa Brunsmeier', mail: 'insa@hofladen-brunsmeier.example' }, paket: 'klein', ki_vorlage: 'mistral' } });
  m.abos.set('sub_Mz7Tr2', { id: 'sub_Mz7Tr2', status: 'active', amount: { value: '59.00', currency: 'EUR' }, interval: '1 month', nextPaymentDate: new Date(echt + 26 * tag).toISOString().slice(0, 10), customerId: 'cst_Wq81Zt' });
  await l.mollieWebhook('tr_Hn5vB2c8Qe');

  uhr.t = echt - 4 * tag;
  const t2 = l.kundeAnlegen({ firma: 'Malerbetrieb Kück', ansprechpartner: 'Sven Kück', mail: 'info@maler-kueck.example', typ: 'creator', rechnungsweg: 'mollie', quelle: 'LinkedIn', empfehlungscode: 'LINKEDIN-ANNA', zuordnung_zustimmung: true, zuordnung_weg: 'checkout' }, wer);
  await l.instanzAnlegen({ kunde_id: t2.id, herkunft: { art: 'formular', empfehlungscode: 'LINKEDIN-ANNA' }, paket: 'klein', ki_vorlage: 'mistral' }, 'formular');

  // Folgeabbuchung Tamsen bezahlt, Brunsmeier fehlgeschlagen
  uhr.t = echt - 2 * tag;
  m.zahlungen.set('tr_Tz3mK1oP9a', { id: 'tr_Tz3mK1oP9a', status: 'paid', amount: { value: '129.00', currency: 'EUR' }, sequenceType: 'recurring', customerId: 'cst_Rf4gH8', subscriptionId: 'sub_Lp3Q9x', createdAt: new Date(uhr.t).toISOString(), paidAt: new Date(uhr.t).toISOString(), metadata: null });
  await l.mollieWebhook('tr_Tz3mK1oP9a');
  m.zahlungen.set('tr_Fq8sD4yN2r', { id: 'tr_Fq8sD4yN2r', status: 'failed', amount: { value: '59.00', currency: 'EUR' }, sequenceType: 'recurring', customerId: 'cst_Wq81Zt', subscriptionId: 'sub_Mz7Tr2', createdAt: new Date(uhr.t).toISOString(), metadata: null });
  await l.mollieWebhook('tr_Fq8sD4yN2r');

  // Hochstufen Zimmerei auf eigene Maschine (vor 1 Tag)
  uhr.t = echt - 1 * tag;
  await l.stufeWechseln(rw.instanz.id, 'eigen', wer);

  // Pitches
  uhr.t = echt - 2 * 3600_000;
  await l.pitchAnlegen({ beispiel: 'tischlerei-wendt', tage: 7, fuer: 'innung-harburg' }, wer);
  await l.pitchAnlegen({ beispiel: 'kanzlei-behrens', tage: 3, fuer: 'anwaltverein' }, wer);

  // Systemhaus kündigt zum Monatsende, Tamsen will nachts auf eigene Maschine
  l.kontoKuendigen(rn.instanz.id, wer);
  uhr.t = echt;
  const tamsenI = l.instanzen().find((i) => i.subdomain.startsWith('elektro-tamsen'));
  if (tamsenI) l.stufeWechselnNachts(tamsenI.id, 'eigen', wer);
  const planer = await l.planer();
  // eine Instanz mit Warnung (Backup)
  const tamsen = l.instanzen().find((i) => i.subdomain.startsWith('elektro-tamsen'));
  if (tamsen) { b.setzeStatus(tamsen.id, { backup_ok: false, speicher_bytes: 1_184_330_221, benutzer: 7 }); await l.aktualisiereBetrieb(tamsen.id); }
  for (const i of l.instanzen()) { try { await l.aktualisiereBetrieb(i.id); } catch { /* */ } }
  return { leitstand: l, planer };
}
