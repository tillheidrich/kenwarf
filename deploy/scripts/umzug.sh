#!/bin/sh
# Umzugspaket packen und prüfen: verlustfrei zwischen Managed, eigener Cloud und lokal.
#
#   umzug.sh packen  <datenordner> <ziel.tar.gz>      Paket mit Prüfsummenliste schreiben
#   umzug.sh pruefen <datenordner>                     Nach dem Auspacken: Prüfsummen, git fsck, Index neu, kern pruefen
#
# Inhalt des Pakets: der ganze Datenordner mit .git/ (Versionsgeschichte, Freigaben, Eingang),
# dazu aus .kern/ nur users.json und tokens.json (Anmeldungen und MCP-Tokens bleiben gültig).
# Nicht im Paket: .kern/index.sqlite (wird neu gebaut), .kern/secret (neue Instanz bekommt eigenen),
# .kern/upload/, Lesestände. Das OKF-Export (`kern export --okf`) ist der offene Austausch mit
# fremden Werkzeugen; für einen Umzug von Kern zu Kern ist es zu wenig, weil der OKF-Import
# Artikel als Vorschläge anlegt und Benutzer, Verlauf und Eingang nicht mitnimmt.
#
# Verschlüsseln für den Transport (empfohlen, Schlüssel hat nur der Kunde):
#   age -p -o paket.tar.gz.age paket.tar.gz
set -eu

befehl="${1:-}"
case "$befehl" in
  packen)
    quelle="${2:?Datenordner fehlt}"; ziel="${3:?Zieldatei fehlt}"
    [ -f "$quelle/kern.yaml" ] || { echo "Kein Kern-Datenordner: $quelle" >&2; exit 2; }
    git -C "$quelle" status --porcelain | grep -q . && { echo "Nicht übernommene Änderungen im Datenordner. Erst Server anhalten oder 'kern pruefen' laufen lassen." >&2; exit 3; }
    tmp="$(mktemp -d)"
    trap 'rm -rf "$tmp"' EXIT
    # Prüfsummenliste über alle Dateien, die ins Paket gehen (ohne .git-Interna, die prüft git fsck)
    ( cd "$quelle" && find . -type f ! -path './.git/*' ! -path './.kern/*' -print0 | sort -z | xargs -0 sha256sum ) > "$tmp/UMZUG-SHA256SUMS"
    for f in users.json tokens.json; do
      [ -f "$quelle/.kern/$f" ] && ( cd "$quelle" && sha256sum ".kern/$f" ) >> "$tmp/UMZUG-SHA256SUMS"
    done
    git -C "$quelle" rev-parse HEAD > "$tmp/UMZUG-HEAD"
    date -u +%Y-%m-%dT%H:%M:%SZ > "$tmp/UMZUG-ERSTELLT"
    tar -C "$quelle" --exclude='./.kern/index.sqlite*' --exclude='./.kern/secret' --exclude='./.kern/upload' \
        --exclude='./.kern/erstzugang' --exclude='./.kern/lesen' -czf "$tmp/daten.tar.gz" .
    tar -C "$tmp" -czf "$ziel" UMZUG-SHA256SUMS UMZUG-HEAD UMZUG-ERSTELLT daten.tar.gz
    echo "Umzugspaket: $ziel ($(wc -c < "$ziel") Bytes), sha256 $(sha256sum "$ziel" | cut -d' ' -f1)"
    echo "HEAD $(cat "$tmp/UMZUG-HEAD"), $(wc -l < "$tmp/UMZUG-SHA256SUMS") Dateien in der Prüfliste"
    ;;
  auspacken)
    paket="${2:?Paket fehlt}"; ziel="${3:?Datenordner fehlt}"
    [ -e "$ziel/kern.yaml" ] && { echo "Ziel enthält schon einen Datenordner: $ziel" >&2; exit 2; }
    mkdir -p "$ziel"
    tmp="$(mktemp -d)"
    trap 'rm -rf "$tmp"' EXIT
    tar -C "$tmp" -xzf "$paket"
    tar -C "$ziel" -xzf "$tmp/daten.tar.gz"
    cp "$tmp/UMZUG-SHA256SUMS" "$tmp/UMZUG-HEAD" "$ziel/.kern/" 2>/dev/null || { mkdir -p "$ziel/.kern"; cp "$tmp/UMZUG-SHA256SUMS" "$tmp/UMZUG-HEAD" "$ziel/.kern/"; }
    echo "Ausgepackt nach $ziel. Weiter mit: umzug.sh pruefen $ziel"
    ;;
  pruefen)
    ordner="${2:?Datenordner fehlt}"
    fehler=0
    echo "1/4 Prüfsummen"
    ( cd "$ordner" && sha256sum --quiet -c .kern/UMZUG-SHA256SUMS ) || fehler=1
    echo "2/4 Versionsgeschichte"
    git -C "$ordner" fsck --no-progress --no-dangling >/dev/null || fehler=1
    [ "$(git -C "$ordner" rev-parse HEAD)" = "$(cat "$ordner/.kern/UMZUG-HEAD")" ] || { echo "HEAD weicht ab" >&2; fehler=1; }
    echo "3/4 Index neu bauen"
    kern -d "$ordner" reindex || fehler=1
    echo "4/4 Konsistenz (kern pruefen)"
    kern -d "$ordner" pruefen --json > "$ordner/.kern/umzug-pruefbericht.json" || true
    node -e "const b=require(process.argv[1]);const f=b.befunde.filter(x=>x.schwere==='fehler');console.log('Befunde:',b.befunde.length,'davon Fehler:',f.length);process.exit(f.length?1:0)" "$ordner/.kern/umzug-pruefbericht.json" || fehler=1
    sha256sum "$ordner/.kern/umzug-pruefbericht.json" | cut -d' ' -f1 > "$ordner/.kern/umzug-pruefbericht.sha256"
    if [ "$fehler" = 0 ]; then echo "UMZUG OK. Prüfbericht-sha256: $(cat "$ordner/.kern/umzug-pruefbericht.sha256")"; else echo "UMZUG NICHT OK" >&2; exit 1; fi
    ;;
  *)
    echo "Aufruf: umzug.sh packen <ordner> <paket.tar.gz> | auspacken <paket.tar.gz> <ordner> | pruefen <ordner>" >&2; exit 64 ;;
esac
