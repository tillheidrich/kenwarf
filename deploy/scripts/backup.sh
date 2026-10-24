#!/bin/sh
# Backup eines Kern-Datenordners mit restic (verschlüsselt, dedupliziert), plus Wiederherstellungstest.
#
#   backup.sh                      sichern (Standard)
#   backup.sh test                 letzten Stand in einen Wegwerf-Container einspielen, Index bauen, kern pruefen
#
# Umgebung: RESTIC_REPOSITORY, RESTIC_PASSWORD (oder RESTIC_PASSWORD_FILE),
#           KERN_VOLUME (Standard: kern_kern-daten), KERN_IMAGE (für den Test).
# Ohne RESTIC_REPOSITORY: nur lokaler Schnappschuss nach /var/backups/kern (zählt nicht als
# „außer Haus“, siehe README 3-2-1).
# Gesichert wird alles außer dem wegwerfbaren Index. .kern/users.json, tokens.json und secret
# gehören dazu, sonst kann sich nach einer Wiederherstellung niemand anmelden.
set -eu

VOL="${KERN_VOLUME:-kern_kern-daten}"
QUELLE="$(docker volume inspect -f '{{.Mountpoint}}' "$VOL")"
modus="${1:-sichern}"

if [ -z "${RESTIC_REPOSITORY:-}" ]; then
  ziel=/var/backups/kern
  mkdir -p "$ziel"; chmod 0700 "$ziel"
  datei="$ziel/kern-$(date -u +%Y%m%dT%H%M%SZ).tar.gz"
  tar -C "$QUELLE" --exclude='./.kern/index.sqlite*' -czf "$datei" .
  ls -1t "$ziel"/kern-*.tar.gz | tail -n +15 | xargs -r rm -f
  echo "Lokaler Schnappschuss: $datei (14 werden behalten). Kein Ziel außer Haus gesetzt."
  exit 0
fi

case "$modus" in
  sichern)
    restic snapshots >/dev/null 2>&1 || restic init
    restic backup --tag kern --host "$(hostname)" --exclude '.kern/index.sqlite*' "$QUELLE"
    restic forget --tag kern --keep-daily 14 --keep-weekly 8 --keep-monthly 12 --prune
    # Stichprobe der Daten im Ziel (Bitfehler, fehlende Pakete)
    restic check --read-data-subset=2%
    ;;
  test)
    tmp="$(mktemp -d)"
    trap 'docker rm -f kern-wiederherstellung >/dev/null 2>&1 || true; rm -rf "$tmp"' EXIT
    restic restore latest --tag kern --target "$tmp"
    daten="$(find "$tmp" -name kern.yaml -printf '%h\n' | head -1)"
    [ -n "$daten" ] || { echo "Kein Datenordner im Backup" >&2; exit 1; }
    docker run --rm --name kern-wiederherstellung --network none -v "$daten":/daten \
      --entrypoint sh "${KERN_IMAGE:-kern:latest}" -c 'kern -d /daten reindex && kern -d /daten pruefen --json > /tmp/b.json; node -e "const b=require(\"/tmp/b.json\");const f=b.befunde.filter(x=>x.schwere===\"fehler\").length;console.log(\"Wiederherstellungstest: \"+b.befunde.length+\" Befunde, \"+f+\" Fehler\");process.exit(f?1:0)"'
    ;;
  *) echo "Aufruf: backup.sh [sichern|test]" >&2; exit 64 ;;
esac
