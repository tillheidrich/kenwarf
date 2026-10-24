/**
 * Mollie: nur lesend. Der Webhook bringt nur `id=tr_…`; der Leitstand holt die Zahlung selbst über die API
 * (Mollie signiert Webhooks nicht, der Abruf ist die Prüfung). Rechnungen kommen weiter aus dem vorhandenen
 * Rechnungswerkzeug, die Konsole zeigt nur den Link.
 */
export interface MollieZahlung {
  id: string;
  status: 'open' | 'pending' | 'authorized' | 'paid' | 'failed' | 'canceled' | 'expired';
  amount: { value: string; currency: string };
  sequenceType?: 'first' | 'recurring' | 'oneoff';
  customerId?: string;
  subscriptionId?: string;
  createdAt: string;
  paidAt?: string;
  metadata?: Record<string, unknown> | null;
}
export interface MollieAbo { id: string; status: 'pending' | 'active' | 'canceled' | 'suspended' | 'completed'; amount: { value: string; currency: string }; interval: string; nextPaymentDate?: string; customerId: string }

export interface NeueZahlung { betrag_cent: number; beschreibung: string; redirectUrl: string; webhookUrl: string; metadata: Record<string, unknown>; sequenceType: 'first' | 'oneoff'; customerId?: string }

export interface MollieClient {
  holeZahlung(id: string): Promise<MollieZahlung>;
  holeAbo(customerId: string, aboId: string): Promise<MollieAbo>;
  /** Checkout für den Kauf aus der Instanz (v1.4 3.5). Das Abo legt der Leitstand nach bezahlter Erstzahlung an (Fahrplan: Subscriptions-API). */
  erstelleZahlung?(z: NeueZahlung): Promise<{ id: string; checkoutUrl: string }>;
}

export class MollieHttp implements MollieClient {
  constructor(private apiKey: string, private basis = 'https://api.mollie.com/v2') {}
  private async get<T>(pfad: string): Promise<T> {
    const r = await fetch(`${this.basis}${pfad}`, { headers: { authorization: `Bearer ${this.apiKey}`, accept: 'application/json' } });
    if (!r.ok) throw new Error(`Mollie ${r.status} bei ${pfad.split('/').slice(0, 2).join('/')}`);
    return (await r.json()) as T;
  }
  holeZahlung(id: string) {
    if (!/^tr_[A-Za-z0-9]{4,40}$/.test(id)) throw new Error('ungültige Zahlungs-ID');
    return this.get<MollieZahlung>(`/payments/${id}`);
  }
  async erstelleZahlung(z: NeueZahlung) {
    const r = await fetch(`${this.basis}/payments`, {
      method: 'POST',
      headers: { authorization: `Bearer ${this.apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({ amount: { currency: 'EUR', value: (z.betrag_cent / 100).toFixed(2) }, description: z.beschreibung, redirectUrl: z.redirectUrl, webhookUrl: z.webhookUrl, metadata: z.metadata, sequenceType: z.sequenceType, ...(z.customerId ? { customerId: z.customerId } : {}) }),
    });
    if (!r.ok) throw new Error(`Mollie ${r.status} beim Anlegen der Zahlung`);
    const j = (await r.json()) as { id: string; _links: { checkout: { href: string } } };
    return { id: j.id, checkoutUrl: j._links.checkout.href };
  }
  holeAbo(customerId: string, aboId: string) {
    if (!/^cst_[A-Za-z0-9]+$/.test(customerId) || !/^sub_[A-Za-z0-9]+$/.test(aboId)) throw new Error('ungültige Abo-ID');
    return this.get<MollieAbo>(`/customers/${customerId}/subscriptions/${aboId}`);
  }
}

/** Für Tests und Vorführung: Zahlungen und Abos werden vorab hinterlegt. */
export class MollieFake implements MollieClient {
  zahlungen = new Map<string, MollieZahlung>();
  abos = new Map<string, MollieAbo>();
  abrufe = 0;
  angelegt: NeueZahlung[] = [];
  async erstelleZahlung(z: NeueZahlung) {
    const id = `tr_fake${String(this.angelegt.length + 1).padStart(6, '0')}`;
    this.angelegt.push(z);
    this.zahlungen.set(id, { id, status: 'open', amount: { value: (z.betrag_cent / 100).toFixed(2), currency: 'EUR' }, sequenceType: z.sequenceType, createdAt: new Date().toISOString(), metadata: z.metadata, ...(z.customerId ? { customerId: z.customerId } : {}) });
    return { id, checkoutUrl: `https://www.mollie.com/checkout/test-mode?id=${id}` };
  }
  async holeZahlung(id: string) {
    this.abrufe++;
    const z = this.zahlungen.get(id);
    if (!z) throw new Error('Mollie 404');
    return structuredClone(z);
  }
  async holeAbo(_c: string, id: string) {
    const a = this.abos.get(id);
    if (!a) throw new Error('Mollie 404');
    return structuredClone(a);
  }
}

export function centAus(v: { value: string }): number {
  const [e, n = '0'] = v.value.split('.');
  return Number(e) * 100 + Number((n + '00').slice(0, 2));
}
