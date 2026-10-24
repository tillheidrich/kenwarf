/** Seiten der Konsole. Zeigen ausschließlich Betriebsdaten der Instanzen, nie Inhalte. */
import type { Leitstand } from '../leitstand.js';
import { FRISTEN, tageBis } from '../regeln.js';
import type { Instanz, Kunde, KontoTyp } from '../typen.js';
import { BEISPIELE, STUFEN, INSTANZ_STATUS, KI_VORLAGEN, KONTO_STATUS, KONTO_TYPEN, PAKETE, PARTNER_ARTEN, PRODUKTNAME, REGIONEN, STATUS_TEXT } from '../typen.js';
import { Balken, Csrf, Feld, fmt, Gleis, Leer, Seite, StatusMarke, StufeMarke, type SeitenKontext } from './ui.js';
import type { Host, HostLast } from '../typen.js';
import { SCHALTER_TEXT } from '../schalter.js';

export type HostMitLast = { h: Host; last: HostLast & { anteil: number; ampel: 'ok' | 'warnung' | 'voll'; anspruch_bytes: number; rueckfall: number } };

const firmaVon = (l: Leitstand, i: Instanz) => (i.kunde_id ? l.kunde(i.kunde_id).firma : i.herkunft.notiz ? `Pitch ${i.herkunft.notiz}` : 'Pitch ohne Kunde');
const HERKUNFT: Record<string, string> = { mollie: 'Mollie', formular: 'Testformular', manuell: 'Von Hand', pitch: 'Pitch', partner: 'Partner' };

// ---------------- Heute ----------------
export function HeuteSeite({ l, k, hosts }: { l: Leitstand; k: SeitenKontext; hosts: HostMitLast[] }) {
  const h = l.heute();
  const jetzt = l.jetzt();
  const aktiv = h.je_status.aktiv ?? 0;
  const tests = h.je_status.test ?? 0;
  return (
    <Seite k={k} titel="Heute" aktion={<span class="mono gedaempft klein">{fmt.zeit(jetzt.toISOString())}</span>}>
      {(() => { const sch = l.schalter(); return !sch.kauf_offen || !sch.tests_offen || sch.neue_tests_pausiert || !sch.managed_domain ? (
        <p class="hinweis">Selbstbedienung: Kauf {sch.kauf_offen ? 'offen' : 'geschlossen'}, Testformular {sch.tests_offen ? (sch.neue_tests_pausiert ? 'pausiert' : 'offen') : 'geschlossen'}{sch.managed_domain ? '' : ', Domain fehlt (S-2)'}. Handanlage und Pitches gehen immer. <a href="/schalter">Schalter</a></p>
      ) : null; })()}
      <dl class="zahlenreihe">
        <div><dt>Aktiv</dt><dd class="mono">{aktiv}</dd></div>
        <div><dt>Im Test</dt><dd class="mono">{tests}</dd></div>
        <div><dt>Pitches</dt><dd class="mono">{h.je_status.demo ?? 0}</dd></div>
        <div><dt>Abo-Umsatz / Monat</dt><dd class="mono">{fmt.euro(h.mrr_cent)}</dd></div>
        <div><dt>Offene Vorgänge</dt><dd class="mono">{h.offene_vorgaenge}</dd></div>
      </dl>

      <div class="zweispaltig">
        <section aria-labelledby="h-klick" class="spalte">
          <h2 id="h-klick" class="abschnitt">Braucht deinen Klick <span class="zaehler mono">{h.klick.length}</span></h2>
          {h.klick.length === 0 ? (
            <Leer titel="Nichts zu entscheiden." text="Fehlgeschlagene Zahlungen, gescheiterte Vorgänge, Warnungen und Löschungen zahlender Kunden landen hier." />
          ) : (
            <ul class="liste">
              {h.klick.map((x) => (
                <li class="zeile zeile--klick">
                  <div class="zeile-haupt">
                    <a href={`/instanzen/${x.instanz.id}`} class="zeile-titel">{x.kunde}</a>
                    <span class="mono klein gedaempft">{x.instanz.subdomain}</span>
                  </div>
                  <p class="zeile-text">{x.grund}</p>
                  <div class="zeile-fuss"><StatusMarke s={x.instanz.status} /><a class="knopf knopf--klein" href={`/instanzen/${x.instanz.id}`}>{x.aktion}</a></div>
                </li>
              ))}
            </ul>
          )}

          {l.egressAnfragen().length ? (
            <>
              <h2 class="abschnitt">Egress-Anfragen <span class="zaehler mono">{l.egressAnfragen().length}</span></h2>
              <ul class="liste">
                {l.egressAnfragen().map((a) => (
                  <li class="zeile zeile--klick">
                    <div class="zeile-haupt"><a class="zeile-titel" href={`/instanzen/${a.instanz_id}`}>{l.instanz(a.instanz_id).subdomain}</a><span class="mono klein">{a.host}</span></div>
                    <p class="zeile-text">{a.zweck}</p>
                    <div class="zeile-fuss">
                      <form method="post" action={`/instanzen/${a.instanz_id}/egress`} class="reihe reihe--eng"><Csrf k={k} /><input type="hidden" name="host" value={a.host} /><input type="hidden" name="grund" value={`Anfrage vom ${fmt.datum(a.am)}: ${a.zweck}`} /><button class="knopf knopf--klein" type="submit">Freigeben</button></form>
                      <form method="post" action={`/egress-anfragen/${a.id}/ablehnen`}><Csrf k={k} /><button class="link-knopf" type="submit">Ablehnen</button></form>
                    </div>
                  </li>
                ))}
              </ul>
            </>
          ) : null}

          <h2 class="abschnitt">Umzüge <span class="zaehler mono">{h.umzuege.length}</span></h2>
          {h.umzuege.length === 0 ? <p class="still">Kein Umzug offen.</p> : (
            <ul class="liste">
              {h.umzuege.map((x) => (
                <li class="zeile">
                  <div class="zeile-haupt"><a href={`/instanzen/${x.instanz.id}`} class="zeile-titel">{x.kunde}</a><StatusMarke s={x.instanz.status} /></div>
                  <p class="zeile-text">{x.instanz.status === 'umzug_laeuft' ? 'Wartet auf Prüfbericht der neuen Instanz. Danach Bestätigen klicken.' : `Alte Instanz wird am ${fmt.datum(x.instanz.loeschen_am)} automatisch gelöscht.`}</p>
                </li>
              ))}
            </ul>
          )}

          {h.offeneAuszahlungen.length ? (
            <>
              <h2 class="abschnitt">Provisionen offen <span class="zaehler mono">{h.offeneAuszahlungen.length}</span></h2>
              <p class="still">Summe {fmt.euro(h.offeneAuszahlungen.reduce((s, z) => s + z.provision_cent, 0))}. Auszahlung von Hand, dann <a href="/partner#auszahlungen">vermerken</a>.</p>
            </>
          ) : null}
        </section>

        <section aria-labelledby="h-auto" class="spalte">
          <h2 class="abschnitt">Geteilte Hosts</h2>
          {hosts.length === 0 ? <p class="still">Kein geteilter Host eingerichtet. <a href="/hosts">Host anlegen</a></p> : (
            <ul class="hostliste">
              {hosts.map(({ h, last }) => (
                <li class="host">
                  <div class="host-kopf"><a href="/hosts" class="mono">{h.id}</a><span class="mono klein">{Math.round(last.anteil * 100)} %</span></div>
                  <Balken anteil={last.anteil} ampel={last.ampel} label={`Auslastung ${h.id}`} />
                  <p class="klein gedaempft mono">{last.container}/{h.kapazitaet.container_max} Container · RAM {last.ram_belegt_mb}/{h.kapazitaet.ram_mb} MB · {fmt.bytes(last.speicher_belegt)} belegt{last.rueckfall ? ` · ${last.rueckfall} Rückfall` : ''}</p>
                </li>
              ))}
            </ul>
          )}
          <h2 id="h-auto" class="abschnitt">Läuft von selbst</h2>
          <p class="still klein">Der Planer läuft täglich: Mails an Tag 0, 7, 10, 13, 14, Testende + 23 und + {l.schalter().lesefrist_tage}; nach Testende, Kündigung oder 14 Tagen offener Zahlung nur lesen; Löschung nach {l.schalter().lesefrist_tage} Tagen; Pitches nach Ablauf weg; geplante Stufenwechsel um 02:00. Eine Löschung, die du für einen zahlenden Kunden geplant hast, führt er nie ohne deinen Klick aus.</p>
          <h3 class="unterabschnitt">Tests, die in 7 Tagen enden</h3>
          {h.tests.length === 0 ? <p class="still">Keiner.</p> : (
            <table class="tabelle tabelle--knapp">
              <thead><tr><th>Konto</th><th>Endet</th><th class="rechts">Rest</th></tr></thead>
              <tbody>
                {h.tests.sort((a, b) => a.tage - b.tage).map((x) => (
                  <tr><td><a href={`/instanzen/${x.instanz.id}`}>{x.kunde}</a></td><td class="mono">{fmt.datum(x.instanz.test_ende)}</td><td class="mono rechts">{fmt.tage(x.tage)}</td></tr>
                ))}
              </tbody>
            </table>
          )}
          <h3 class="unterabschnitt">Pitches</h3>
          {h.pitches.length === 0 ? <p class="still">Kein Pitch offen. <a href="/instanzen/neu?art=pitch">Pitch anlegen</a></p> : (
            <table class="tabelle tabelle--knapp">
              <thead><tr><th>Pitch</th><th>Beispiel</th><th class="rechts">Aufräumen in</th></tr></thead>
              <tbody>
                {h.pitches.map((x) => (
                  <tr><td><a href={`/instanzen/${x.instanz.id}`}>{x.instanz.subdomain}</a></td><td>{x.instanz.beispiel ? BEISPIELE[x.instanz.beispiel].split(' (')[0] : '–'}</td><td class="mono rechts">{fmt.tage(x.tage)}</td></tr>
                ))}
              </tbody>
            </table>
          )}
          <h3 class="unterabschnitt">Geplante Löschungen</h3>
          {h.loeschungen.length === 0 ? <p class="still">Keine.</p> : (
            <table class="tabelle tabelle--knapp">
              <thead><tr><th>Konto</th><th>Am</th><th class="rechts">Rest</th></tr></thead>
              <tbody>
                {h.loeschungen.map((x) => (
                  <tr><td><a href={`/instanzen/${x.instanz.id}`}>{x.kunde}</a></td><td class="mono">{fmt.datum(x.instanz.loeschen_am)}</td><td class="mono rechts">{fmt.tage(x.tage)}</td></tr>
                ))}
              </tbody>
            </table>
          )}
          {l.geplanteWechsel().length ? (
            <>
              <h3 class="unterabschnitt">Stufenwechsel heute Nacht</h3>
              <table class="tabelle tabelle--knapp"><thead><tr><th>Instanz</th><th>Nach</th><th class="rechts">Ab</th></tr></thead>
                <tbody>{l.geplanteWechsel().map((g) => <tr><td><a href={`/instanzen/${g.instanz_id}`} class="mono">{l.instanz(g.instanz_id).subdomain}</a></td><td><StufeMarke s={g.nach} /></td><td class="mono rechts">{fmt.zeit(g.ab)}</td></tr>)}</tbody></table>
            </>
          ) : null}
          {l.rueckfaelle().length ? (
            <>
              <h3 class="unterabschnitt">Rückfallebenen nach Stufenwechsel</h3>
              <table class="tabelle tabelle--knapp"><thead><tr><th>Instanz</th><th>Alter Host</th><th class="rechts">Löschen am</th></tr></thead>
                <tbody>{l.rueckfaelle().map((r) => <tr><td><a href={`/instanzen/${r.instanz_id}`} class="mono">{l.instanz(r.instanz_id).subdomain}</a></td><td class="mono">{r.host}</td><td class="mono rechts">{fmt.datum(r.loeschen_am)}</td></tr>)}</tbody></table>
            </>
          ) : null}
          <h3 class="unterabschnitt">Letzte 24 Stunden</h3>
          {h.letzte.length === 0 ? <p class="still">Ruhig.</p> : (
            <ol class="protokoll">
              {h.letzte.map((e) => (
                <li><span class="mono klein gedaempft">{fmt.zeit(e.am).split(', ')[1]}</span> <span class="mono klein">{e.wer}</span> {e.was.replace(/_/g, ' ')}{e.daten && 'grund' in e.daten ? `: ${String(e.daten.grund)}` : ''}</li>
              ))}
            </ol>
          )}
          <form method="post" action="/planer" class="reihe">
            <Csrf k={k} />
            <button class="knopf knopf--klein" type="submit">Planer jetzt laufen lassen</button>
          </form>
        </section>
      </div>
    </Seite>
  );
}

// ---------------- Instanzen ----------------
export function InstanzenSeite({ l, k, filter }: { l: Leitstand; k: SeitenKontext; filter: string | null }) {
  const alle = l.instanzen({ mitGeloeschten: filter === 'geloescht' });
  const liste = filter ? alle.filter((i) => i.status === filter) : alle;
  const zaehl: Record<string, number> = {};
  for (const i of alle) zaehl[i.status] = (zaehl[i.status] ?? 0) + 1;
  return (
    <Seite k={k} titel="Instanzen" aktion={<><a class="knopf" href="/hosts">Hosts und Auslastung</a><a class="knopf" href="/instanzen/neu?art=pitch">Pitch anlegen</a></>}>
      <nav class="filter" aria-label="Nach Status filtern">
        <a href="/instanzen" class={!filter ? 'chip ist-aktiv' : 'chip'}>Alle <span class="mono">{alle.length}</span></a>
        {INSTANZ_STATUS.filter((s) => zaehl[s]).map((s) => (
          <a href={`/instanzen?status=${s}`} class={filter === s ? 'chip ist-aktiv' : 'chip'}>{STATUS_TEXT[s]} <span class="mono">{zaehl[s]}</span></a>
        ))}
        <a href="/instanzen?status=geloescht" class={filter === 'geloescht' ? 'chip ist-aktiv' : 'chip'}>Gelöschte</a>
      </nav>
      {liste.length === 0 ? (
        <Leer titel="Noch keine Instanz." text="Instanzen entstehen aus einem Mollie-Kauf, dem Testformular oder hier von Hand. Alle Wege laufen durch denselben Vorgang." link={{ href: '/instanzen/neu', text: 'Erste Instanz anlegen' }} />
      ) : (
        <div class="tabelle-rahmen">
          <table class="tabelle">
            <thead>
              <tr><th>Konto</th><th>Status</th><th>Stufe</th><th class="nur-breit">Paket</th><th class="nur-breit">Herkunft</th><th class="nur-breit">Frist</th><th class="rechts nur-breit">Speicher</th><th class="nur-breit">Health</th></tr>
            </thead>
            <tbody>
              {liste.map((i) => {
                const frist = i.loeschen_am ? `löschen ${fmt.datum(i.loeschen_am)}` : i.test_ende ? `${i.status === 'demo' ? 'Pitch' : 'Test'} bis ${fmt.datum(i.test_ende)}` : i.kulanz_bis ? `Kulanz bis ${fmt.datum(i.kulanz_bis)}` : '–';
                return (
                  <tr>
                    <td><a href={`/instanzen/${i.id}`} class="zelle-titel">{firmaVon(l, i)}</a><span class="mono klein gedaempft block">{i.subdomain}</span></td>
                    <td><StatusMarke s={i.status} /></td>
                    <td><StufeMarke s={i.stufe} /><span class="mono klein gedaempft block nur-breit">{i.host}</span></td>
                    <td class="nur-breit">{PAKETE[i.paket]}</td>
                    <td class="nur-breit">{HERKUNFT[i.herkunft.art]}{i.herkunft.empfehlungscode ? <span class="mono klein gedaempft block">{i.herkunft.empfehlungscode}</span> : null}</td>
                    <td class="mono klein nur-breit">{frist}</td>
                    <td class="mono rechts nur-breit">{fmt.bytes(i.betrieb.speicher_bytes)}</td>
                    <td class="nur-breit"><span class={`health health--${i.betrieb.health}`}>{i.betrieb.health}</span>{!i.betrieb.backup_ok ? <span class="klein warn block">Backup fehlgeschlagen</span> : null}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </Seite>
  );
}

export function NeueInstanzSeite({ l, k, art, kundeId }: { l: Leitstand; k: SeitenKontext; art: 'kunde' | 'pitch'; kundeId: string | null }) {
  const kunden = l.kunden();
  const partner = l.partnerListe().filter((p) => p.aktiv);
  return (
    <Seite k={k} titel="Neue Instanz">
      <div class="umschalter" role="tablist" aria-label="Art der Instanz">
        <a role="tab" aria-selected={art === 'kunde' ? 'true' : 'false'} class={art === 'kunde' ? 'umschalter-teil ist-aktiv' : 'umschalter-teil'} href="/instanzen/neu">Für ein Konto</a>
        <a role="tab" aria-selected={art === 'pitch' ? 'true' : 'false'} class={art === 'pitch' ? 'umschalter-teil ist-aktiv' : 'umschalter-teil'} href="/instanzen/neu?art=pitch">Pitch / Demo</a>
      </div>

      {art === 'pitch' ? (
        <>
          <p class="still">Pitch-Instanzen laufen immer auf einem geteilten Host, haben keinen Kunden als Verantwortlichen, tragen Beispieldaten und werden nach Ablauf automatisch gelöscht. Übernimmt ein Interessent, werden die Beispieldaten vorher entfernt.</p>
          <div class="schnellwahl">
            {(Object.keys(BEISPIELE) as (keyof typeof BEISPIELE)[]).map((b) => (
              <form method="post" action="/instanzen/pitch" class="schnell">
                <Csrf k={k} />
                <input type="hidden" name="_idem" value={crypto.randomUUID()} />
                <input type="hidden" name="beispiel" value={b} />
                <p class="schnell-titel">{BEISPIELE[b].split(' (')[0]}</p>
                <p class="schnell-text">{BEISPIELE[b].split(' (')[1]?.replace(')', '')}</p>
                <div class="schnell-felder">
                  <Feld label="Für (optional)" name={`fuer-${b}`}><input id={`fuer-${b}`} name="fuer" type="text" maxlength={30} placeholder="z. B. dachdecker-meyer" /></Feld>
                  <Feld label="Laufzeit" name={`tage-${b}`}>
                    <select id={`tage-${b}`} name="tage">
                      {[1, 3, 7, 14, 30].map((t) => <option value={String(t)} selected={t === 7}>{t} {t === 1 ? 'Tag' : 'Tage'}</option>)}
                    </select>
                  </Feld>
                </div>
                <button class="knopf knopf--haupt" type="submit">Pitch starten</button>
              </form>
            ))}
          </div>
        </>
      ) : (
        <form method="post" action="/instanzen" class="formular">
          <Csrf k={k} />
          <input type="hidden" name="_idem" value={crypto.randomUUID()} />
          <fieldset class="gruppe">
            <legend>Konto</legend>
            <Feld label="Bestehendes Konto" name="kunde_id" hilfe="Leer lassen und unten ausfüllen, um ein neues Konto anzulegen.">
              <select id="kunde_id" name="kunde_id" aria-describedby="kunde_id-hilfe">
                <option value="">Neues Konto anlegen</option>
                {kunden.map((x) => <option value={x.id} selected={x.id === kundeId}>{x.firma} · {KONTO_TYPEN[x.typ]}</option>)}
              </select>
            </Feld>
            <div class="raster2" data-neu-konto>
              <Feld label="Firma oder Name" name="firma"><input id="firma" name="firma" type="text" maxlength={160} autocomplete="organization" /></Feld>
              <Feld label="Ansprechperson" name="ansprechpartner"><input id="ansprechpartner" name="ansprechpartner" type="text" maxlength={120} autocomplete="name" /></Feld>
              <Feld label="Mail" name="mail"><input id="mail" name="mail" type="email" maxlength={200} autocomplete="email" /></Feld>
              <Feld label="Kontotyp" name="typ">
                <select id="typ" name="typ">{(Object.keys(KONTO_TYPEN) as KontoTyp[]).filter((t) => t !== 'pitch').map((t) => <option value={t} selected={t === 'direkt'}>{KONTO_TYPEN[t]}</option>)}</select>
              </Feld>
              <Feld label="Quelle" name="quelle" hilfe="Woher kommt das Konto? Freitext, z. B. Messe Buchholz, LinkedIn-Post."><input id="quelle" name="quelle" type="text" maxlength={120} /></Feld>
              <Feld label="Empfehlungscode" name="empfehlungscode" hilfe="Nur speichern, wenn die Person der Zuordnung zugestimmt hat.">
                <select id="empfehlungscode" name="empfehlungscode"><option value="">kein Code</option>{partner.map((p) => <option value={p.code}>{p.code} · {p.name}</option>)}</select>
              </Feld>
              <label class="haken"><input type="checkbox" name="zuordnung_zustimmung" value="1" /> Zustimmung zur Zuordnung liegt vor</label>
            </div>
          </fieldset>
          <fieldset class="gruppe">
            <legend>Instanz</legend>
            <div class="raster2">
              <Feld label="Paket" name="paket"><select id="paket" name="paket">{Object.entries(PAKETE).map(([w, t]) => <option value={w} selected={w === 'betrieb'}>{t}</option>)}</select></Feld>
              <Feld label="Abrechnung" name="zahlung">
                <select id="zahlung" name="zahlung">
                  <option value="test" selected>Testphase ({FRISTEN.test_tage} Tage), dann Kauf</option>
                  <option value="rechnung">Sofort aktiv, Abrechnung per Rechnung</option>
                  <option value="frei">Sofort aktiv, kostenfrei (Verein, Schule, intern)</option>
                </select>
              </Feld>
              <Feld label="Betriebsstufe" name="stufe" hilfe="Testphase läuft immer geteilt. Eigene Maschine nur bei sofort aktiven Konten; Hochstufen geht später mit wenigen Klicks.">
                <select id="stufe" name="stufe" aria-describedby="stufe-hilfe"><option value="geteilt" selected>Geteilt (eigener Container auf HD-Host)</option><option value="eigen">Eigene Maschine (eigene Hetzner-Instanz)</option></select>
              </Feld>
              <Feld label="Region" name="region"><select id="region" name="region">{Object.entries(REGIONEN).map(([w, t]) => <option value={w}>{t}</option>)}</select></Feld>
              <Feld label="KI-Anbindung (Voreinstellung)" name="ki_vorlage" hilfe="Schlüssel trägt der Kunde selbst in seiner Instanz ein. Der Leitstand sieht ihn nie.">
                <select id="ki_vorlage" name="ki_vorlage" aria-describedby="ki_vorlage-hilfe">{Object.entries(KI_VORLAGEN).map(([w, t]) => <option value={w} selected={w === 'mistral'}>{t}</option>)}</select>
              </Feld>
              <Feld label="Subdomain (optional)" name="subdomain" hilfe={`Wird aus der Firma gebildet, wenn leer. Adresse: <name>.${l.domain}`}><input id="subdomain" name="subdomain" type="text" maxlength={40} pattern="[a-z0-9-]{3,40}" /></Feld>
              <Feld label="Admin-Mail der Instanz" name="admin_mail" hilfe="Bekommt den Einladungslink. Leer: Mail des Kontos."><input id="admin_mail" name="admin_mail" type="email" maxlength={200} /></Feld>
              <Feld label="Beispieldaten" name="beispiel"><select id="beispiel" name="beispiel"><option value="">keine</option>{Object.entries(BEISPIELE).map(([w, t]) => <option value={w}>{t}</option>)}</select></Feld>
            </div>
          </fieldset>
          <div class="reihe">
            <button class="knopf knopf--haupt" type="submit">Instanz anlegen</button>
            <span class="still klein">Derselbe Vorgang wie bei einem Mollie-Kauf: Subdomain, Schlüssel, Volume, Container, Health, Einladung.</span>
          </div>
        </form>
      )}
    </Seite>
  );
}

export function InstanzSeite({ l, k, i }: { l: Leitstand; k: SeitenKontext; i: Instanz }) {
  const kunde = i.kunde_id ? l.kunde(i.kunde_id) : null;
  const vorgaenge = l.vorgaenge({ instanz_id: i.id });
  const ereignisse = l.ereignisse({ instanz_id: i.id, limit: 30 });
  const jetzt = l.jetzt();
  const kannVerlaengern = ['test', 'test_abgelaufen', 'demo'].includes(i.status);
  const fehlerV = vorgaenge.find((v) => v.status === 'fehler' && v.art === 'instanz_anlegen');
  const tot = i.status === 'geloescht';
  return (
    <Seite k={k} titel={kunde?.firma ?? `Pitch ${i.subdomain}`} aktion={<StatusMarke s={i.status} />}>
      <p class="mono gedaempft unterzeile">{i.url} · {i.id}</p>
      <Gleis i={i} />

      <div class="zweispaltig zweispaltig--breit-links">
        <div class="spalte">
          <h2 class="abschnitt">Betriebsdaten</h2>
          <p class="still klein">Nur Zahlen. Inhalte, Titel, Dateinamen und Fragen der Instanz sind für den Leitstand nicht abrufbar.</p>
          <dl class="werte">
            <div><dt>Speicher</dt><dd class="mono">{fmt.bytes(i.betrieb.speicher_bytes)}</dd></div>
            <div><dt>Benutzer</dt><dd class="mono">{i.betrieb.benutzer}</dd></div>
            <div><dt>Letzte Anmeldung</dt><dd class="mono">{i.betrieb.letzte_anmeldung_tag ?? '–'}</dd></div>
            <div><dt>Version</dt><dd class="mono">{i.version}</dd></div>
            <div><dt>Health</dt><dd><span class={`health health--${i.betrieb.health}`}>{i.betrieb.health}</span></dd></div>
            <div><dt>Backup</dt><dd class="mono">{i.betrieb.backup_ok ? (i.betrieb.backup_letztes ? fmt.zeit(i.betrieb.backup_letztes) : 'ok') : 'fehlgeschlagen'}</dd></div>
            <div><dt>Stufe</dt><dd><StufeMarke s={i.stufe} /></dd></div>
            <div><dt>Host</dt><dd class="mono">{i.host}</dd></div>
            <div><dt>Paket</dt><dd>{PAKETE[i.paket]}</dd></div>
            <div><dt>Region</dt><dd>{REGIONEN[i.region]}</dd></div>
            <div><dt>KI-Vorlage</dt><dd>{KI_VORLAGEN[i.ki_vorlage]}</dd></div>
            <div><dt>KI-Weg</dt><dd class="mono">{i.ki.weg}</dd></div>
            <div><dt>KI diesen Monat</dt><dd class="mono">{fmt.euro(i.betrieb.ki_verbrauch_cent_monat)}{i.betrieb.ki_kontingent_cent_monat !== null ? ` / ${fmt.euro(i.betrieb.ki_kontingent_cent_monat)}` : ''}</dd></div>
            <div><dt>Modus</dt><dd class="mono">{i.betrieb.modus}</dd></div>
            <div><dt>OAuth-Zugänge</dt><dd class="mono">{i.betrieb.zugaenge_oauth}</dd></div>
            <div><dt>Gekündigt zum</dt><dd class="mono">{fmt.datum(i.kuendigung_zum)}</dd></div>
            <div><dt>Herkunft</dt><dd>{HERKUNFT[i.herkunft.art]}{i.herkunft.empfehlungscode ? ` · ${i.herkunft.empfehlungscode}` : ''}</dd></div>
            <div><dt>{i.status === 'demo' ? 'Pitch endet' : 'Testende'}</dt><dd class="mono">{fmt.datum(i.test_ende)}{i.test_ende ? ` (${fmt.tage(tageBis(jetzt, i.test_ende))})` : ''}</dd></div>
            <div><dt>Löschen am</dt><dd class="mono">{fmt.datum(i.loeschen_am)}</dd></div>
          </dl>

          <h2 class="abschnitt">Vorgänge</h2>
          {vorgaenge.length === 0 ? <p class="still">Keine.</p> : vorgaenge.map((v) => (
            <details class="vorgang" open={v.status !== 'fertig'}>
              <summary><span class="mono klein">{fmt.zeit(v.erstellt)}</span> <b>{v.art.replace(/_/g, ' ')}</b> <span class={`vstatus vstatus--${v.status}`}>{v.status}</span> <span class="mono klein gedaempft">{v.schritte.filter((s) => s.status === 'fertig' || s.status === 'uebersprungen').length}/{v.schritte.length}</span></summary>
              <Balken anteil={v.schritte.filter((s) => s.status === 'fertig' || s.status === 'uebersprungen').length / Math.max(1, v.schritte.length)} ampel={v.status === 'fehler' ? 'voll' : 'ok'} label={`Fortschritt ${v.art}`} />
              <ol class="schritte">
                {v.schritte.map((s) => <li class={`schritt schritt--${s.status}`}><span class="mono">{s.name}</span> <span class="klein gedaempft">{s.meldung ?? s.status}</span></li>)}
              </ol>
              {v.ergebnis && 'sha256' in v.ergebnis ? <p class="mono klein">sha256 {String(v.ergebnis.sha256)} · {fmt.bytes(Number(v.ergebnis.bytes))} · Link nur an den Instanz-Admin</p> : null}
            </details>
          ))}

          <h2 class="abschnitt">Protokoll dieser Instanz</h2>
          <ol class="protokoll">
            {ereignisse.map((e) => <li><span class="mono klein gedaempft">{fmt.zeit(e.am)}</span> <span class="mono klein">{e.wer}</span> {e.was.replace(/_/g, ' ')}{e.daten && 'grund' in e.daten ? `: ${String(e.daten.grund)}` : ''}{e.daten && 'von' in e.daten && 'nach' in e.daten ? ` (${String(e.daten.von)} → ${String(e.daten.nach)})` : ''}</li>)}
          </ol>
        </div>

        <aside class="spalte aktionen" aria-label="Aktionen">
          {tot ? <p class="still">Gelöscht. Beleg unter <a href="/protokoll?ansicht=loeschungen">Protokoll · Löschungen</a>.</p> : (
            <>
              {kunde ? <p class="klein">Konto: <a href={`/kunden/${kunde.id}`}>{kunde.firma}</a> · {KONTO_TYPEN[kunde.typ]}</p> : null}
              {fehlerV ? (
                <form method="post" action={`/vorgaenge/${fehlerV.id}/wiederholen`} class="aktion"><Csrf k={k} /><p class="aktion-titel">Anlage gescheitert</p><p class="klein">Fertige Schritte werden nicht wiederholt.</p><button class="knopf knopf--haupt" type="submit">Vorgang wiederholen</button></form>
              ) : null}
              {kannVerlaengern ? (
                <form method="post" action={`/instanzen/${i.id}/verlaengern`} class="aktion">
                  <Csrf k={k} />
                  <p class="aktion-titel">{i.status === 'demo' ? 'Pitch verlängern' : 'Testphase verlängern'}</p>
                  <div class="raster2">
                    <Feld label="Tage" name="tage"><select id="tage" name="tage">{[3, 7, 14, 30].map((t) => <option value={String(t)}>{t}</option>)}</select></Feld>
                    <Feld label="Grund" name="grund"><input id="grund" name="grund" type="text" required maxlength={200} placeholder="z. B. Urlaub GF" /></Feld>
                  </div>
                  <button class="knopf" type="submit">Verlängern</button>
                </form>
              ) : null}
              {i.status === 'demo' ? (
                <form method="post" action={`/instanzen/${i.id}/uebernehmen`} class="aktion">
                  <Csrf k={k} />
                  <p class="aktion-titel">Interessent übernimmt</p>
                  <p class="klein">Beispieldaten werden entfernt, dann startet eine normale Testphase von {FRISTEN.test_tage} Tagen.</p>
                  <Feld label="Konto" name="kunde_id_u"><select id="kunde_id_u" name="kunde_id" required>{l.kunden().map((x) => <option value={x.id}>{x.firma}</option>)}</select></Feld>
                  <button class="knopf" type="submit">Übernehmen</button>
                </form>
              ) : null}
              {['test', 'test_abgelaufen', 'zahlung_offen', 'nur_lesen'].includes(i.status) ? (
                <form method="post" action={`/instanzen/${i.id}/aktivieren`} class="aktion">
                  <Csrf k={k} />
                  <p class="aktion-titel">Kauf ohne Mollie</p>
                  <div class="raster2">
                    <Feld label="Abrechnung" name="zahlung_a"><select id="zahlung_a" name="zahlung"><option value="rechnung">Rechnung</option><option value="frei">kostenfrei</option></select></Feld>
                    <Feld label="Referenz" name="referenz"><input id="referenz" name="referenz" type="text" maxlength={60} placeholder="Angebotsnr." /></Feld>
                  </div>
                  <button class="knopf" type="submit">Aktivieren</button>
                </form>
              ) : null}
              {['aktiv', 'zahlung_offen', 'test', 'test_abgelaufen', 'nur_lesen', 'umzug_laeuft', 'umgezogen', 'pausiert', 'demo', 'loeschung_geplant'].includes(i.status) ? (
                <form method="post" action={`/instanzen/${i.id}/export`} class="aktion">
                  <Csrf k={k} />
                  <p class="aktion-titel">Export bereitstellen</p>
                  <p class="klein">Das Paket entsteht in der Instanz. Den Link bekommt nur deren Admin, nicht der Leitstand.</p>
                  <div class="reihe">
                    <select name="art" aria-label="Exportart"><option value="okf">Offenes Format (OKF)</option><option value="umzugspaket">Umzugspaket</option></select>
                    <button class="knopf" type="submit">Export anstoßen</button>
                  </div>
                </form>
              ) : null}
              {i.status === 'aktiv' ? (
                <form method="post" action={`/instanzen/${i.id}/stufe`} class="aktion aktion--betont">
                  <Csrf k={k} />
                  <input type="hidden" name="_idem" value={crypto.randomUUID()} />
                  <input type="hidden" name="nach" value={i.stufe === 'eigen' ? 'geteilt' : 'eigen'} />
                  <p class="aktion-titel">{i.stufe === 'eigen' ? 'Zurück auf geteilten Host' : 'Auf eigene Maschine hochstufen'}</p>
                  <p class="klein">Ablauf: Ziel bereitstellen, alte Instanz nur lesen, Paket übertragen, einspielen, Prüfsummen vergleichen, umschalten, alte anhalten. Bei Abweichung automatischer Rückbau. Die alte Instanz bleibt {FRISTEN.rueckfall_tage} Tage als Rückfallebene liegen. Adresse und Zugänge bleiben gleich.</p>
                  {l.geplanteWechsel().some((g) => g.instanz_id === i.id) ? <p class="klein">Vorgemerkt für {fmt.zeit(l.geplanteWechsel().find((g) => g.instanz_id === i.id)!.ab)}.</p> : null}
                  <div class="reihe">
                    <select name="zeitpunkt" aria-label="Zeitpunkt"><option value="nacht">Heute Nacht, 02:00</option><option value="sofort">Sofort (kurze Schreibpause)</option></select>
                    <button class="knopf knopf--haupt" type="submit">{i.stufe === 'eigen' ? 'Auf Geteilt wechseln' : 'Hochstufen'}</button>
                  </div>
                </form>
              ) : null}
              {['test', 'aktiv', 'zahlung_offen', 'nur_lesen'].includes(i.status) ? (
                <div class="aktion">
                  <p class="aktion-titel">Egress-Freigaben (eigener KI-Endpunkt)</p>
                  <p class="klein">Ausgehend nur über den Proxy. Voreinstellungen sind immer erlaubt; zusätzliche Hosts hier.</p>
                  {i.ki.egress_freigaben.length ? <ul class="protokoll">{i.ki.egress_freigaben.map((h) => <li><form method="post" action={`/instanzen/${i.id}/egress-entziehen`} class="reihe reihe--eng"><Csrf k={k} /><input type="hidden" name="host" value={h} /><span class="mono">{h}</span><button class="link-knopf" type="submit">entziehen</button></form></li>)}</ul> : <p class="still klein">Keine.</p>}
                  <form method="post" action={`/instanzen/${i.id}/egress`} class="raster2"><Csrf k={k} />
                    <Feld label="Host" name="egress_host"><input id="egress_host" name="host" class="mono" type="text" required maxlength={200} placeholder="ki.kanzlei-beispiel.de" /></Feld>
                    <Feld label="Grund" name="egress_grund"><input id="egress_grund" name="grund" type="text" required maxlength={200} /></Feld>
                    <div><button class="knopf knopf--klein" type="submit">Freigeben</button></div>
                  </form>
                </div>
              ) : null}
              {i.status === 'aktiv' ? (
                i.kuendigung_zum
                  ? <form method="post" action={`/instanzen/${i.id}/kuendigung-zuruecknehmen`} class="aktion"><Csrf k={k} /><p class="aktion-titel">Gekündigt zum {fmt.datum(i.kuendigung_zum)}</p><button class="knopf" type="submit">Kündigung zurücknehmen</button></form>
                  : <form method="post" action={`/instanzen/${i.id}/kuendigen`} class="aktion"><Csrf k={k} /><p class="aktion-titel">Kündigung erfassen</p><p class="klein">Zum Ende des laufenden Zeitraums, danach {l.schalter().lesefrist_tage} Tage nur lesen.</p><button class="knopf" type="submit">Kündigen</button></form>
              ) : null}
              {i.status === 'aktiv' ? (
                <form method="post" action={`/instanzen/${i.id}/umzug`} class="aktion">
                  <Csrf k={k} />
                  <p class="aktion-titel">Umzug in eigene Cloud oder lokal</p>
                  <div class="raster2">
                    <Feld label="Ziel" name="ziel"><select id="ziel" name="ziel"><option value="eigene_cloud">Eigene Cloud</option><option value="lokal">Lokal / Server im Haus</option></select></Feld>
                    <Feld label="Ziel-Adresse (optional)" name="ziel_url"><input id="ziel_url" name="ziel_url" type="url" maxlength={200} /></Feld>
                  </div>
                  <button class="knopf" type="submit">Umzug anstoßen</button>
                </form>
              ) : null}
              {i.status === 'umzug_laeuft' ? (
                <form method="post" action={`/instanzen/${i.id}/umzug/bestaetigen`} class="aktion">
                  <Csrf k={k} />
                  <p class="aktion-titel">Prüfbericht der neuen Instanz</p>
                  <Feld label="sha256 des Prüfberichts" name="pruefbericht_sha256" hilfe="Die neue Instanz zeigt ihn nach dem Import an."><input id="pruefbericht_sha256" name="pruefbericht_sha256" class="mono" type="text" required pattern="[a-f0-9]{64}" /></Feld>
                  <div class="reihe"><button class="knopf knopf--haupt" type="submit">Bestätigen</button></div>
                </form>
              ) : null}
              {i.status === 'pausiert' ? (
                <form method="post" action={`/instanzen/${i.id}/fortsetzen`} class="aktion"><Csrf k={k} /><p class="aktion-titel">Pausiert</p><button class="knopf" type="submit">Fortsetzen</button></form>
              ) : ['test', 'aktiv', 'demo', 'zahlung_offen'].includes(i.status) ? (
                <form method="post" action={`/instanzen/${i.id}/pausieren`} class="aktion">
                  <Csrf k={k} />
                  <p class="aktion-titel">Pausieren</p>
                  <div class="reihe"><input name="grund" type="text" required maxlength={200} aria-label="Grund" placeholder="Grund" /><button class="knopf" type="submit">Pausieren</button></div>
                </form>
              ) : null}
              {i.status === 'loeschung_geplant' ? (
                <form method="post" action={`/instanzen/${i.id}/loeschung-abbrechen`} class="aktion"><Csrf k={k} /><p class="aktion-titel">Löschung am {fmt.datum(i.loeschen_am)}</p><button class="knopf" type="submit">Löschung abbrechen</button></form>
              ) : (
                <form method="post" action={`/instanzen/${i.id}/loeschen`} class="aktion aktion--gefahr" data-bestaetigen={i.subdomain}>
                  <Csrf k={k} />
                  <p class="aktion-titel">Löschen</p>
                  <p class="klein">{i.status === 'demo' ? 'Pitch wird sofort gelöscht.' : i.status === 'umgezogen' ? `Frist ${FRISTEN.nach_umzug_bis_loeschung} Tage, bis dahin nur lesen.` : `Frist ${FRISTEN.nur_lesen_bis_loeschung} Tage, Kunde wird informiert und kann exportieren.`} Jede Löschung erzeugt einen Beleg.</p>
                  <Feld label={`Zum Bestätigen „${i.subdomain}“ eintippen`} name="bestaetigung"><input id="bestaetigung" name="bestaetigung" type="text" required autocomplete="off" class="mono" /></Feld>
                  <Feld label="Grund" name="grund_l"><input id="grund_l" name="grund" type="text" required maxlength={200} /></Feld>
                  {i.status !== 'demo' ? (
                    <>
                      <label class="haken"><input type="checkbox" name="sofort" value="1" /> Sofort, Kunde hat es in Textform verlangt</label>
                      <Feld label="Beleg (Datum, Mail-Betreff)" name="beleg"><input id="beleg" name="beleg" type="text" maxlength={200} /></Feld>
                    </>
                  ) : null}
                  <button class="knopf knopf--gefahr" type="submit" data-bestaetigen-knopf>Löschung {i.status === 'demo' ? 'ausführen' : 'planen'}</button>
                </form>
              )}
            </>
          )}
        </aside>
      </div>
    </Seite>
  );
}

// ---------------- Konten ----------------
export function KundenSeite({ l, k, suche, typ }: { l: Leitstand; k: SeitenKontext; suche: string; typ: KontoTyp | null }) {
  const liste = l.kunden({ suche, ...(typ ? { typ } : {}) });
  const alle = l.kunden();
  return (
    <Seite k={k} titel="Konten" aktion={<a class="knopf" href="/kunden/neu">Konto anlegen</a>}>
      <form method="get" action="/kunden" class="suchzeile" role="search">
        <label class="sr-only" for="q">Suchen</label>
        <input id="q" name="q" type="search" value={suche} placeholder="Firma, Person, Mail, Quelle, Code" />
        <button class="knopf" type="submit">Suchen</button>
      </form>
      <nav class="filter" aria-label="Nach Typ filtern">
        <a href="/kunden" class={!typ ? 'chip ist-aktiv' : 'chip'}>Alle <span class="mono">{alle.length}</span></a>
        {(Object.keys(KONTO_TYPEN) as KontoTyp[]).map((t) => {
          const n = alle.filter((x) => x.typ === t).length;
          return n ? <a href={`/kunden?typ=${t}`} class={typ === t ? 'chip ist-aktiv' : 'chip'}>{KONTO_TYPEN[t]} <span class="mono">{n}</span></a> : null;
        })}
      </nav>
      {liste.length === 0 ? <Leer titel="Keine Konten gefunden." text="Vom LinkedIn-Kontakt bis zum Systemhaus: jedes Konto bekommt einen Typ und eine Quelle." link={{ href: '/kunden/neu', text: 'Konto anlegen' }} /> : (
        <div class="tabelle-rahmen">
          <table class="tabelle">
            <thead><tr><th>Konto</th><th>Typ</th><th>Status</th><th class="nur-breit">Quelle</th><th class="nur-breit">Code</th><th class="rechts nur-breit">Instanzen</th></tr></thead>
            <tbody>
              {liste.map((x) => (
                <tr>
                  <td><a href={`/kunden/${x.id}`} class="zelle-titel">{x.firma}</a><span class="klein gedaempft block">{x.ansprechpartner}</span></td>
                  <td>{KONTO_TYPEN[x.typ]}</td>
                  <td>{KONTO_STATUS[x.status]}</td>
                  <td class="nur-breit klein">{x.quelle ?? '–'}</td>
                  <td class="nur-breit mono klein">{x.zuordnung?.code ?? '–'}</td>
                  <td class="nur-breit mono rechts">{l.instanzen({ kunde_id: x.id }).length}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Seite>
  );
}

function KontoFelder({ x, l }: { x?: Kunde; l: Leitstand }) {
  return (
    <div class="raster2">
      <Feld label="Firma oder Name" name="firma"><input id="firma" name="firma" type="text" required maxlength={160} value={x?.firma ?? ''} /></Feld>
      <Feld label="Ansprechperson" name="ansprechpartner"><input id="ansprechpartner" name="ansprechpartner" type="text" maxlength={120} value={x?.ansprechpartner ?? ''} /></Feld>
      <Feld label="Mail" name="mail"><input id="mail" name="mail" type="email" maxlength={200} value={x?.mail ?? ''} /></Feld>
      <Feld label="Telefon" name="telefon"><input id="telefon" name="telefon" type="tel" maxlength={40} value={x?.telefon ?? ''} /></Feld>
      <Feld label="Kontotyp" name="typ"><select id="typ" name="typ">{(Object.keys(KONTO_TYPEN) as KontoTyp[]).map((t) => <option value={t} selected={(x?.typ ?? 'direkt') === t}>{KONTO_TYPEN[t]}</option>)}</select></Feld>
      <Feld label="Status" name="status"><select id="status" name="status">{Object.entries(KONTO_STATUS).map(([w, t]) => <option value={w} selected={(x?.status ?? 'interessent') === w}>{t}</option>)}</select></Feld>
      <Feld label="Quelle" name="quelle"><input id="quelle" name="quelle" type="text" maxlength={120} value={x?.quelle ?? ''} /></Feld>
      <Feld label="Rechnungsweg" name="rechnungsweg"><select id="rechnungsweg" name="rechnungsweg">{[['mollie', 'Mollie'], ['rechnung', 'Rechnung'], ['keiner', 'keiner']].map(([w, t]) => <option value={w} selected={(x?.rechnungsweg ?? 'rechnung') === w}>{t}</option>)}</select></Feld>
      <Feld label="Kundennr. im Rechnungswerkzeug" name="rechnung_ref"><input id="rechnung_ref" name="rechnung_ref" type="text" maxlength={40} value={x?.rechnung_ref ?? ''} /></Feld>
      <Feld label="Empfehlungscode" name="empfehlungscode" hilfe="Wird nur mit Zustimmung gespeichert.">
        <select id="empfehlungscode" name="empfehlungscode"><option value="">kein Code</option>{l.partnerListe().map((p) => <option value={p.code} selected={x?.zuordnung?.code === p.code}>{p.code} · {p.name}</option>)}</select>
      </Feld>
      <label class="haken"><input type="checkbox" name="zuordnung_zustimmung" value="1" checked={!!x?.zuordnung} /> Zustimmung zur Zuordnung liegt vor</label>
      <label class="haken"><input type="checkbox" name="berufsgeheimnis" value="1" checked={!!x?.berufsgeheimnis} /> Berufsgeheimnisträger (§ 203 StGB): Managed erst mit S-12</label>
      <div class="feld feld--breit"><label for="notizen">Notizen</label><textarea id="notizen" name="notizen" rows={4} maxlength={4000}>{x?.notizen ?? ''}</textarea></div>
    </div>
  );
}

export function KontoNeuSeite({ l, k }: { l: Leitstand; k: SeitenKontext }) {
  return (
    <Seite k={k} titel="Konto anlegen">
      <form method="post" action="/kunden" class="formular"><Csrf k={k} /><KontoFelder l={l} /><div class="reihe"><button class="knopf knopf--haupt" type="submit">Anlegen</button></div></form>
    </Seite>
  );
}

export function KontoSeite({ l, k, x }: { l: Leitstand; k: SeitenKontext; x: Kunde }) {
  const inst = l.instanzen({ kunde_id: x.id, mitGeloeschten: true });
  const zahlungen = l.zahlungen().filter((z) => z.kunde_id === x.id);
  const rechnung = l.rechnungsUrl(x);
  return (
    <Seite k={k} titel={x.firma} aktion={<a class="knopf knopf--haupt" href={`/instanzen/neu?kunde=${x.id}`}>Instanz anlegen</a>}>
      <p class="unterzeile">{KONTO_TYPEN[x.typ]} · {KONTO_STATUS[x.status]} · seit {fmt.datum(x.erstellt)}{x.zuordnung ? ` · über ${x.zuordnung.code} (${x.zuordnung.weg}, Zustimmung ${fmt.datum(x.zuordnung.zustimmung_am)})` : ''}</p>
      <div class="zweispaltig zweispaltig--breit-links">
        <form method="post" action={`/kunden/${x.id}`} class="formular spalte"><Csrf k={k} /><KontoFelder x={x} l={l} /><div class="reihe"><button class="knopf knopf--haupt" type="submit">Speichern</button></div></form>
        <div class="spalte">
          <h2 class="abschnitt">Instanzen</h2>
          {inst.length === 0 ? <p class="still">Keine.</p> : <ul class="liste">{inst.map((i) => <li class="zeile"><div class="zeile-haupt"><a class="zeile-titel mono" href={`/instanzen/${i.id}`}>{i.subdomain}</a><StatusMarke s={i.status} /></div></li>)}</ul>}
          <h2 class="abschnitt">Abrechnung</h2>
          <p class="klein">{rechnung ? <a href={rechnung} rel="noopener">Rechnungen im Rechnungswerkzeug öffnen</a> : 'Rechnungen kommen aus dem Rechnungswerkzeug. Kundennummer eintragen, dann erscheint hier der Link.'}</p>
          {zahlungen.length ? (
            <table class="tabelle tabelle--knapp"><thead><tr><th>Datum</th><th>Status</th><th class="rechts">Betrag</th></tr></thead>
              <tbody>{zahlungen.map((z) => <tr><td class="mono">{fmt.datum(z.am)}</td><td><span class={`zstatus zstatus--${z.status}`}>{z.status}</span></td><td class="mono rechts">{fmt.euro(z.betrag_cent)}</td></tr>)}</tbody></table>
          ) : <p class="still">Keine Mollie-Zahlungen.</p>}
        </div>
      </div>
    </Seite>
  );
}

// ---------------- Partner ----------------
export function PartnerSeite({ l, k, basisUrl }: { l: Leitstand; k: SeitenKontext; basisUrl: string }) {
  const partner = l.partnerListe();
  const zeilen = l.auszahlungsliste();
  const gruppen = new Map<string, typeof zeilen>();
  for (const z of zeilen) { const s = `${z.partner}|${z.monat}`; gruppen.set(s, [...(gruppen.get(s) ?? []), z]); }
  return (
    <Seite k={k} titel="Partner und Empfehlungen">
      <p class="still">Zuordnung ohne Tracking-Cookies: Code im Checkout oder Link-Parameter <span class="mono">?code=</span>, gespeichert nur mit Zustimmung der Person. Auszahlungen machst du von Hand, hier wird nur vermerkt.</p>
      {partner.length === 0 ? <Leer titel="Noch kein Partner." text="Influencer, Systemhaus, Empfehler oder ein Kunde, der weiterempfiehlt." /> : (
        <div class="tabelle-rahmen">
          <table class="tabelle">
            <thead><tr><th>Code</th><th>Name</th><th class="nur-breit">Art</th><th class="rechts">Provision</th><th class="rechts nur-breit">Konten</th><th class="rechts nur-breit">Aktiv</th><th class="nur-breit">Link</th></tr></thead>
            <tbody>
              {partner.map((p) => { const z = l.partnerZahlen(p.code); return (
                <tr class={p.aktiv ? '' : 'ist-still'}>
                  <td class="mono">{p.code}</td><td>{p.name}{p.aktiv ? '' : ' (pausiert)'}</td><td class="nur-breit">{PARTNER_ARTEN[p.art]}</td>
                  <td class="mono rechts">{p.provision_prozent} % · {p.laufzeit_monate} M</td>
                  <td class="mono rechts nur-breit">{z.kunden}</td><td class="mono rechts nur-breit">{z.aktiv}</td>
                  <td class="mono klein nur-breit">{basisUrl}/?code={p.code}</td>
                </tr>
              ); })}
            </tbody>
          </table>
        </div>
      )}

      <h2 class="abschnitt" id="auszahlungen">Auszahlungsliste</h2>
      {!l.schalter().partner_provisionen ? <p class="still">Aus. CONTRACT v1.4 schließt Provisionen über Partnercodes aus (Abschnitt 17, G1 S-1). Codes zählen nur. Freischalten unter <a href="/schalter">Schalter</a>, wenn du das ausdrücklich willst.</p> : gruppen.size === 0 ? <p class="still">Noch keine bezahlten Umsätze mit Zuordnung.</p> : (
        <div class="tabelle-rahmen">
          <table class="tabelle">
            <thead><tr><th>Monat</th><th>Partner</th><th class="nur-breit">Konten</th><th class="rechts">Provision</th><th>Status</th></tr></thead>
            <tbody>
              {[...gruppen.entries()].map(([s, z]) => {
                const [code, monat] = s.split('|') as [string, string];
                const summe = z.reduce((a, b) => a + b.provision_cent, 0);
                const offen = z.some((x) => x.status === 'offen');
                return (
                  <tr>
                    <td class="mono">{monat}</td><td><span class="mono">{code}</span> <span class="klein gedaempft">{z[0]!.name}</span></td>
                    <td class="nur-breit klein">{[...new Set(z.map((x) => x.kunde))].join(', ')}</td>
                    <td class="mono rechts">{fmt.euro(summe)}</td>
                    <td>{offen ? (
                      <form method="post" action="/partner/auszahlung" class="reihe reihe--eng"><Csrf k={k} /><input type="hidden" name="code" value={code} /><input type="hidden" name="monat" value={monat} /><input name="vermerk" type="text" maxlength={80} placeholder="Überweisung am …" aria-label="Vermerk" /><button class="knopf knopf--klein" type="submit">Ausgezahlt</button></form>
                    ) : <span class="klein">ausgezahlt {fmt.datum(z[0]!.ausgezahlt_am)}</span>}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      <h2 class="abschnitt">Partner anlegen</h2>
      <form method="post" action="/partner" class="formular">
        <Csrf k={k} />
        <div class="raster3">
          <Feld label="Code" name="code" hilfe="A–Z, 0–9, Bindestrich"><input id="code" name="code" class="mono" type="text" required maxlength={32} placeholder="LINKEDIN-ANNA" /></Feld>
          <Feld label="Name" name="name"><input id="name" name="name" type="text" required maxlength={120} /></Feld>
          <Feld label="Art" name="art"><select id="art" name="art">{Object.entries(PARTNER_ARTEN).map(([w, t]) => <option value={w}>{t}</option>)}</select></Feld>
          <Feld label="Provision %" name="provision_prozent" hilfe="Nur wirksam mit Schalter Provisionen"><input id="provision_prozent" name="provision_prozent" type="number" min={0} max={50} step={1} value="0" /></Feld>
          <Feld label="Laufzeit Monate" name="laufzeit_monate" hilfe="Wie lange Zahlungen eines Kontos zählen"><input id="laufzeit_monate" name="laufzeit_monate" type="number" min={0} max={36} step={1} value="12" /></Feld>
          <Feld label="Mail" name="pmail"><input id="pmail" name="mail" type="email" maxlength={200} /></Feld>
        </div>
        <div class="feld"><label for="vereinbarung">Vereinbarung</label><input id="vereinbarung" name="vereinbarung" type="text" maxlength={300} placeholder="Absprache per Mail vom …" /></div>
        <div class="reihe"><button class="knopf knopf--haupt" type="submit">Partner anlegen</button></div>
      </form>
    </Seite>
  );
}

// ---------------- Abrechnung ----------------
export function AbrechnungSeite({ l, k }: { l: Leitstand; k: SeitenKontext }) {
  const abos = l.abos();
  const zahlungen = l.zahlungen();
  const kname = (id: string | null) => (id ? l.kunde(id).firma : '–');
  return (
    <Seite k={k} titel="Abrechnung">
      <p class="still">Nur lesend, gespiegelt aus Mollie über den Webhook. Rechnungen schreibt weiter das Rechnungswerkzeug; je Konto steht der Link auf der Kontoseite. Geld wird hier weder eingezogen noch erstattet.</p>
      <h2 class="abschnitt">Abos</h2>
      {abos.length === 0 ? <p class="still">Keine Abos.</p> : (
        <div class="tabelle-rahmen"><table class="tabelle"><thead><tr><th>Konto</th><th>Status</th><th class="rechts">Betrag</th><th class="nur-breit">Intervall</th><th class="nur-breit">Nächste</th></tr></thead>
          <tbody>{abos.map((a) => <tr><td>{kname(a.kunde_id)}</td><td><span class={`zstatus zstatus--${a.status}`}>{a.status}</span></td><td class="mono rechts">{fmt.euro(a.betrag_cent)}</td><td class="nur-breit">{a.intervall}</td><td class="mono nur-breit">{a.naechste ?? '–'}</td></tr>)}</tbody></table></div>
      )}
      <h2 class="abschnitt">Zahlungen</h2>
      {zahlungen.length === 0 ? <p class="still">Noch keine Zahlungen.</p> : (
        <div class="tabelle-rahmen"><table class="tabelle"><thead><tr><th>Datum</th><th>Konto</th><th>Status</th><th class="nur-breit">Art</th><th class="rechts">Betrag</th><th class="nur-breit">Mollie-ID</th></tr></thead>
          <tbody>{zahlungen.map((z) => <tr><td class="mono">{fmt.datum(z.am)}</td><td>{kname(z.kunde_id)}</td><td><span class={`zstatus zstatus--${z.status}`}>{z.status}</span></td><td class="nur-breit">{z.art}</td><td class="mono rechts">{fmt.euro(z.betrag_cent)}</td><td class="mono klein nur-breit">{z.id}</td></tr>)}</tbody></table></div>
      )}
    </Seite>
  );
}

// ---------------- Protokoll ----------------
export function ProtokollSeite({ l, k, ansicht }: { l: Leitstand; k: SeitenKontext; ansicht: 'ereignisse' | 'loeschungen' | 'post' }) {
  return (
    <Seite k={k} titel="Protokoll">
      <div class="umschalter" role="tablist" aria-label="Ansicht">
        {([['ereignisse', 'Alle Aktionen'], ['loeschungen', 'Löschbelege'], ['post', 'Postausgang']] as const).map(([w, t]) => (
          <a role="tab" aria-selected={ansicht === w ? 'true' : 'false'} class={ansicht === w ? 'umschalter-teil ist-aktiv' : 'umschalter-teil'} href={`/protokoll?ansicht=${w}`}>{t}</a>
        ))}
      </div>
      {ansicht === 'ereignisse' ? (
        <>
          <p class="still klein">Nur anhängbar. Die Datenbank verweigert Ändern und Löschen von Einträgen.</p>
          <div class="tabelle-rahmen"><table class="tabelle tabelle--knapp"><thead><tr><th>Zeit</th><th>Wer</th><th>Was</th><th class="nur-breit">Instanz</th><th class="nur-breit">Details</th></tr></thead>
            <tbody>{l.ereignisse({ limit: 300 }).map((e) => <tr><td class="mono klein">{fmt.zeit(e.am)}</td><td class="mono klein">{e.wer}</td><td>{e.was.replace(/_/g, ' ')}</td><td class="mono klein nur-breit">{e.instanz_id ? <a href={`/instanzen/${e.instanz_id}`}>{e.instanz_id}</a> : '–'}</td><td class="mono klein nur-breit details">{e.daten ? JSON.stringify(e.daten) : ''}</td></tr>)}</tbody></table></div>
        </>
      ) : ansicht === 'loeschungen' ? (
        l.loeschbelege().length === 0 ? <Leer titel="Keine Löschungen." text="Jede gelöschte Instanz hinterlässt hier einen Beleg ohne Inhalte: wann, wer, warum, was gelöscht wurde." /> : (
          <div class="tabelle-rahmen"><table class="tabelle"><thead><tr><th>Gelöscht</th><th>Instanz</th><th>Grund</th><th class="nur-breit">Von</th><th class="nur-breit">Nachweis</th></tr></thead>
            <tbody>{l.loeschbelege().map((b) => <tr><td class="mono klein">{fmt.zeit(b.geloescht_am)}</td><td><span class="mono">{b.subdomain}</span><span class="klein gedaempft block">{b.firma ?? 'Pitch'}</span></td><td>{b.grund}</td><td class="mono klein nur-breit">{b.von}</td><td class="klein nur-breit">{b.nachweis}</td></tr>)}</tbody></table></div>
        )
      ) : (
        <>
          <p class="still klein">Mails an Kunden (Testbeginn, Erinnerungen, Ankündigungen). Versand über den Mail-Adapter; ohne Adapter bleiben sie vorgemerkt.</p>
          <div class="tabelle-rahmen"><table class="tabelle tabelle--knapp"><thead><tr><th>Zeit</th><th>An</th><th>Betreff</th><th>Status</th></tr></thead>
            <tbody>{l.postausgang().map((p) => <tr><td class="mono klein">{fmt.zeit(p.am)}</td><td class="mono klein">{p.an}</td><td>{p.betreff}</td><td class="klein">{p.status}</td></tr>)}</tbody></table></div>
        </>
      )}
    </Seite>
  );
}

// ---------------- Anmeldung ----------------
export function AnmeldeSeite({ fehler, ersteinrichtung, nurPasskey = false }: { fehler?: string | null; ersteinrichtung: boolean; nurPasskey?: boolean }) {
  return (
    <html lang="de">
      <head>
        <meta charset="utf-8" /><meta name="viewport" content="width=device-width, initial-scale=1" /><meta name="robots" content="noindex, nofollow" />
        <title>{`Anmelden · Leitstand ${PRODUKTNAME}`}</title>
        <link rel="stylesheet" href="/_k/stil.css" />
        <script src="/_k/passkey.js" defer></script>
      </head>
      <body class="anmelde-body">
        <main class="anmeldung">
          <div class="zeichen"><span class="zeichen-quadrat" aria-hidden="true"></span><span class="zeichen-text"><b>Leitstand</b><span>{PRODUKTNAME} Managed</span></span></div>
          <h1>Anmelden</h1>
          {ersteinrichtung ? <p class="hinweis">Noch kein Admin. Auf dem Server anlegen: <span class="mono">kern-betrieb admin anlegen &lt;name&gt;</span></p> : null}
          {fehler ? <p class="hinweis hinweis--fehler" role="alert">{fehler}</p> : null}
          {!ersteinrichtung ? <button id="passkey-anmelden" class="knopf knopf--haupt knopf--voll" type="button">Mit Passkey anmelden</button> : null}
          <p id="passkey-fehler" class="hinweis hinweis--fehler" role="alert" hidden></p>
          {nurPasskey ? null : (
          <details class="rueckfall" open={ersteinrichtung || !!fehler}>
          <summary class="klein">Mit Passwort und Code aus der Authenticator-App</summary>
          <form method="post" action="/anmelden" class="formular">
            <Feld label="Name" name="name"><input id="name" name="name" type="text" required autocomplete="username" autocapitalize="none" /></Feld>
            <Feld label="Passwort" name="passwort"><input id="passwort" name="passwort" type="password" required autocomplete="current-password" /></Feld>
            <Feld label="Code aus der Authenticator-App" name="code"><input id="code" name="code" type="text" required inputmode="numeric" pattern="[0-9]{6}" maxlength={6} autocomplete="one-time-code" class="mono" /></Feld>
            <button class="knopf knopf--voll" type="submit">Anmelden</button>
          </form>
          </details>
          )}
          <p class="still klein">Die Konsole sieht Betriebsdaten der Instanzen, nie deren Inhalte.</p>
        </main>
      </body>
    </html>
  );
}

// ---------------- Hosts ----------------
export function HostsSeite({ l, k, hosts }: { l: Leitstand; k: SeitenKontext; hosts: HostMitLast[] }) {
  const geteilt = hosts.filter((x) => x.h.stufe === 'geteilt');
  const eigen = hosts.filter((x) => x.h.stufe === 'eigen' && x.h.aktiv);
  return (
    <Seite k={k} titel="Hosts und Auslastung">
      <p class="still">Geteilt: ein eigener Container mit eigenem Datenordner, eigener Datenbank und eigenem Schlüssel je Kunde auf einem gemeinsamen Host. Belegung zählt den Speicher-Anspruch des Pakets, nicht nur die heutige Größe; ab 70 % gelb, ab 85 % nimmt der Leitstand den Host aus der Platzwahl. Test, Demo und Pitch landen immer hier.</p>
      {geteilt.length === 0 ? <Leer titel="Kein geteilter Host." text="Ohne geteilten Host kann keine Testphase und kein Pitch starten." /> : (
        <div class="tabelle-rahmen">
          <table class="tabelle">
            <thead><tr><th>Host</th><th>Auslastung</th><th class="rechts">Container</th><th class="rechts nur-breit">RAM (Anspruch)</th><th class="rechts nur-breit">Speicher belegt / Anspruch / gesamt</th><th class="nur-breit">Region</th><th>Neue Container</th></tr></thead>
            <tbody>
              {geteilt.map(({ h, last }) => (
                <tr>
                  <td><span class="mono">{h.id}</span><span class="klein gedaempft block">{h.name}</span></td>
                  <td class="zelle-balken"><Balken anteil={last.anteil} ampel={last.ampel} label={`Auslastung ${h.id}`} /><span class="mono klein">{Math.round(last.anteil * 100)} %{last.quelle === 'geschaetzt' ? ' [Schätzung]' : ''}</span></td>
                  <td class="mono rechts">{last.container}/{h.kapazitaet.container_max}</td>
                  <td class="mono rechts nur-breit">{last.ram_belegt_mb}/{h.kapazitaet.ram_mb} MB</td>
                  <td class="mono rechts nur-breit">{fmt.bytes(last.speicher_belegt)} / {fmt.bytes(last.anspruch_bytes)} / {fmt.bytes(h.kapazitaet.speicher_bytes)}</td>
                  <td class="nur-breit">{REGIONEN[h.region]}</td>
                  <td>
                    <form method="post" action={`/hosts/${h.id}/aktiv`} class="reihe reihe--eng"><Csrf k={k} /><input type="hidden" name="aktiv" value={h.aktiv ? '0' : '1'} /><span class="klein">{h.aktiv ? 'nimmt an' : 'gesperrt'}</span><button class="knopf knopf--klein" type="submit">{h.aktiv ? 'Sperren' : 'Freigeben'}</button></form>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <h2 class="abschnitt">Eigene Maschinen <span class="zaehler mono">{eigen.length}</span></h2>
      {eigen.length === 0 ? <p class="still">Keine. Hochstufen auf der Seite einer aktiven Instanz.</p> : (
        <div class="tabelle-rahmen"><table class="tabelle tabelle--knapp"><thead><tr><th>Maschine</th><th>Instanz</th><th class="nur-breit">Region</th><th class="rechts">Speicher</th></tr></thead>
          <tbody>{eigen.map(({ h, last }) => <tr><td class="mono">{h.id}</td><td>{h.instanz_id ? <a href={`/instanzen/${h.instanz_id}`} class="mono">{l.instanz(h.instanz_id).subdomain}</a> : '–'}</td><td class="nur-breit">{REGIONEN[h.region]}</td><td class="mono rechts">{fmt.bytes(last.speicher_belegt)}</td></tr>)}</tbody></table></div>
      )}

      <h2 class="abschnitt">Geteilten Host anlegen</h2>
      <form method="post" action="/hosts" class="formular">
        <Csrf k={k} />
        <div class="raster3">
          <Feld label="ID" name="hid" hilfe="a–z, 0–9, Bindestrich"><input id="hid" name="id" class="mono" type="text" required pattern="[a-z0-9-]{3,40}" placeholder="geteilt-02" /></Feld>
          <Feld label="Bezeichnung" name="hname"><input id="hname" name="name" type="text" required maxlength={80} placeholder="Hetzner CX43 Nürnberg" /></Feld>
          <Feld label="Region" name="hregion"><select id="hregion" name="region">{Object.entries(REGIONEN).map(([w, t]) => <option value={w}>{t}</option>)}</select></Feld>
          <Feld label="Container höchstens" name="container_max"><input id="container_max" name="container_max" type="number" min={1} max={200} value="20" /></Feld>
          <Feld label="RAM für Container (MB)" name="ram_mb"><input id="ram_mb" name="ram_mb" type="number" min={512} max={262144} value="12288" /></Feld>
          <Feld label="Speicher für Daten (GB)" name="speicher_gb"><input id="speicher_gb" name="speicher_gb" type="number" min={10} max={20000} value="300" /></Feld>
        </div>
        <div class="reihe"><button class="knopf knopf--haupt" type="submit">Host anlegen</button><span class="klein still">Legt nur den Eintrag an. Die Maschine selbst entsteht über die Betriebsvorlage (O1), nicht aus der Konsole.</span></div>
      </form>
      <p class="klein still">Stufen: {Object.values(STUFEN).join(' · ')}</p>
    </Seite>
  );
}

// ---------------- Schalter ----------------
export function SchalterSeite({ l, k }: { l: Leitstand; k: SeitenKontext }) {
  const s = l.schalter();
  const haken = (n: keyof typeof s, hilfe?: string) => (
    <label class="haken schalter-zeile"><input type="checkbox" name={n} value="1" checked={s[n] === true} /> <span><span class="mono klein gedaempft">{SCHALTER_TEXT[n].nr}</span> {SCHALTER_TEXT[n].text}{hilfe ? <span class="klein gedaempft block">{hilfe}</span> : null}</span></label>
  );
  return (
    <Seite k={k} titel="Schalter">
      <p class="still">CONTRACT v1.4 Abschnitt 16: Fragen, die du noch nicht entschieden hast. Beide Wege sind gebaut, der Standard gilt bis zu deiner Antwort. Jede Änderung steht im Protokoll.</p>
      <form method="post" action="/schalter" class="formular">
        <Csrf k={k} />
        <fieldset class="gruppe"><legend>Selbstbedienung</legend>
          {haken('kauf_offen', 'Erst nach G1 Abschnitt 3 (Versicherung, AV-Vertrag, AGB, geprobte Abläufe) und S-7.')}
          {haken('tests_offen')}
          {haken('neue_tests_pausiert', 'Ehrlicher Hinweis auf der Website, keine Warteliste.')}
          {haken('test_ki', 'EU-Anbieter mit Tageskontingent; für Berufsgeheimnisträger immer aus.')}
          {haken('berufsgeheimnis_offen', 'Erst nach Verschwiegenheitsverpflichtung mit dem Hoster (V6).')}
        </fieldset>
        <fieldset class="gruppe"><legend>Werte</legend>
          <div class="raster3">
            <Feld label="S-2 Domain für Kundeninstanzen" name="managed_domain"><input id="managed_domain" name="managed_domain" class="mono" type="text" value={s.managed_domain ?? ''} placeholder="ohne: Managed startet nicht" /></Feld>
            <Feld label="S-3 Produktname" name="produkt_name"><input id="produkt_name" name="produkt_name" type="text" value={s.produkt_name} maxlength={40} /></Feld>
            <Feld label="S-11 Lesephase nach Testende (Tage)" name="lesefrist_tage"><input id="lesefrist_tage" name="lesefrist_tage" type="number" min={30} max={90} value={String(s.lesefrist_tage)} /></Feld>
            <Feld label="S-8 Zeitrahmen Managed (Stunden je Monat)" name="zeitrahmen_stunden_monat"><input id="zeitrahmen_stunden_monat" name="zeitrahmen_stunden_monat" type="number" min={0} max={80} value={String(s.zeitrahmen_stunden_monat)} /></Feld>
            <Feld label="S-7 Abgrenzung Arbeitgeberfeld (Vermerk)" name="abgrenzung_vermerk"><input id="abgrenzung_vermerk" name="abgrenzung_vermerk" type="text" maxlength={200} value={s.abgrenzung_vermerk ?? ''} /></Feld>
          </div>
        </fieldset>
        <fieldset class="gruppe"><legend>Sonstiges</legend>
          {haken('preise_oeffentlich', 'Wirkt auf der Website.')}
          {haken('rechnung_stehende_freigabe', 'Aus: Entwürfe, wöchentliche Sammelfreigabe.')}
          {haken('leitstand_oeffentlich', 'Nur Vermerk, kein Code.')}
          {haken('partner_provisionen', 'Nicht im Vertrag. Standard aus.')}
        </fieldset>
        <div class="reihe"><button class="knopf knopf--haupt" type="submit">Speichern</button></div>
      </form>
      <h2 class="abschnitt">S-5 Preise (Startwerte G1 N-2, {s.preise.freigegeben ? 'freigegeben' : 'nicht freigegeben'})</h2>
      <div class="tabelle-rahmen"><table class="tabelle tabelle--knapp"><thead><tr><th>Paket</th><th class="rechts">Geteilt</th><th class="rechts">Eigene Maschine</th></tr></thead>
        <tbody>{(['klein', 'betrieb', 'team'] as const).map((p) => <tr><td>{PAKETE[p]}</td><td class="mono rechts">{fmt.euro(s.preise.geteilt[p])}</td><td class="mono rechts">{fmt.euro(s.preise.geteilt[p] + s.preise.aufschlag_eigene_maschine)}</td></tr>)}</tbody></table></div>
      <p class="still klein">Je Monat [Schätzung]. Eigener KI-Schlüssel senkt um das KI-Kontingent. Ändern über <span class="mono">leitstand/preise</span> per API, noch nicht in der Konsole.</p>
    </Seite>
  );
}

// ---------------- Sicherheit ----------------
export function SicherheitSeite({ k, passkeys, nurPasskey }: { k: SeitenKontext; passkeys: { id: string; name: string; erstellt: string }[]; nurPasskey: boolean }) {
  return (
    <Seite k={k} titel="Sicherheit">
      <p class="still">Empfehlung: Passkey auf zwei Geräten (Telefon und Rechner), danach Passwort und TOTP nur noch als Rückfall oder mit <span class="mono">BETRIEB_NUR_PASSKEY=1</span> ganz abschalten. Die Konsole gehört zusätzlich hinter VPN oder SSH-Tunnel.</p>
      <h2 class="abschnitt">Passkeys <span class="zaehler mono">{passkeys.length}</span></h2>
      {passkeys.length === 0 ? <p class="still">Noch keiner. Bis dahin gilt Passwort plus TOTP.</p> : (
        <ul class="liste">{passkeys.map((p) => <li class="zeile"><div class="zeile-haupt"><span class="zeile-titel">{p.name}</span><span class="mono klein gedaempft">seit {fmt.datum(p.erstellt)}</span></div>
          <form method="post" action={`/sicherheit/passkey/${encodeURIComponent(p.id)}/entfernen`}><Csrf k={k} /><button class="link-knopf" type="submit">Entfernen</button></form></li>)}</ul>
      )}
      <div class="formular">
        <Feld label="Bezeichnung" name="passkey-name"><input id="passkey-name" type="text" maxlength={60} placeholder="z. B. iPhone, MacBook" /></Feld>
        <div class="reihe"><button id="passkey-neu" class="knopf knopf--haupt" type="button">Passkey hinzufügen</button></div>
        <p id="passkey-fehler" class="hinweis hinweis--fehler" role="alert" hidden></p>
      </div>
      <p class="still klein">Passwort und TOTP: {nurPasskey ? 'abgeschaltet' : 'aktiv als Rückfallweg'}.</p>
    </Seite>
  );
}
