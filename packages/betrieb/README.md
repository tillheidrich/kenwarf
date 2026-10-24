# @kern/betrieb: Leitstand und Betreiber-Konsole

Leitstand (Bereitstellungsdienst nach CONTRACT v1.4 Abschnitt 3 und O1 Abschnitt 1) und Betreiber-Konsole für den Managed-Betrieb, in einem Prozess. Die Konsole sieht Betriebsdaten der Instanzen, nie Inhalte.

## Starten

```
npm run build -w @kern/betrieb
BETRIEB_VORFUEHRUNG=1 BETRIEB_PORT=4307 BETRIEB_HOST=localhost node packages/betrieb/dist/start.js   # erfundene Vorführdaten, Admin „till“
kern-betrieb admin anlegen till        # Erst-Admin: Passwort + TOTP, danach Passkey in der Konsole
kern-betrieb token erzeugen website    # Bearer-Token für /v1 (Testformular, Automatisierung)
```

Wichtige Umgebungsvariablen: `BETRIEB_SECRET` (≥ 32 Zeichen), `BETRIEB_DB`, `BETRIEB_BEREITSTELLER=dummy|lokal`, `BETRIEB_LOKAL_ORDNER`, `MOLLIE_API_KEY`, `KERN_MANAGED_DOMAIN` (S-2), `BETRIEB_GETEILTE_HOSTS` (JSON), `BETRIEB_RECHNUNG_LINK` (`…/{ref}`), `BETRIEB_RP_ID`, `BETRIEB_ORIGIN`, `BETRIEB_NUR_PASSKEY=1`, `BETRIEB_SECURE_COOKIE=1`. Bindet nur an 127.0.0.1: Konsole hinter VPN oder SSH-Tunnel; öffentlich nur `/v1/webhooks/mollie`, `/v1/konto/*` (Konto-Token je Instanz) und der Lösch-Bestätigungslink.

## Aufbau

| Datei | Inhalt |
|---|---|
| `src/leitstand.ts` | einziger Weg, Kunden und Instanzen zu ändern; ein Vorgang `instanz_anlegen` für Mollie, Formular, Handanlage, Pitch, Partner (idempotent); Stufenwechsel, Umzug, Export, Löschung mit Beleg, Planer, Heute |
| `src/regeln.ts` | reine Ablaufregeln: Zustände (O1-Namen), Fristen, Planer-Absichten, Host-Belegung (70 %), Testende 23:59 Europe/Berlin |
| `src/schalter.ts` | Schalter S-1 bis S-12 mit Standardwerten, Paketgrenzen 3.1, Preise G1 N-2 |
| `src/bereitsteller/` | Schnittstelle `Bereitsteller` (Schritte O1 1.2, Betriebs-Endpunkte 1.7, Wechsel 1.8.4, Grenzen 3.4, Egress 3.7); `dummy` (Speicher), `lokal` (echte Kern-Datenordner über @kern/core) |
| `src/mollie.ts` | nur lesend plus Checkout für den Kauf aus der Instanz |
| `src/auth.ts`, `src/passkey.ts` | Passwort (scrypt) + TOTP als Erst- und Rückfallweg, Passkeys (WebAuthn, @simplewebauthn/server, MIT) |
| `src/app.tsx`, `src/konsole/` | Hono, serverseitig gerendert (hono/jsx), strenge CSP ohne Inline-Skripte, Formulare mit CSRF-Token |
| `beispiele/kanzlei-behrens/` | erfundene Beispielkanzlei für Pitches (Wendt kommt aus @kern/core) |

UI-Entscheidung: serverseitig gerendert statt Preact. Ein Bediener, formularlastig, wenige Seiten; ohne Build-Schritt für die Oberfläche, funktioniert ohne JavaScript, kleinere Angriffsfläche (`script-src 'self'`, zwei kleine Skripte).

## Prüfen

`npm test -w @kern/betrieb` (vitest, inkl. echter Engine über `lokal`), `node packages/betrieb/e2e/screenshots.mjs` (Playwright 390/1440 px, axe WCAG 2.2 AA, Passkey mit virtuellem Authenticator).
