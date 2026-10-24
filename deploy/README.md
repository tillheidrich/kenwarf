# Betrieb: Kenwarf installieren, sichern, umziehen

> Hinweis: Befehle, Variablen und Image heißen im Code noch `kern` (früherer Arbeitstitel), die Umbenennung folgt.

Drei Wege, gleiche Software, gleiches Datenformat. Wechsel zwischen den Wegen ohne Datenverlust (Abschnitt „Umzug“).

| Weg | Für wen | Daten liegen |
|---|---|---|
| Lokal (`docker run`) | Ausprobieren, Einzelplatz, Kanzlei mit lokaler KI | auf dem eigenen Rechner |
| Eigene EU-Cloud (Hetzner cloud-init, Compose, Coolify) | Betrieb mit eigener IT oder Systemhaus, Schule, Verein | beim eigenen Hoster |
| Managed durch Heidrich Digital | wer nichts betreiben will | auf einem HD-Kundenserver, eine Instanz je Kunde (Vorschlag v1.4, noch nicht gebaut) |

## 1. Lokal in einer Minute

```bash
docker build -f deploy/Dockerfile -t kern .          # aus dem Repo-Wurzelordner, bis es ein veröffentlichtes Image gibt
docker run -d --name kern -p 127.0.0.1:7480:7480 -v kern-daten:/daten kern
docker logs kern | grep ERSTZUGANG                    # Benutzer admin, Passwort einmalig
```
Dann http://127.0.0.1:7480 öffnen, anmelden, unter „Hinzufügen“ ein Dokument ablegen, unter „Fragen“ fragen. Ohne KI-Anbieter arbeitet Kern im Modus `mock`: Suche und wörtliche Auszüge mit Fundstelle, keine formulierten Antworten.

Beispielbetrieb zum Vorführen (erfundene Tischlerei, Demo-Zugänge mit bekanntem Passwort, nie für echte Daten):
```bash
docker run -d --name kern-demo -p 127.0.0.1:7481:7480 -e KERN_DEMO=1 -v kern-demo:/daten kern
```
Anmeldung z. B. als „Jörn Wendt“ (admin) oder „Lena Meyer“ (leser), Passwort `demo-passwort`. Geprüft: 26 Artikel, 4 Quellen; die Frage nach der Lieferzeit für Beschläge zeigt zwei belegte, sich widersprechende Angaben.

Mit lokalem Modell (Ollama im selben Verbund, nichts verlässt den Rechner):
```bash
cd deploy && cp .env.example .env    # KERN_PROVIDER=ollama, KERN_PROVIDER_URL=http://ollama:11434, Modelle eintragen
docker compose --profile ollama up -d
docker compose exec ollama ollama pull qwen3:8b && docker compose exec ollama ollama pull bge-m3
```

## 2. Eigene Cloud

**Hetzner, ein Schritt:** `cloud-init/hetzner.yaml` öffnen, im Block `.env` Domain, Mail und Betriebsname eintragen, beim Anlegen des Servers (Ubuntu 24.04) als „Cloud config“ einfügen. A-Record der Domain auf die Server-IP. Das Skript richtet Updates, Firewall, SSH nur mit Schlüssel, Docker, Kern, Caddy (TLS) und einen täglichen Backup-Timer ein. Docker umgeht ufw bei veröffentlichten Ports; deshalb ist Kern nur an 127.0.0.1 gebunden und nur Caddy auf 80/443 offen.

**Docker Compose auf einem vorhandenen Server:**
```bash
cd deploy && cp .env.example .env    # KERN_DOMAIN, ACME_MAIL, KERN_SECURE_COOKIE=1, KERN_TRUST_PROXY=1
docker compose --profile tls up -d --build
```

**Coolify:** siehe `coolify/README.md`.

Hinter einem Firmen-Proxy mit eigener CA bauen:
```bash
docker build -f deploy/Dockerfile --network host --build-arg HTTPS_PROXY=$HTTPS_PROXY \
  --secret id=ca,src=/pfad/firmen-ca.pem -t kern .
```

## 3. Umgebungsvariablen

| Variable | Standard | Zweck |
|---|---|---|
| `KERN_BETRIEB` | Mein Betrieb | Name beim ersten Start |
| `KERN_ADMIN`, `KERN_ADMIN_PASSWORT(_FILE)` | admin, erzeugt | erster Admin |
| `KERN_ERSTZUGANG` | log | `datei`: erzeugtes Passwort nur nach `/daten/.kern/erstzugang`, nie ins Log |
| `KERN_SECRET` | erzeugt, in `/daten/.kern/secret` | Sitzungsschlüssel |
| `KERN_PROVIDER`, `_URL`, `_KEY`, `KERN_CHAT_MODELL`, `KERN_EMBED_MODELL` | mock | KI-Anbieter, Beispiele in `.env.example` |
| `KERN_SECURE_COOKIE`, `KERN_TRUST_PROXY` | 0 | hinter TLS-Proxy auf 1 |
| `KERN_DEMO` | 0 | Beispielbetrieb statt leerem Ordner |

## 4. Sichern (3-2-1)

`scripts/backup.sh` sichert das Volume mit restic (verschlüsselt, Aufbewahrung 14 täglich, 8 wöchentlich, 12 monatlich, Stichprobenprüfung 2 %). Ohne `RESTIC_REPOSITORY` nur ein lokaler Schnappschuss, das ist kein Backup außer Haus.
- 3 Kopien: Volume, restic-Ziel 1 (z. B. Speicherbox an einem anderen Standort), restic-Ziel 2 (anderer EU-Anbieter) oder ein Wechselträger.
- `backup.sh test` spielt den letzten Stand in einen Container ohne Netz ein, baut den Index und lässt `kern pruefen` laufen. Monatlich ausführen; ohne bestandenen Test gilt ein Backup als nicht vorhanden.
- Gesichert wird alles außer dem Index, auch `.kern/users.json`, `tokens.json` und `secret`. Der restic-Schlüssel gehört nicht auf denselben Server wie das Ziel-Passwort im Klartext; bei Managed liegt er im Leitstand.

## 5. Umzug ohne Datenverlust

`scripts/umzug.sh` (im Image als `kern-umzug`):
```bash
# alte Instanz: Server anhalten oder sicherstellen, dass nichts offen ist, dann
docker exec kern kern-umzug packen /daten /tmp/umzug.tar.gz && docker cp kern:/tmp/umzug.tar.gz .
# neue Instanz, VOR dem ersten Start:
docker volume create kern-daten-neu
docker run --rm -v kern-daten-neu:/daten -v $PWD/umzug.tar.gz:/u.tar.gz:ro --entrypoint sh kern \
  -c 'kern-umzug auspacken /u.tar.gz /daten && kern-umzug pruefen /daten'
docker run -d --name kern-neu -p 127.0.0.1:7480:7480 -v kern-daten-neu:/daten kern
```
`pruefen` vergleicht die SHA-256-Liste aller Dateien, prüft die git-Geschichte (`git fsck`, gleicher HEAD), baut den Index neu und lässt `kern pruefen` laufen. Erst mit „UMZUG OK“ die alte Instanz abschalten. Anmeldungen und MCP-Tokens ziehen mit, der Sitzungsschlüssel nicht (alle melden sich einmal neu an).
Warum nicht `kern export` (ZIP) oder OKF: Das ZIP lässt `.kern/` weg, also die Benutzer; der OKF-Import legt Artikel als Vorschläge an. Beides ist richtig für Austausch und Ausstieg, für einen Umzug von Kern zu Kern zu wenig.

## 6. Geteilter Host (Managed, Stufe „Geteilt“)

Ein Container je Kunde, eigenes Docker-Netz `internal: true`, eigener Datenordner mit XFS-Kontingent, eigene Schlüssel.
Bausteine unter `host/` und `egress/`, Ablauf und Störungen in `docs/betrieb/runbook.md`.

| Datei | Zweck |
|---|---|
| `host/kern-host` | Instanz anlegen, Grenzen ändern, Status, `/_betrieb/*` aufrufen, entfernen (JSON-Zeilen für den Leitstand) |
| `host/compose.yml`, `host/Caddyfile` | Caddy (On-Demand-TLS mit Ask, nur bekannte Subdomains) und kern-egress |
| `host/Caddyfile.wildcard` | Alternative mit Wildcard-Zertifikat über DNS-01 (eigenes Caddy-Image nötig, nicht geprüft) |
| `egress/kern-egress.mjs` | Ausgangs-Proxy mit Sperrliste nach DNS-Auflösung, nur 80/443, Erlaubnisliste je Instanz, Verwaltung für den Leitstand, TLS-Ask |
| `host/nft-kern.sh` | zweite Sperre auf dem Host (eigene nftables-Tabelle an forward/input), Dauerdienst `beobachten` |
| `host/kern-quota.sh` | XFS-Projektkontingent je Instanz |
| `host/kern-backup` | restic stündlich je Instanz, Aufbewahrung 24/14/8/12, Wiederherstellungstest mit Bericht, Schlüssel vernichten |
| `host/pakete.json`, `host/anbieter.json` | Grenzen je Paket (CONTRACT 3.1), KI-Anbieterliste (gleiche Datei für Instanz und Proxy) |
| `cloud-init/geteilt.yaml` | Host von Grund auf (LUKS, XFS, Docker, Dienste, Timer), nicht auf echtem Hetzner geprüft |

## 7. Image

Seit D2 (24.10.2026) startet die Laufzeit von einem nackten Debian bzw. Alpine mit kopierter Node-Binärdatei, Abhängigkeiten
ohne Entwicklungspakete und ohne Ballast (`scripts/schlank.sh`: `@napi-rs/canvas`, moderne pdfjs-Builds, fremde
Plattform-Binärdateien, C-Quellen, Karten, Typen), perl aus der Git-Installation entfernt.

| Variante | Docker „Disk usage“ | komprimiert | Vektorsuche |
|---|---|---|---|
| vorher (O1, node:22-bookworm-slim) | 744 MB | 183 MB | sqlite-vec |
| `laufzeit` (Standard, Debian) | 419 MB | 107 MB | sqlite-vec |
| `--target laufzeit-alpine` | 275 MB | 70 MB | JS-Kosinus (sqlite-vec hat keine musl-Binärdatei) |

Standard bleibt Debian: Die JS-Vektorsuche hält alle Vektoren im Speicher; bei großen Instanzen im Paket „klein“ (768 MB)
wäre das ein Risiko. Alpine für kleine und selbst gehostete Instanzen. Größter Einzelposten ist die Node-Binärdatei (125 MB).
Rauchtest (`e2e/rauchtest/rauchtest.mjs`: Text, PDF, DOCX, belegte Antwort mit wörtlichem Zitat) grün: Debian an fd33686, Alpine an f09adb4.

## 8. Was geprüft ist
- O1 (24.10.2026): `docker run`, Compose mit Härtung, Umzug A nach B, Backup ohne Ziel. Siehe Verlauf dieses Dokuments.
- D2 (24.10.2026, Sandbox): `e2e/egress/egress-test.sh` 57 Prüfungen grün, `e2e/backup/backup-test.sh` 12 Prüfungen grün,
  Rauchtest grün, Stoppuhr siehe `e2e/stoppuhr/ergebnis.json` (am Stand fd33686 rot wegen Web/Server-Abweichung, mit
  einzeiliger Probe-Korrektur grün in 8,7 s und 5 Klicks, `ergebnis-probe.json`).
- Nicht geprüft: echter Hetzner-Server, Let's-Encrypt-Zertifikat, XFS-Kontingent (Kernel der Sandbox ohne Quota), LUKS.

## 9. Offen
- Kein veröffentlichtes Image; cloud-init baut aus dem Quellcode. SBOM (`docker buildx build --sbom=true`) und Signatur (cosign).
- `package-lock.json` muss bei jeder Abhängigkeitsänderung mit committet werden (Stand 74ec34a: nicht synchron, `npm ci` bricht ab).
