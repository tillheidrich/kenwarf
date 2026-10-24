import type { KernApi } from './types';
import { httpApi } from './http';

export const MOCK = import.meta.env.VITE_KERN_MOCK === '1';

let aktiv: KernApi = httpApi;

/** Wählt beim Start den Mock (VITE_KERN_MOCK=1) oder die echte REST-API. Der Mock fällt im normalen Build weg. */
export async function starteApi(): Promise<KernApi> {
  if (MOCK) {
    const m = await import('../mock/api');
    aktiv = m.mockApi;
  }
  return aktiv;
}

export const api: KernApi = new Proxy({} as KernApi, {
  get(_z, name: keyof KernApi) {
    return aktiv[name];
  },
});
