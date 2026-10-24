# Kern in Coolify (eigene Instanz)

Für Betriebe oder Systemhäuser, die schon Coolify nutzen. Nicht für den Managed-Betrieb von HD mit vielen Kundeninstanzen (dafür der Leitstand, `team2/o1_betrieb/v14-betrieb.md`).

## Weg 1: Docker Compose (empfohlen)
1. Coolify: Projekt → Neue Ressource → **Docker Compose** → Repository dieses Projekts, Branch `main`, Compose-Pfad `deploy/docker-compose.yml`.
2. Den Dienst `caddy` nicht nutzen (Profil `tls` nicht aktivieren): Coolify bringt eigenen Proxy (Traefik oder Caddy) mit Zertifikaten.
3. Beim Dienst `kern` unter **Domains** `https://wissen.example.de:7480` eintragen (Coolify-Schreibweise: Domain plus interner Port).
4. Umgebungsvariablen setzen: `KERN_BETRIEB`, `KERN_SECURE_COOKIE=1`, `KERN_TRUST_PROXY=1`, KI-Variablen nach `.env.example`. `KERN_ADMIN_PASSWORT` als **Secret** (Haken „Is Secret“/„Build Variable“ aus).
5. Die Port-Freigabe `127.0.0.1:7480` aus der Compose-Datei stört nicht; Coolify spricht den Container über das interne Netz an. Wer sie loswerden will: `KERN_BIND=127.0.0.1` lassen oder Port-Zeile in einer Coolify-eigenen Kopie entfernen.
6. Speicher: Coolify legt das benannte Volume `kern-daten` an. **Backups in Coolify gelten nur für Datenbanken**, nicht für dieses Volume. Sicherung über `deploy/scripts/backup.sh` (restic) als Cron auf dem Host oder als Scheduled Task, siehe Haupt-README.
7. `/_betrieb/*` im Coolify-Proxy sperren (Traefik-Label oder Caddy-Snippet), falls der Managed-Teil später aktiv wird. Heute gibt es diese Routen noch nicht.

## Weg 2: Dockerfile
Ressource → **Dockerfile**, Build-Kontext Repo-Wurzel, Dockerfile `deploy/Dockerfile`, Port 7480, persistenter Speicher auf `/daten`. Sonst wie oben.

## Hinweise
- Der Container läuft als Benutzer `node`, Dateisystem schreibgeschützt bis auf `/daten` und `/tmp`. Coolify-Optionen, die in den Container schreiben (z. B. eigene Init-Skripte), passen dazu nicht.
- Erstzugang: Coolify → Logs des Dienstes `kern`, Zeile `ERSTZUGANG`.
- Healthcheck ist im Image (`/healthz`); Coolify erkennt ihn.
- Nicht in Coolify geprüft (kein Coolify in der Sandbox). Geprüft sind Image, Compose und Caddyfile lokal, siehe Haupt-README.
