// Antwortformen des echten Servers (S2, 24.10.2026, mitgeschnitten gegen `kern serve`) gegen die Typen der Oberfläche.
import { describe, expect, it } from 'vitest';
import { alsDatenweg, alsEinstellungen, alsUser } from './http';

describe('alsUser', () => {
  const u = { id: 'admin', name: 'admin', rollen: ['admin'], teams: [] };
  it('liest { benutzer } und behält die Felder daneben', () => {
    const r = alsUser({ benutzer: u, mussPasswortAendern: true, modus: 'normal', produkt: { name: 'Kern' } });
    expect(r.name).toBe('admin');
    expect(r.rollen).toEqual(['admin']);
    expect(r.mussPasswortAendern).toBe(true);
    expect(r.produkt?.name).toBe('Kern');
    expect('benutzer' in r).toBe(false);
  });
  it('liest die Form des Servers: Felder oben plus benutzer', () => {
    const r = alsUser({ ...u, benutzer: u, modus: 'nur_lesen', einrichtung_offen: true });
    expect(r.id).toBe('admin');
    expect(r.modus).toBe('nur_lesen');
    expect(r.einrichtung_offen).toBe(true);
  });
  it('liest { user }, { ich } und User direkt', () => {
    expect(alsUser({ user: u }).name).toBe('admin');
    expect(alsUser({ ich: u }).name).toBe('admin');
    expect(alsUser(u).name).toBe('admin');
  });
});

describe('alsDatenweg', () => {
  it('macht chat.* flach und erkennt mock als lokal', () => {
    const d = alsDatenweg({ chat: { anbieter: 'mock', endpunkt: null, region: 'lokal (kein Netz)', modell: null }, daten: ['x'], hinweis: 'h', apps: [] });
    expect(d.lokal).toBe(true);
    expect(d.region).toBe('lokal (kein Netz)');
    expect(d.endpunkt).toBeNull();
    expect(d.daten).toEqual(['x']);
  });
  it('externer Anbieter ist nicht lokal', () => {
    const d = alsDatenweg({ chat: { anbieter: 'openai', endpunkt: 'https://api.mistral.ai/v1', region: 'eu', modell: 'mistral-small-latest' }, daten: [] });
    expect(d.lokal).toBe(false);
    expect(d.anbieter).toBe('openai');
  });
  it('lässt die flache Form unverändert', () => {
    const flach = { art: 'mock', anbieter: 'mock', endpunkt: null, region: null, lokal: true, daten: [] };
    expect(alsDatenweg(flach)).toEqual(flach);
  });
});

describe('alsEinstellungen', () => {
  it('übersetzt apiKeyGesetzt in hatSchluessel', () => {
    const e = alsEinstellungen({ betrieb: 'B', sprache: 'de', teams: [], provider: { art: 'openai', apiKeyGesetzt: true } });
    expect(e.provider.hatSchluessel).toBe(true);
  });
});
