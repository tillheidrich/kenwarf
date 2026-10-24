// Passkey-Anmeldung und -Registrierung (WebAuthn). Ohne Bibliothek: nur Umwandlung base64url <-> ArrayBuffer.
const b64 = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const bin = (s) => { const p = s.replace(/-/g, '+').replace(/_/g, '/'); const r = atob(p + '==='.slice((p.length + 3) % 4)); return Uint8Array.from(r, (c) => c.charCodeAt(0)).buffer; };
const csrf = () => document.querySelector('meta[name="leitstand-csrf"]')?.getAttribute('content') ?? '';
const post = async (url, body) => {
  const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', 'x-leitstand-csrf': csrf() }, body: JSON.stringify(body ?? {}) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.fehler ?? `Fehler ${r.status}`);
  return j;
};
const meldung = (el, text) => { if (el) { el.textContent = text; el.hidden = false; } };

document.addEventListener('DOMContentLoaded', () => {
  const anmelden = document.getElementById('passkey-anmelden');
  if (anmelden) {
    if (!window.PublicKeyCredential) anmelden.hidden = true;
    anmelden.addEventListener('click', async () => {
      const fehler = document.getElementById('passkey-fehler');
      try {
        const { schluessel, optionen } = await post('/anmelden/passkey/optionen');
        const cred = await navigator.credentials.get({ publicKey: { ...optionen, challenge: bin(optionen.challenge), allowCredentials: (optionen.allowCredentials ?? []).map((c) => ({ ...c, id: bin(c.id) })) } });
        const r = cred.response;
        const antwort = { id: cred.id, rawId: b64(cred.rawId), type: cred.type, clientExtensionResults: cred.getClientExtensionResults(), authenticatorAttachment: cred.authenticatorAttachment ?? undefined,
          response: { clientDataJSON: b64(r.clientDataJSON), authenticatorData: b64(r.authenticatorData), signature: b64(r.signature), userHandle: r.userHandle ? b64(r.userHandle) : undefined } };
        const j = await post('/anmelden/passkey', { schluessel, antwort });
        location.href = j.weiter ?? '/heute';
      } catch (e) { meldung(fehler, `Passkey-Anmeldung fehlgeschlagen: ${e.message}`); }
    });
  }
  const neu = document.getElementById('passkey-neu');
  if (neu) {
    neu.addEventListener('click', async () => {
      const fehler = document.getElementById('passkey-fehler');
      try {
        const { schluessel, optionen } = await post('/sicherheit/passkey/optionen');
        const cred = await navigator.credentials.create({ publicKey: { ...optionen, challenge: bin(optionen.challenge), user: { ...optionen.user, id: bin(optionen.user.id) }, excludeCredentials: (optionen.excludeCredentials ?? []).map((c) => ({ ...c, id: bin(c.id) })) } });
        const r = cred.response;
        const antwort = { id: cred.id, rawId: b64(cred.rawId), type: cred.type, clientExtensionResults: cred.getClientExtensionResults(), authenticatorAttachment: cred.authenticatorAttachment ?? undefined,
          response: { clientDataJSON: b64(r.clientDataJSON), attestationObject: b64(r.attestationObject), transports: r.getTransports ? r.getTransports() : [] } };
        await post('/sicherheit/passkey', { schluessel, antwort, name: document.getElementById('passkey-name')?.value ?? 'Passkey' });
        location.href = '/sicherheit?meldung=' + encodeURIComponent('Passkey gespeichert.');
      } catch (e) { meldung(fehler, `Passkey nicht gespeichert: ${e.message}`); }
    });
  }
});
