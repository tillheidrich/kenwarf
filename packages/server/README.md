# @kern/server

REST-API, MCP-Server und Auslieferung der Weboberfläche für Kern. Hono auf Node 22, TypeScript strict, ESM.
Die Logik (Dateien, git, Index, KI) steckt in `@kern/core`; der Server prüft Anmeldung, Rollen, Eingaben und Pfade und reicht weiter.

## Starten

```sh
npm run build -w packages/server
KERN_DATA=./kern-data KERN_SECRET=$(openssl rand -hex 32) node packages/server/dist/start.js
# oder über die CLI:
kern -d ./kern-data serve --port 7480
```

Ohne gebautes core: `KERN_FAKE=1` nutzt die Attrappe `src/testing/fake-kern.ts` (gleiche Signaturen, Dateien im Datenordner, keine KI, kein git).

## Konfiguration

| Variable | Bedeutung | Standard |
|---|---|---|
| `PORT`, `HOST` | Adresse | `7480`, `0.0.0.0` |
| `KERN_DATA` | Datenordner | `./kern-data` |
| `KERN_SECRET` | Schlüssel für Sitzungs-Cookies, ≥ 32 Zeichen. **Pflicht bei `NODE_ENV=production`** | zufällig (Sitzungen enden beim Neustart) |
| `KERN_SECURE_COOKIE` | Cookie nur über HTTPS (`__Host-`-Präfix, HSTS) | an bei `NODE_ENV=production` |
| `KERN_NOINDEX` | Header `X-Robots-Tag: noindex, nofollow, noarchive` | an |
| `KERN_TRUST_PROXY` | IP für das Login-Ratenlimit aus `X-Forwarded-For` (nur hinter eigenem Proxy) | aus |
| `KERN_MAX_UPLOAD_MB` | Höchstgröße für Uploads | `50` |
| `KERN_SITZUNG_STUNDEN` | Gültigkeit einer Sitzung | `12` |
| `KERN_WEB_DIST` | Build der Weboberfläche | `../web/dist` |
| `KERN_CSP` | eigene Content-Security-Policy statt der Vorgabe | `default-src 'self'` … |
| `KERN_FAKE` | Attrappe statt core | aus |
| `KERN_BEOBACHTEN_STUNDEN` | Takt des Planers für beobachtete Quellen (v1.2), `0` = aus; alternativ `beobachtung.stunden` in kern.yaml | `24` |
| `KERN_PROVIDER` | `mock` · `ollama` · `openai` (kompatibel: Mistral, IONOS, STACKIT, vLLM) · `anthropic` | aus kern.yaml, sonst `mock` |
| `KERN_PROVIDER_URL`, `KERN_CHAT_MODELL`, `KERN_EMBED_MODELL` | Anbieterdaten | aus kern.yaml |
| `KERN_PROVIDER_KEY` | API-Schlüssel | – |

`kern.yaml` im Datenordner:

```yaml
betrieb: Tischlerei Beispiel
sprache: de
teams: [buero, werkstatt]
provider:
  art: openai
  url: https://api.mistral.ai/v1
  chatModell: mistral-small-latest
  embedModell: mistral-embed
  apiKeyEnv: MISTRAL_API_KEY   # Schlüssel nie in kern.yaml: der Ordner liegt in git
```

## Sicherheit

- Sitzung: zufällige ID im Speicher, Cookie `<id>.<HMAC-SHA256>`, `HttpOnly`, `SameSite=Strict`, `Secure` per Env. Logout löscht die Sitzung serverseitig.
- CSRF: jede POST/PUT/DELETE-Anfrage unter `/api` braucht den Header `x-kern` (auch Login). Zusammen mit `SameSite=Strict` reicht das ohne Token-Abgleich.
- Login-Ratenlimit: 5 Fehlversuche je Name und IP, 30 je IP, Fenster 15 Minuten, danach 429 mit `Retry-After`.
- Rollen: `leser` liest, sucht, fragt · `autor` fügt hinzu und schlägt vor · `freigeber` entscheidet im Eingang und startet den Prüflauf · `admin` alles inklusive Einstellungen und Benutzer. Sichtbarkeit je Datei prüft core.
- Pfade: `..`, versteckte Segmente (`.git`, `.kern`), Backslash, NUL und kodierte Schrägstriche ergeben 404. Dateien werden zusätzlich nach `realpath` gegen den Basisordner geprüft.
- Upload: Größenlimit vor dem Parsen (413), Dateiname bereinigt, Zwischenablage `.kern/upload/<zufall>/`, danach gelöscht.
- Originaldateien: immer `Content-Disposition: attachment`, `CSP: sandbox`, HTML/SVG als `application/octet-stream`.
- Header: CSP `self`, `nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer`, COOP/CORP `same-origin`, Permissions-Policy, HSTS bei Secure-Cookie.
- v1.2: `index.md`/`log.md` als Ziel abgewiesen (400); Vorschläge für `wissen/_regeln/` darf nur admin freigeben; Freigabe gegen eine inzwischen geänderte Datei ergibt 409 mit Status `konflikt` und neuem Vergleich; MCP-Vorschläge tragen im Grund die Kennzeichnung `[über MCP]`.
- MCP-Tokens: `kern_` + 32 Zufallsbytes, gespeichert nur als SHA-256 in `.kern/tokens.json` (Modus 600, nicht im git).

## REST

Vollständig in [`openapi.yaml`](./openapi.yaml). Überblick:

`POST /api/login` · `POST /api/logout` · `GET /api/ich` · `GET /api/wissen[?gruppe=]` · `GET /api/wissen/<pfad>` · `GET /api/wissen/<pfad>/verlauf` · `GET /api/quellen[?sammlung=]` · `GET /api/quellen/<pfad>` · `GET /api/quellen/<pfad>/original` · `GET /api/suche?q=&reichweite=&sammlung=&limit=` · `POST /api/frage` · `GET /api/fakten?art=&gegenstand=&gueltig_am=` · `POST /api/hinzufuegen` (multipart oder JSON) · `GET /api/eingang` · `POST /api/eingang/:id` · `POST /api/vorschlag` · `POST /api/pruefen` · `GET /api/briefing[?seit=]` · `GET /api/faellig` · `GET|PUT /api/einstellungen` · `GET /api/datenweg` · `GET|POST /api/benutzer` · `GET|POST /api/benutzer/:id/tokens` · `DELETE /api/benutzer/:id/tokens/:tid` · `GET /healthz`

Beispiel:

```sh
curl -c jar -H 'x-kern: 1' -H 'content-type: application/json' -d '{"name":"chef","passwort":"…"}' localhost:7480/api/login
curl -b jar -H 'x-kern: 1' -H 'content-type: application/json' -d '{"frage":"Wie lange vorher Urlaub beantragen?"}' localhost:7480/api/frage
curl -b jar -H 'x-kern: 1' -F datei=@handbuch.pdf -F sammlung=betrieb -F sichtbarkeit=betrieb localhost:7480/api/hinzufuegen
```

## MCP

Streamable HTTP unter `/mcp`, zustandslos, JSON-Antworten. `Authorization: Bearer <token>` (Token: `kern token anlegen <name>` oder `POST /api/benutzer/<id>/tokens`). Ohne gültiges Token: 401 mit `WWW-Authenticate: Bearer`.

| Werkzeug | Zweck | schreibt? |
|---|---|---|
| `kern_suche` | Treffer mit Pfad, Abschnitt, Zeilen | nein |
| `kern_lese` | Artikel oder Quelle vollständig | nein |
| `kern_frage` | Antwort mit Belegen oder „steht nicht drin“ | nein |
| `kern_fakten` | einzelne Fakten mit Gültigkeit und Fundstelle | nein |
| `kern_vorschlag` | Vorschlag in den Eingang (Rolle autor) | nur Eingang |
| `kern_eingang` | offene Vorschläge ansehen | nein |
| `kern_briefing` | Lagebericht | nein |

Entscheiden über Vorschläge geht absichtlich nicht über MCP.

Claude Desktop / Claude Code (Beispiel):

```json
{ "mcpServers": { "kern": { "type": "http", "url": "https://kern.example.de/mcp", "headers": { "Authorization": "Bearer kern_…" } } } }
```

## Tests

```sh
npm test -w packages/server   # vitest; MCP-Test startet einen echten Server auf Port 4301 (KERN_TEST_PORT)
```
