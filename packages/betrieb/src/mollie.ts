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

export interface NeueZahlung { betrag_cent: number; beschreibung: string; redirectUrl?: string; webhookUrl: string; metadata: Record<string, unknown>; sequenceType: 'first' | 'oneoff' | 'recurring'; customerId?: string; mandateId?: string }

/** Abo nach bezahlter Erstzahlung (Mollie Subscriptions API, docs.mollie.com/reference/create-subscription). */
export interface NeuesAbo { betrag_cent: number; intervall: '1 month' | '12 months'; beschreibung: string; startDate: string; webhookUrl: string; metadata: Record<string, unknown>; mandateId?: string }
export interface MollieMandat { id: string; status: 'valid' | 'pending' | 'invalid'; method: string }

export interface MollieClient {
  holeZahlung(id: string): Promise<MollieZahlung>;
  holeAbo(customerId: string, aboId: string): Promise<MollieAbo>;
  /** Checkout für den Kauf aus der Instanz (v1.4 3.5). Das Abo legt der Leitstand nach bezahlter Erstzahlung an (Fahrplan: Subscriptions-API). */
  erstelleZahlung?(z: NeueZahlung): Promise<{ id: string; checkoutUrl: string | null }>;
  /** POST /v2/customers/{customerId}/subscriptions */
  erstelleAbo?(customerId: string, a: NeuesAbo): Promise<MollieAbo>;
  /** PATCH /v2/customers/{customerId}/subscriptions/{id}: Betrag gilt für künftige Zahlungen. */
  aendereAbo?(customerId: string, aboId: string, p: { betrag_cent?: number; beschreibung?: string; metadata?: Record<string, unknown> }): Promise<MollieAbo>;
  /** DELETE /v2/customers/{customerId}/subscriptions/{id} */
  kuendigeAbo?(customerId: string, aboId: string): Promise<MollieAbo>;
  /** GET /v2/customers/{customerId}/mandates */
  mandate?(customerId: string): Promise<MollieMandat[]>;
  /** POST /v2/payments/{paymentId}/refunds */
  erstatte?(zahlungId: string, betrag_cent: number, beschreibung: string): Promise<{ id: string }>;
}

const eur = (cent: number) => ({ currency: 'EUR', value: (cent / 100).toFixed(2) });
const ID_KUNDE = /^cst_[A-Za-z0-9]+$/, ID_ABO = /^sub_[A-Za-z0-9]+$/, ID_ZAHLUNG = /^tr_[A-Za-z0-9]{4,40}$/;

export class MollieHttp implements MollieClient {
  constructor(private apiKey: string, private basis = 'https://api.mollie.com/v2', private f: typeof fetch = fetch) {
    if (!/^(live|test)_[A-Za-z0-9]{20,}$/.test(apiKey)) throw new Error('Mollie-Schlüssel hat nicht die Form live_… oder test_…');
  }
  private async rufe<T>(methode: string, pfad: string, body?: unknown, idempotenz?: string): Promise<T> {
    const r = await this.f(`${this.basis}${pfad}`, { method: methode, headers: { authorization: `Bearer ${this.apiKey}`, accept: 'application/json', ...(body ? { 'content-type': 'application/json' } : {}), ...(idempotenz ? { 'idempotency-key': idempotenz } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(20_000) });
    if (!r.ok) {
      const j = (await r.json().catch(() => ({}))) as { detail?: string };
      throw new Error(`Mollie ${r.status} bei ${methode} ${pfad.split('/').slice(0, 2).join('/')}${j.detail ? `: ${String(j.detail).slice(0, 160)}` : ''}`);
    }
    return (await r.json()) as T;
  }
  private get<T>(pfad: string) { return this.rufe<T>('GET', pfad); }
  async holeZahlung(id: string) {
    if (!/^tr_[A-Za-z0-9]{4,40}$/.test(id)) throw new Error('ungültige Zahlungs-ID');
    return this.get<MollieZahlung>(`/payments/${id}`);
  }
  async erstelleZahlung(z: NeueZahlung) {
    if (z.sequenceType === 'recurring' && (!z.customerId || !z.mandateId)) throw new Error('Wiederkehrende Zahlung braucht customerId und mandateId');
    const j = await this.rufe<{ id: string; _links: { checkout?: { href: string } } }>('POST', '/payments', {
      amount: eur(z.betrag_cent), description: z.beschreibung, ...(z.redirectUrl ? { redirectUrl: z.redirectUrl } : {}), webhookUrl: z.webhookUrl, metadata: z.metadata, sequenceType: z.sequenceType,
      ...(z.customerId ? { customerId: z.customerId } : {}), ...(z.mandateId ? { mandateId: z.mandateId } : {}),
    }, typeof z.metadata.idempotenz === 'string' ? z.metadata.idempotenz : undefined);
    return { id: j.id, checkoutUrl: j._links.checkout?.href ?? null };
  }
  async erstelleAbo(customerId: string, a: NeuesAbo) {
    if (!ID_KUNDE.test(customerId)) throw new Error('ungültige Kunden-ID');
    return this.rufe<MollieAbo>('POST', `/customers/${customerId}/subscriptions`, { amount: eur(a.betrag_cent), interval: a.intervall, description: a.beschreibung, startDate: a.startDate, webhookUrl: a.webhookUrl, metadata: a.metadata, ...(a.mandateId ? { mandateId: a.mandateId } : {}) });
  }
  async aendereAbo(customerId: string, aboId: string, p: { betrag_cent?: number; beschreibung?: string; metadata?: Record<string, unknown> }) {
    if (!ID_KUNDE.test(customerId) || !ID_ABO.test(aboId)) throw new Error('ungültige Abo-ID');
    return this.rufe<MollieAbo>('PATCH', `/customers/${customerId}/subscriptions/${aboId}`, { ...(p.betrag_cent !== undefined ? { amount: eur(p.betrag_cent) } : {}), ...(p.beschreibung ? { description: p.beschreibung } : {}), ...(p.metadata ? { metadata: p.metadata } : {}) });
  }
  async kuendigeAbo(customerId: string, aboId: string) {
    if (!ID_KUNDE.test(customerId) || !ID_ABO.test(aboId)) throw new Error('ungültige Abo-ID');
    return this.rufe<MollieAbo>('DELETE', `/customers/${customerId}/subscriptions/${aboId}`);
  }
  async mandate(customerId: string) {
    if (!ID_KUNDE.test(customerId)) throw new Error('ungültige Kunden-ID');
    const j = await this.get<{ _embedded?: { mandates?: MollieMandat[] } }>(`/customers/${customerId}/mandates`);
    return j._embedded?.mandates ?? [];
  }
  async erstatte(zahlungId: string, betrag_cent: number, beschreibung: string) {
    if (!ID_ZAHLUNG.test(zahlungId)) throw new Error('ungültige Zahlungs-ID');
    return this.rufe<{ id: string }>('POST', `/payments/${zahlungId}/refunds`, { amount: eur(betrag_cent), description: beschreibung });
  }
  async holeAbo(customerId: string, aboId: string) {
    if (!ID_KUNDE.test(customerId) || !ID_ABO.test(aboId)) throw new Error('ungültige Abo-ID');
    return this.get<MollieAbo>(`/customers/${customerId}/subscriptions/${aboId}`);
  }
}

/** Für Tests und Vorführung: Zahlungen und Abos werden vorab hinterlegt. */
export class MollieFake implements MollieClient {
  zahlungen = new Map<string, MollieZahlung>();
  abos = new Map<string, MollieAbo>();
  abrufe = 0;
  angelegt: NeueZahlung[] = [];
  mandateListe = new Map<string, MollieMandat[]>();
  erstattungen: { zahlung: string; betrag_cent: number; beschreibung: string }[] = [];
  aboAufrufe: string[] = [];
  async erstelleZahlung(z: NeueZahlung) {
    const id = `tr_fake${String(this.angelegt.length + 1).padStart(6, '0')}`;
    this.angelegt.push(z);
    // Wiederkehrende Zahlungen laufen ohne Checkout im Hintergrund (Mollie „Recurring payments“)
    this.zahlungen.set(id, { id, status: z.sequenceType === 'recurring' ? 'pending' : 'open', amount: eur(z.betrag_cent), sequenceType: z.sequenceType, createdAt: new Date().toISOString(), metadata: z.metadata, ...(z.customerId ? { customerId: z.customerId } : {}) });
    return { id, checkoutUrl: z.sequenceType === 'recurring' ? null : `https://www.mollie.com/checkout/test-mode?id=${id}` };
  }
  async erstelleAbo(customerId: string, a: NeuesAbo) {
    const id = `sub_fake${String(this.abos.size + 1).padStart(4, '0')}`;
    this.aboAufrufe.push(`anlegen:${customerId}:${a.betrag_cent}:${a.intervall}:${a.startDate}`);
    const abo: MollieAbo = { id, status: 'active', amount: eur(a.betrag_cent), interval: a.intervall, nextPaymentDate: a.startDate, customerId };
    this.abos.set(id, abo);
    return structuredClone(abo);
  }
  async aendereAbo(customerId: string, aboId: string, p: { betrag_cent?: number }) {
    const a = this.abos.get(aboId);
    if (!a || a.customerId !== customerId) throw new Error('Mollie 404');
    if (a.status === 'canceled') throw new Error('Mollie 422: canceled subscriptions cannot be updated');
    this.aboAufrufe.push(`aendern:${aboId}:${p.betrag_cent ?? '-'}`);
    if (p.betrag_cent !== undefined) a.amount = eur(p.betrag_cent);
    return structuredClone(a);
  }
  async kuendigeAbo(customerId: string, aboId: string) {
    const a = this.abos.get(aboId);
    if (!a || a.customerId !== customerId) throw new Error('Mollie 404');
    this.aboAufrufe.push(`kuendigen:${aboId}`);
    a.status = 'canceled';
    return structuredClone(a);
  }
  async mandate(customerId: string) { return structuredClone(this.mandateListe.get(customerId) ?? [{ id: `mdt_${customerId.slice(4)}`, status: 'valid' as const, method: 'directdebit' }]); }
  async erstatte(zahlungId: string, betrag_cent: number, beschreibung: string) { this.erstattungen.push({ zahlung: zahlungId, betrag_cent, beschreibung }); return { id: `re_fake${this.erstattungen.length}` }; }
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
