import { oeffneDb } from '../src/db.js';
import { Leitstand } from '../src/leitstand.js';
import { DummyBereitsteller } from '../src/bereitsteller/dummy.js';
import { MollieFake } from '../src/mollie.js';
import type { Bereitsteller } from '../src/bereitsteller/typ.js';
import type { Schalter } from '../src/schalter.js';

export const TAG = 86_400_000;

export function aufbau(opt: { bereitsteller?: Bereitsteller; container_max?: number; schalter?: Partial<Schalter> } = {}) {
  const uhr = { t: Date.parse('2026-10-01T08:00:00.000Z') };
  const db = oeffneDb(':memory:');
  const b = (opt.bereitsteller ?? new DummyBereitsteller()) as DummyBereitsteller;
  const m = new MollieFake();
  const l = new Leitstand({
    db, bereitsteller: b, mollie: m, jetzt: () => new Date(uhr.t), domain: 'kern.example', oeffentlicheUrl: 'https://leitstand.example',
    schalter: { tests_offen: true, kauf_offen: true, ...opt.schalter },
    geteilteHosts: [{ id: 'geteilt-01', name: 'Test-Host', region: 'de-nbg', aktiv: true, kapazitaet: { container_max: opt.container_max ?? 20, ram_mb: 16384, speicher_bytes: 2000 * 1024 ** 3 } }],
  });
  const vor = (tage: number) => { uhr.t += tage * TAG; };
  return { uhr, db, b, m, l, vor };
}

export function konto(l: Leitstand, firma = 'Dachdeckerei Lühmann', mail = 'jan@luehmann.example') {
  return l.kundeAnlegen({ firma, ansprechpartner: 'Jan Lühmann', mail, typ: 'direkt', rechnungsweg: 'rechnung' }, 'till');
}
