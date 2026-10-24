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

## 6. Was geprüft ist (24.10.2026, Sandbox)
- Image gebaut aus dem Arbeitsstand (Snapshot von HEAD 9432bbe plus laufende Änderungen B1/B3), Basis `mirror.gcr.io/library/node:22-bookworm-slim`. Größe 744 MB (zu groß, siehe Offen).
- `docker run`: Healthcheck „healthy“ nach etwa 10 s; Erstzugang im Log; Anmeldung, Text hinzufügen, Frage mit Fundstelle (`beantwortet`, Beleg mit Datei, Abschnitt, Zeile, Zitat) in 0,44 s ab Anmeldung (mock).
- MCP: ohne Token 401, mit Token `initialize` und `kern_frage` mit Belegen.
- Compose mit schreibgeschütztem Dateisystem, `cap_drop: ALL`, `no-new-privileges`: läuft. Caddyfile: `caddy validate` gültig. Profil `tls` und Zertifikat nicht gegen das Internet getestet.
- Umzug A → B: Paket 23 KB, Prüfsummen, `git fsck`, gleicher HEAD, Index neu, `kern pruefen` ohne Fehler; auf B Anmeldung mit altem Passwort, Artikel, Verlauf und belegte Antwort vorhanden.
- Backup ohne restic-Ziel und Wiederherstellungstest im Container ohne Netz: läuft. restic selbst und `cloud-init/hetzner.yaml` auf einem echten Hetzner-Server: **nicht geprüft**.

## 7. Offen
- Kein veröffentlichtes Image und kein öffentliches Repo; cloud-init baut deshalb aus dem Quellcode (`KERN_REPO` ist ein Platzhalter).
- `package-lock.json` liegt nicht im git; ohne sie ist `npm ci` und damit der Bau nicht reproduzierbar.
- Image verkleinern (Laufzeit-Abhängigkeiten von web/vite trennen, pdfjs-Ballast prüfen), SBOM (`docker buildx build --sbom=true`) und Signatur (cosign) für IT-Abteilungen.
- Sitzungen liegen im Speicher: Jeder Neustart (auch Updates) meldet alle ab.
