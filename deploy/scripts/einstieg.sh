#!/bin/sh
# Einstieg im Container. Erster Start: Datenordner anlegen, Sitzungsschlüssel erzeugen, ersten Admin anlegen.
# Danach: `serve` (Standard) oder jeder andere kern-Befehl, z. B. `docker compose exec kern kern pruefen`.
#
# Umgebungsvariablen (alle optional):
#   KERN_DATA               Datenordner, Standard /daten
#   KERN_BETRIEB            Name des Betriebs beim ersten Start
#   KERN_ADMIN              Anmeldename des ersten Admins (Standard: admin)
#   KERN_ADMIN_PASSWORT     Passwort des ersten Admins (mind. 10 Zeichen)
#   KERN_ADMIN_PASSWORT_FILE  Datei mit dem Passwort (Docker-/Coolify-Secret)
#   KERN_ERSTZUGANG         log | datei (Standard log): Wohin ein erzeugtes Erstpasswort geht.
#                           Managed-Betrieb setzt "datei", damit nie ein Passwort im Log landet.
#   KERN_SECRET             Sitzungsschlüssel (>= 32 Zeichen). Fehlt er, wird er einmal erzeugt
#                           und in $KERN_DATA/.kern/secret abgelegt (nicht im git, nicht im Export).
#   KERN_DEMO=1             Statt eines leeren Ordners den erfundenen Beispielbetrieb anlegen
#                           (nur für Vorführ-Instanzen: Demo-Zugänge mit bekanntem Passwort!).
set -eu

DATA="${KERN_DATA:-/daten}"
export KERN_DATA="$DATA"
KERN="node /app/packages/cli/dist/cli.js"
mkdir -p "$DATA/.kern"
chmod 0700 "$DATA/.kern" 2>/dev/null || true

# Sitzungsschlüssel
if [ -z "${KERN_SECRET:-}" ]; then
  if [ ! -s "$DATA/.kern/secret" ]; then
    umask 077
    node -e "process.stdout.write(require('crypto').randomBytes(32).toString('hex'))" > "$DATA/.kern/secret"
  fi
  KERN_SECRET="$(cat "$DATA/.kern/secret")"
  export KERN_SECRET
fi

if [ -n "${KERN_ADMIN_PASSWORT_FILE:-}" ] && [ -s "$KERN_ADMIN_PASSWORT_FILE" ]; then
  KERN_ADMIN_PASSWORT="$(cat "$KERN_ADMIN_PASSWORT_FILE")"
fi

erster_start=0
[ -f "$DATA/kern.yaml" ] || erster_start=1

if [ "$erster_start" = 1 ]; then
  if [ "${KERN_DEMO:-0}" = 1 ]; then
    node --input-type=module -e "
      const { seedDemo } = await import('/app/packages/core/dist/index.js');
      const r = await seedDemo(process.env.KERN_DATA);
      console.log('[kern] Beispielbetrieb angelegt:', r.artikel, 'Artikel,', r.quellen, 'Quellen. Demo-Zugänge siehe README.');
    "
  else
    $KERN init "$DATA" --betrieb "${KERN_BETRIEB:-Mein Betrieb}" >/dev/null
    ADMIN="${KERN_ADMIN:-admin}"
    if [ -z "${KERN_ADMIN_PASSWORT:-}" ]; then
      KERN_ADMIN_PASSWORT="$(node -e "process.stdout.write(require('crypto').randomBytes(15).toString('base64url'))")"
      if [ "${KERN_ERSTZUGANG:-log}" = datei ]; then
        umask 077
        printf '%s\n' "$KERN_ADMIN_PASSWORT" > "$DATA/.kern/erstzugang"
        echo "[kern] Erstzugang für \"$ADMIN\" liegt in $DATA/.kern/erstzugang (einmalig, nach der Anmeldung ändern)."
      else
        echo "[kern] ERSTZUGANG (nur jetzt sichtbar): Benutzer \"$ADMIN\", Passwort $KERN_ADMIN_PASSWORT"
      fi
    fi
    KERN_PASSWORT="$KERN_ADMIN_PASSWORT" $KERN -d "$DATA" nutzer anlegen "$ADMIN" --rollen admin >/dev/null
    echo "[kern] Datenordner angelegt, Admin \"$ADMIN\"."
  fi
fi
unset KERN_ADMIN_PASSWORT KERN_PASSWORT 2>/dev/null || true

if [ "${1:-serve}" = serve ]; then
  shift 2>/dev/null || true
  exec $KERN -d "$DATA" serve "$@"
fi
exec $KERN -d "$DATA" "$@"
