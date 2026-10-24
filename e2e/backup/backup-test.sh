#!/usr/bin/env bash
# Prüft deploy/host/kern-backup mit echtem restic gegen zwei rest-server (append-only für den Host, mit Löschrecht
# für die Pflege) auf demselben Speicher. Eine Instanz läuft als Container kern-<id> mit Datenordner unter KERN_BASIS.
# Prüft: Sicherung, append-only (Host kann nicht löschen), Pflege, Wiederherstellungstest ok, beschädigtes Ziel wird
# erkannt, Schlüssel vernichten macht das Repository unlesbar. Ergebnis: e2e/backup/ergebnis.json.
#   KERN_IMAGE=kern:d2 RESTIC=/pfad/restic e2e/backup/backup-test.sh
# Ports (änderbar): P_INST=4317, P_ANH=4318 (rest-server append-only), P_PFL=4319 (rest-server Pflege)
set -euo pipefail
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
export NO_PROXY='*' no_proxy='*'
T="$(mktemp -d /tmp/kern-backup-test.XXXXXX)"
export KERN_BASIS="$T" KERN_IMAGE="${KERN_IMAGE:-kern:latest}" RESTIC="${RESTIC:-restic}"
P_INST="${P_INST:-4317}" P_ANH="${P_ANH:-4318}" P_PFL="${P_PFL:-4319}"
RS_IMAGE="${RS_IMAGE:-mirror.gcr.io/restic/rest-server:0.13.0}"
ID=i_d2backup01
ERG="$REPO/e2e/backup/ergebnis.json"
KB="$REPO/deploy/host/kern-backup"
aufraeumen() { docker rm -f "kern-$ID" d2-rest-anhaengen d2-rest-pflege >/dev/null 2>&1 || true; rm -rf "$T"; }
trap aufraeumen EXIT

mkdir -p "$T/instanzen/$ID/daten" "$T/ziel"; chown 1000:1000 "$T/instanzen/$ID/daten"
PW="$(head -c 12 /dev/urandom | od -An -tx1 | tr -d ' \n')"; echo -n "$PW" > "$T/pw"
docker run -d --name "kern-$ID" --read-only --tmpfs /tmp --cap-drop ALL --security-opt no-new-privileges:true --user 1000:1000 \
  -e KERN_ADMIN_PASSWORT="$PW" -p 127.0.0.1:${P_INST}:7480 -v "$T/instanzen/$ID/daten:/daten" "$KERN_IMAGE" >/dev/null
docker run -d --name d2-rest-anhaengen -p 127.0.0.1:${P_ANH}:8000 -v "$T/ziel:/data" "$RS_IMAGE" rest-server --path /data --no-auth --append-only >/dev/null
docker run -d --name d2-rest-pflege -p 127.0.0.1:${P_PFL}:8000 -v "$T/ziel:/data" "$RS_IMAGE" rest-server --path /data --no-auth >/dev/null
for i in $(seq 1 60); do [ "$(docker inspect -f '{{.State.Health.Status}}' "kern-$ID")" = healthy ] && break; sleep 0.5; done
node "$REPO/e2e/rauchtest/rauchtest.mjs" --url http://127.0.0.1:${P_INST} --passwort-datei "$T/pw" > "$T/rauch.json"
export KERN_BACKUP_ZIEL=rest:http://127.0.0.1:${P_ANH} KERN_BACKUP_PFLEGE_ZIEL=rest:http://127.0.0.1:${P_PFL}

S1="$("$KB" sichern "$ID")"
# zweiter Stand mit neuer Quelle (Rauchtest läuft erneut)
node "$REPO/e2e/rauchtest/rauchtest.mjs" --url http://127.0.0.1:${P_INST} --passwort-datei "$T/pw" >/dev/null
S2="$("$KB" sichern "$ID")"
# append-only: mit dem Host-Zugang (zwei Stände vorhanden) den älteren löschen wollen, muss scheitern
loesch_host="$(RESTIC_REPOSITORY="$KERN_BACKUP_ZIEL/$ID" RESTIC_PASSWORD_FILE="$T/geheim/backup/$ID.pass" timeout 30 "$RESTIC" forget --keep-last 1 --prune -q >/dev/null 2>&1 && echo geloescht || echo verweigert)"
P="$("$KB" pflege "$ID")"
W1="$("$KB" test "$ID" || true)"
L="$("$KB" liste "$ID")"
# Beschädigung: eine Datendatei im Ziel entfernen, der Test muss das melden
mv "$T/ziel/$ID/data" "$T/data.weg"; mkdir -p "$T/ziel/$ID/data"; for d in $(ls "$T/data.weg"); do mkdir -p "$T/ziel/$ID/data/$d"; done
W2="$(KERN_BACKUP_RESTORE_MAX=30 "$KB" test "$ID" 2>/dev/null || true)"
rm -rf "$T/ziel/$ID/data"; mv "$T/data.weg" "$T/ziel/$ID/data"
V="$("$KB" vernichten "$ID")"
nach_vernichten="$(RESTIC_REPOSITORY="$KERN_BACKUP_ZIEL/$ID" RESTIC_PASSWORD_FILE=/dev/null "$RESTIC" snapshots -q >/dev/null 2>&1 && echo lesbar || echo unlesbar)"
reste="$(find "$T/ziel/$ID/data" -type f 2>/dev/null | wc -l)"

jq -n --argjson s1 "$S1" --argjson s2 "$S2" --argjson p "$P" --argjson w1 "$W1" --argjson w2 "$W2" --argjson v "$V" --argjson l "$L" \
  --arg lh "$loesch_host" --arg nv "$nach_vernichten" --arg reste "$reste" --argjson rauch "$(cat "$T/rauch.json")" --arg image "$KERN_IMAGE" \
  --arg restic "$("$RESTIC" version | cut -d' ' -f1-2)" --arg am "$(date -u +%Y-%m-%dT%H:%M:%SZ)" '
  def pr(n; e; i): {name:n, erwartet:e, ergebnis:i, ok:(e==i)};
  [ pr("Instanz mit Inhalt (Rauchtest)"; true; $rauch.bestanden),
    pr("sichern 1"; true; $s1.ok), pr("SQLite-Kopien in der Sicherung"; true; ($s1.sqlite_kopien >= 1)),
    pr("append-only: Host kann Sicherungen nicht löschen"; "verweigert"; $lh),
    pr("sichern 2 (inkrementell)"; true; ($s2.ok and $s2.snapshot != $s1.snapshot)),
    pr("pflege (Aufbewahrung, Stichprobe)"; true; $p.ok),
    pr("Wiederherstellungstest"; "ok"; $w1.ergebnis),
    pr("Wiederherstellungstest erkennt beschädigtes Ziel"; "fehler"; $w2.ergebnis),
    pr("zwei Schnappschüsse gelistet"; 2; ($l|length)),
    pr("vernichten: Schlüssel weg"; "vernichtet"; $v.schluessel),
    pr("vernichten: Repository ohne Schlüssel unlesbar"; "unlesbar"; $nv),
    pr("vernichten: Daten am Ziel entfernt (Pflegezugang)"; "0"; $reste) ] as $alle
  | {am:$am, image:$image, restic:$restic, bestanden:($alle|all(.ok)), pruefungen:$alle, sichern:[$s1,$s2], test_ok:$w1, test_beschaedigt:$w2}' > "$ERG"
jq -r '"bestanden: \(.bestanden)", (.pruefungen[] | select(.ok|not) | "FEHLER: \(.name): erwartet \(.erwartet), ist \(.ergebnis)")' "$ERG"
jq -e .bestanden "$ERG" >/dev/null
