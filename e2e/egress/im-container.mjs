// Läuft IN einem Instanz-Container (docker exec -i ... node --input-type=module - < im-container.mjs).
// Prüft die Netzsperre von innen. Eingaben über Umgebung:
//   EGRESS_ID, EGRESS_TOKEN (eigene Instanz), FREMD_ID, FREMD_TOKEN (andere Instanz), FREMD_IP (deren Container),
//   GATEWAY_IP (Host-Adresse in diesem Netz), HOST_PORT (Port, auf dem der Host lauscht), STANDIN_IP (öffentliche
//   Test-Adresse der KI-Attrappe), PHASE (vor_freigabe | nach_freigabe | nach_widerruf)
// Ausgabe: eine JSON-Zeile { pruefungen: [{ name, erwartet, ergebnis, ok }] }.
import net from 'node:net';

const E = process.env;
const pruefungen = [];
const merke = (name, erwartet, ergebnis) => pruefungen.push({ name, erwartet, ergebnis, ok: ergebnis === erwartet });

function direkt(host, port, ms = 3000) {
  return new Promise((ok) => {
    const s = net.connect({ host, port, timeout: ms });
    s.once('connect', () => { s.destroy(); ok('verbunden'); });
    s.once('timeout', () => { s.destroy(); ok('gesperrt'); });
    s.once('error', () => ok('gesperrt'));
  });
}

// CONNECT über kern-egress mit gewählter Anmeldung; liefert Statuscode der Proxy-Antwort
function connect(ziel, nutzer, token, ms = 8000) {
  return new Promise((ok) => {
    const s = net.connect({ host: 'kern-egress', port: 3128, timeout: ms });
    let puffer = '';
    s.once('connect', () => {
      const auth = nutzer ? `Proxy-Authorization: Basic ${Buffer.from(`${nutzer}:${token}`).toString('base64')}\r\n` : '';
      s.write(`CONNECT ${ziel} HTTP/1.1\r\nHost: ${ziel}\r\n${auth}\r\n`);
    });
    s.on('data', (d) => { puffer += d.toString('latin1'); const m = /^HTTP\/1\.1 (\d{3})/.exec(puffer); if (m) { s.destroy(); ok(Number(m[1])); } });
    s.once('timeout', () => { s.destroy(); ok('zeit'); });
    s.once('error', () => ok('fehler'));
  });
}
function httpUeberProxy(url, nutzer, token) {
  return new Promise((ok) => {
    const u = new URL(url);
    const s = net.connect({ host: 'kern-egress', port: 3128, timeout: 8000 });
    let puffer = '';
    s.once('connect', () => s.write(`GET ${url} HTTP/1.1\r\nHost: ${u.host}\r\nProxy-Authorization: Basic ${Buffer.from(`${nutzer}:${token}`).toString('base64')}\r\nConnection: close\r\n\r\n`));
    s.on('data', (d) => { puffer += d.toString('latin1'); const m = /^HTTP\/1\.1 (\d{3})/.exec(puffer); if (m) { s.destroy(); ok(Number(m[1])); } });
    s.once('timeout', () => { s.destroy(); ok('zeit'); });
    s.once('error', () => ok('fehler'));
  });
}

const ID = E.EGRESS_ID, T = E.EGRESS_TOKEN, KI = `${E.EGRESS_ID}.ki`;
if (E.PHASE === 'vor_freigabe') {
  // 1. Kein direkter Weg: weder ins Internet (Attrappe mit öffentlicher Adresse) noch zum Host noch zur Nachbarinstanz
  merke('direkt: KI-Attrappe (öffentliche Adresse) :443', 'gesperrt', await direkt(E.STANDIN_IP, 443));
  merke('direkt: 1.1.1.1:443', 'gesperrt', await direkt('1.1.1.1', 443));
  merke('direkt: Metadaten 169.254.169.254:80', 'gesperrt', await direkt('169.254.169.254', 80));
  merke(`direkt: Host im Instanznetz ${E.GATEWAY_IP}:${E.HOST_PORT}`, 'gesperrt', await direkt(E.GATEWAY_IP, Number(E.HOST_PORT)));
  merke('direkt: Nachbarinstanz :7480', 'gesperrt', await direkt(E.FREMD_IP, 7480));
  // 2. Proxy: Anmeldung
  merke('proxy: ohne Anmeldung', 407, await connect('api.mistral.ai:443', null, null));
  merke('proxy: falsches Token', 407, await connect('api.mistral.ai:443', ID, 'falsch'));
  merke('proxy: Token der Nachbarinstanz aus diesem Netz', 403, await connect('api.mistral.ai:443', E.FREMD_ID, E.FREMD_TOKEN));
  // 3. Proxy: erlaubte KI (Anbieterliste) über beide Kanäle
  merke('proxy ki: api.mistral.ai:443 (Anbieterliste)', 200, await connect('api.mistral.ai:443', KI, T));
  merke('proxy web: api.mistral.ai:443', 200, await connect('api.mistral.ai:443', ID, T));
  // 4. Proxy: Sperren nach Ziel und Port
  merke('proxy ki: nicht freigegebener öffentlicher Host', 403, await connect('nicht-erlaubt.example:443', KI, T));
  merke('proxy web: öffentlicher Host (web_offen)', 200, await connect('nicht-erlaubt.example:443', ID, T));
  merke('proxy: Port 8443 auf erlaubtem Host', 403, await connect('api.mistral.ai:8443', KI, T));
  merke('proxy: Port 22', 403, await connect('nicht-erlaubt.example:22', ID, T));
  merke('proxy: 169.254.169.254:443', 403, await connect('169.254.169.254:443', ID, T));
  merke('proxy: http://169.254.169.254/latest/meta-data/', 403, await httpUeberProxy('http://169.254.169.254/latest/meta-data/', ID, T));
  merke('proxy: [fd00:ec2::254]:443', 403, await connect('[fd00:ec2::254]:443', ID, T));
  merke('proxy: [::1]:443', 403, await connect('[::1]:443', ID, T));
  merke('proxy: [::ffff:127.0.0.1]:443', 403, await connect('[::ffff:127.0.0.1]:443', ID, T));
  merke('proxy: 127.0.0.1:443', 403, await connect('127.0.0.1:443', ID, T));
  merke('proxy: localhost:443', 403, await connect('localhost:443', ID, T));
  merke('proxy: 10.0.0.5:443', 403, await connect('10.0.0.5:443', ID, T));
  merke('proxy: Name löst privat auf (boese.example -> 10.0.0.5)', 403, await connect('boese.example:443', ID, T));
  merke('proxy: Name löst öffentlich UND Metadaten auf (doppelt.example)', 403, await connect('doppelt.example:443', ID, T));
  merke('proxy: Name löst auf Metadaten-IPv6 auf (v6boese.example)', 403, await connect('v6boese.example:443', ID, T));
  merke('proxy: Caddy kern-caddy:8443', 403, await connect('kern-caddy:8443', ID, T));
  merke('proxy: Nachbarinstanz über Proxy', 403, await connect(`${E.FREMD_IP}:443`, ID, T));
  merke('proxy ki: eigene-ki.example vor Freigabe', 403, await connect('eigene-ki.example:443', KI, T));
  // direkt (ohne Proxy) an die Dienste von kern-egress im eigenen Instanznetz
  const holen = (port, pfad) => new Promise((ok) => {
    const s = net.connect({ host: 'kern-egress', port, timeout: 5000 }); let p = '';
    s.once('connect', () => s.write(`GET ${pfad} HTTP/1.1\r\nHost: kern-egress\r\nAuthorization: Bearer ${'x'.repeat(64)}\r\nConnection: close\r\n\r\n`));
    s.on('data', (d) => { p += d; const m = /^HTTP\/1\.1 (\d{3})/.exec(p); if (m) { s.destroy(); ok(Number(m[1])); } });
    s.once('timeout', () => { s.destroy(); ok('zeit'); }); s.once('error', () => ok('fehler'));
  });
  merke('instanz: Verwaltung des Proxys aus dem Instanznetz', 403, await holen(3129, `/v1/instanzen/${ID}/egress`));
  merke('instanz: TLS-Ask aus dem Instanznetz (fremde Subdomains erfragen)', 403, await holen(3130, '/tls-ask?domain=baeckerei.kern.test'));
} else if (E.PHASE === 'nach_freigabe') {
  merke('proxy ki: eigene-ki.example nach Freigabe', 200, await connect('eigene-ki.example:443', KI, T));
} else if (E.PHASE === 'nach_widerruf') {
  merke('proxy ki: eigene-ki.example nach Widerruf', 403, await connect('eigene-ki.example:443', KI, T));
} else if (E.PHASE === 'ohne_nft') {
  // Gegenprobe: ohne die nftables-Tabelle erreicht die Instanz den Host. Beweist, dass genau diese Schicht sperrt.
  merke(`ohne nftables: Host im Instanznetz ${E.GATEWAY_IP}:${E.HOST_PORT}`, 'verbunden', await direkt(E.GATEWAY_IP, Number(E.HOST_PORT)));
  merke('ohne nftables: KI-Attrappe direkt (Docker-Netz internal hält weiter)', 'gesperrt', await direkt(E.STANDIN_IP, 443));
} else if (E.PHASE === 'fetch') {
  // So ruft core die KI auf: globales fetch mit NODE_USE_ENV_PROXY=1 und HTTPS_PROXY aus der Instanz-Umgebung
  try {
    const r = await fetch('https://api.mistral.ai/v1/models', { signal: AbortSignal.timeout(8000) });
    const j = await r.json();
    merke('fetch (NODE_USE_ENV_PROXY, Kanal web): https://api.mistral.ai/v1/models', 200, r.status === 200 && j.attrappe === true ? 200 : r.status);
  } catch (e) { merke('fetch (NODE_USE_ENV_PROXY): https://api.mistral.ai/v1/models', 200, `fehler: ${e.cause?.code ?? e.message}`); }
  try {
    const r = await fetch('https://169.254.169.254/', { signal: AbortSignal.timeout(8000) });
    merke('fetch (NODE_USE_ENV_PROXY): https://169.254.169.254/', 'abgelehnt', `status ${r.status}`);
  } catch (e) { merke('fetch (NODE_USE_ENV_PROXY): https://169.254.169.254/', 'abgelehnt', 'abgelehnt'); }
}
console.log(JSON.stringify({ phase: E.PHASE, pruefungen }));
