#!/usr/bin/env bash
# Prüft den geteilten Host Ende zu Ende in Docker (Sandbox oder Testmaschine, nie auf einem Produktivhost):
#   kern-host einrichten, zwei Instanzen anlegen, Netzsperre von innen (direkt, Proxy, nftables), Freigabe über die
#   Verwaltung (wie A1 /v1/instanzen/:id/egress), Caddy On-Demand-TLS mit Ask, Härtung der Container, Abruf durch core.
# Eine KI-Attrappe mit öffentlich aussehender Adresse (11.22.33.10) steht für einen Anbieter; Namen kommen aus
# extra_hosts des Proxys (compose.test.yml). Ergebnis: e2e/egress/ergebnis.json. Aufräumen am Ende (KEEP=1 lässt stehen).
#
#   KERN_IMAGE=kern:d2 e2e/egress/egress-test.sh
# Hinter einem Proxy: KERN_BUILD_ARGS="--network host --build-arg HTTPS_PROXY=$HTTPS_PROXY --build-arg HTTP_PROXY=$HTTP_PROXY"
# Ports: 4310 (HTTPS Caddy), 4311 (HTTP Caddy), 4313 (Verwaltung kern-egress), 4316 (Lauscher auf dem Host)
set -euo pipefail
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
T="${KERN_TEST_BASIS:-$(mktemp -d /tmp/kern-egress-test.XXXXXX)}"
export KERN_BASIS="$T" KERN_IMAGE="${KERN_IMAGE:-kern:latest}" KERN_EGRESS_IMAGE="${KERN_EGRESS_IMAGE:-kern-egress:test}"
export CADDY_IMAGE="${CADDY_IMAGE:-mirror.gcr.io/library/caddy:2}" KERN_MANAGED_DOMAIN=kern.test KERN_SUBDOMAIN_LABEL=2
export KERN_HTTP_BIND=127.0.0.1 KERN_HTTP_PORT=4311 KERN_HTTPS_PORT=4310 KERN_EGRESS_ADMIN_PORT=4313
export ACME_MAIL=betrieb@kern.test KERN_CADDY_GLOBAL="local_certs skip_install_trust" KERN_QUOTA=aus KERN_COMPOSE_ZUSATZ="$REPO/e2e/egress/compose.test.yml"
# curl soll direkt mit dem Testhost sprechen, nie über einen Proxy der Umgebung
export NO_PROXY='*' no_proxy='*'
NODE_ALPINE="${NODE_ALPINE_IMAGE:-mirror.gcr.io/library/node:22-alpine}"
HOSTKERN="$REPO/deploy/host/kern-host"
ERG="$REPO/e2e/egress/ergebnis.json"
I1=i_d2test0001; I2=i_d2test0002
LAUSCHER_PID=""

aufraeumen() {
  [ "${KEEP:-0}" = 1 ] && { echo "KEEP=1: Testaufbau bleibt stehen ($T)" >&2; return; }
  "$HOSTKERN" entfernen "$I1" --daten-loeschen >/dev/null 2>&1 || true
  "$HOSTKERN" entfernen "$I2" --daten-loeschen >/dev/null 2>&1 || true
  docker compose -p kern-host -f "$REPO/deploy/host/compose.yml" -f "$KERN_COMPOSE_ZUSATZ" down >/dev/null 2>&1 || true
  docker rm -f d2-ki-attrappe >/dev/null 2>&1 || true
  docker network rm d2-ki-netz kern-aussen >/dev/null 2>&1 || true
  [ -n "$LAUSCHER_PID" ] && kill "$LAUSCHER_PID" 2>/dev/null || true
  "$REPO/deploy/host/nft-kern.sh" entfernen || true
  rm -rf "$T"
}
trap aufraeumen EXIT

echo "1/8 Images" >&2
# shellcheck disable=SC2086
docker build -q ${KERN_BUILD_ARGS:-} -t "$KERN_EGRESS_IMAGE" --build-arg NODE_ALPINE_IMAGE="$NODE_ALPINE" --build-arg ALPINE_IMAGE=mirror.gcr.io/library/alpine:3.22 "$REPO/deploy/egress" >/dev/null
docker image inspect "$KERN_IMAGE" >/dev/null

echo "2/8 KI-Attrappe mit Zertifikat" >&2
mkdir -p "$T/attrappe"
openssl req -x509 -newkey rsa:2048 -nodes -days 2 -subj "/CN=Kern Test CA" -keyout "$T/attrappe/ca.key" -out "$T/attrappe/ca.pem" 2>/dev/null
openssl req -newkey rsa:2048 -nodes -subj "/CN=api.mistral.ai" -keyout "$T/attrappe/key.pem" -out "$T/attrappe/req.csr" 2>/dev/null
printf 'subjectAltName=DNS:api.mistral.ai,DNS:eigene-ki.example,DNS:nicht-erlaubt.example\n' > "$T/attrappe/san.ext"
openssl x509 -req -in "$T/attrappe/req.csr" -CA "$T/attrappe/ca.pem" -CAkey "$T/attrappe/ca.key" -CAcreateserial -days 2 -extfile "$T/attrappe/san.ext" -out "$T/attrappe/cert.pem" 2>/dev/null
chmod 0644 "$T/attrappe/"*.pem
docker network create --subnet 11.22.33.0/24 d2-ki-netz >/dev/null
docker run -d --name d2-ki-attrappe --network d2-ki-netz --ip 11.22.33.10 --read-only --cap-drop ALL --cap-add NET_BIND_SERVICE \
  -e ATTRAPPE_CERT=/a/cert.pem -e ATTRAPPE_KEY=/a/key.pem -v "$T/attrappe:/a:ro" -v "$REPO/e2e/egress/ki-attrappe.mjs:/a.mjs:ro" \
  "$NODE_ALPINE" node /a.mjs >/dev/null

echo "3/8 Lauscher auf dem Host (zeigt, dass nicht der geschlossene Port, sondern die Sperre greift)" >&2
python3 -m http.server 4316 --bind 0.0.0.0 >/dev/null 2>&1 &
LAUSCHER_PID=$!

echo "4/8 Host einrichten und zwei Instanzen anlegen" >&2
"$HOSTKERN" einrichten >/dev/null
A1="$("$HOSTKERN" anlegen "$I1" tischlerei test --betrieb "Tischlerei Test")"
A2="$("$HOSTKERN" anlegen "$I2" baeckerei test --web-offen 0 --betrieb "Bäckerei Test")"
tok() { grep "^HTTPS_PROXY=" "$T/instanzen/$1/instanz.env" | sed -E 's#.*://[^:]+:([^@]+)@.*#\1#'; }
T1="$(tok $I1)"; T2="$(tok $I2)"
IP2="$(jq -r .ip <<< "$A2")"; GW1="$(jq -r .netz <<< "$A1" | sed -E 's#\.([0-9]+)/28#.\1#' | awk -F. '{print $1"."$2"."$3"."$4+1}')"
docker exec -i "kern-$I1" sh -c 'cat > /tmp/ca.pem' < "$T/attrappe/ca.pem"

im() { # phase [extra env...]
  local phase="$1"; shift
  docker exec -i -e PHASE="$phase" -e EGRESS_ID="$I1" -e EGRESS_TOKEN="$T1" -e FREMD_ID="$I2" -e FREMD_TOKEN="$T2" -e FREMD_IP="$IP2" \
    -e GATEWAY_IP="$GW1" -e HOST_PORT=4316 -e STANDIN_IP=11.22.33.10 -e NODE_EXTRA_CA_CERTS=/tmp/ca.pem "$@" "kern-$I1" node --input-type=module - < "$REPO/e2e/egress/im-container.mjs"
}

echo "5/8 Sperren von innen" >&2
P1="$(im vor_freigabe)"
P_FETCH="$(im fetch)"
ADMIN="$(cat "$T/egress/admin-token")"
F_PUT="$(curl -sS -X POST -H "authorization: Bearer $ADMIN" -H 'content-type: application/json' --data '{"host":"eigene-ki.example","grund":"Kunde: eigener vLLM-Endpunkt (Test)"}' "http://127.0.0.1:4313/v1/instanzen/$I1/egress")"
P2="$(im nach_freigabe)"
F_DEL="$(curl -sS -X DELETE -H "authorization: Bearer $ADMIN" "http://127.0.0.1:4313/v1/instanzen/$I1/egress/eigene-ki.example")"
P3="$(im nach_widerruf)"
"$REPO/deploy/host/nft-kern.sh" entfernen
P4="$(im ohne_nft)"
"$REPO/deploy/host/nft-kern.sh" anwenden >&2
P5="$(im vor_freigabe | jq -c '{phase:"wieder_mit_nft", pruefungen:[.pruefungen[] | select(.name|startswith("direkt: Host"))]}')"
F_OHNE="$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:4313/v1/instanzen/$I1/egress")"
# Registrierung über die Verwaltung (für einen Leitstand auf einer anderen Maschine, Abstimmung mit A1/P2)
SHA0="$(printf 'x%.0s' $(seq 64) | sed 's/x/a/g')"
R_PUT="$(curl -s -o /dev/null -w '%{http_code}' -X PUT -H "authorization: Bearer $ADMIN" -H 'content-type: application/json' --data "{\"subdomain\":\"leitstand-test\",\"token_sha256\":\"$SHA0\",\"netz_ip\":\"10.231.9.3\",\"web_offen\":false}" http://127.0.0.1:4313/v1/instanzen/i_d2test0003)"
R_DOPPELT="$(curl -s -o /dev/null -w '%{http_code}' -X PUT -H "authorization: Bearer $ADMIN" -H 'content-type: application/json' --data "{\"subdomain\":\"tischlerei\",\"token_sha256\":\"$SHA0\",\"web_offen\":false}" http://127.0.0.1:4313/v1/instanzen/i_d2test0004)"
R_ASK="$(curl -s -o /dev/null -w '%{http_code}' --resolve leitstand-test.kern.test:4310:127.0.0.1 -k https://leitstand-test.kern.test:4310/ ; true)"
R_DEL="$(curl -s -o /dev/null -w '%{http_code}' -X DELETE -H "authorization: Bearer $ADMIN" http://127.0.0.1:4313/v1/instanzen/i_d2test0003)"
R_WEG="$(curl -s -o /dev/null -w '%{http_code}' -H "authorization: Bearer $ADMIN" http://127.0.0.1:4313/v1/instanzen/i_d2test0003)"

echo "6/8 Caddy: On-Demand-TLS nur für bekannte Instanzen" >&2
c_bekannt="$(curl -sk -o /dev/null -w '%{http_code}' --resolve tischlerei.kern.test:4310:127.0.0.1 https://tischlerei.kern.test:4310/healthz || true)"
c_betrieb="$(curl -sk -o /dev/null -w '%{http_code}' --resolve tischlerei.kern.test:4310:127.0.0.1 https://tischlerei.kern.test:4310/_betrieb/status || true)"
c_unbekannt="$(curl -sk -o /dev/null -w '%{http_code}' --resolve fremd.kern.test:4310:127.0.0.1 https://fremd.kern.test:4310/healthz 2>/dev/null || true)"
c_http="$(curl -s -o /dev/null -w '%{http_code}' --resolve tischlerei.kern.test:4311:127.0.0.1 http://tischlerei.kern.test:4311/ || true)"
c_hsts="$(curl -skI --resolve tischlerei.kern.test:4310:127.0.0.1 https://tischlerei.kern.test:4310/ | grep -ci '^strict-transport-security' || true)"

echo "7/8 core-Abruf über den Proxy (Hinzufügen per URL) und Härtung" >&2
PW="$(cat "$T/instanzen/$I1/daten/.kern/erstzugang")"
JAR="$T/cookies"; BASIS="https://tischlerei.kern.test:4310"; RES=(--resolve tischlerei.kern.test:4310:127.0.0.1)
curl -sk "${RES[@]}" -c "$JAR" -H 'x-kern: 1' -H 'content-type: application/json' --data "{\"name\":\"admin\",\"passwort\":\"$PW\"}" "$BASIS/api/login" >/dev/null
k_meta="$(curl -sk "${RES[@]}" -b "$JAR" -o /dev/null -w '%{http_code}' -H 'x-kern: 1' -H 'content-type: application/json' --data '{"art":"web","url":"http://169.254.169.254/latest/meta-data/"}' "$BASIS/api/hinzufuegen")"
k_intern="$(curl -sk "${RES[@]}" -b "$JAR" -o /dev/null -w '%{http_code}' -H 'x-kern: 1' -H 'content-type: application/json' --data '{"art":"web","url":"https://boese.example/"}' "$BASIS/api/hinzufuegen")"
H="$("$HOSTKERN" status "$I1")"
SECCOMP="$(docker exec "kern-$I1" grep -E '^(Seccomp|NoNewPrivs|CapEff):' /proc/self/status | tr '\n' ' ')"
UID_IN="$(docker exec "kern-$I1" id -u)"
SCHREIBEN="$(docker exec "kern-$I1" sh -c 'touch /app/x 2>/dev/null && echo schreibbar || echo nur_lesen')"

echo "8/8 nftables-Zähler" >&2
NFT="$(nft list table inet kern_instanzen 2>/dev/null | grep -E 'counter packets' | sed -E 's/^\s+//' | tr '\n' ';' || true)"
PROXY_LOG="$(docker logs kern-egress 2>/dev/null | grep -c '"ergebnis":"gesperrt"' || true)"

jq -n --argjson p1 "$P1" --argjson pf "$P_FETCH" --argjson p2 "$P2" --argjson p3 "$P3" --argjson p4 "$P4" --argjson p5 "$P5" --arg fput "$F_PUT" --arg fdel "$F_DEL" --arg fohne "$F_OHNE" --arg rput "$R_PUT" --arg rdop "$R_DOPPELT" --arg rask "$R_ASK" --arg rdel "$R_DEL" --arg rweg "$R_WEG" \
  --arg cb "$c_bekannt" --arg cbt "$c_betrieb" --arg cu "$c_unbekannt" --arg ch "$c_http" --arg chsts "$c_hsts" --arg km "$k_meta" --arg ki "$k_intern" \
  --argjson h "$H" --arg sec "$SECCOMP" --arg uid "$UID_IN" --arg schreiben "$SCHREIBEN" --arg nft "$NFT" --arg pl "$PROXY_LOG" \
  --arg image "$KERN_IMAGE" --arg am "$(date -u +%Y-%m-%dT%H:%M:%SZ)" '
  def pr(n; e; i): {name:n, erwartet:e, ergebnis:i, ok:(e==i)};
  ($p1.pruefungen + $pf.pruefungen + $p2.pruefungen + $p3.pruefungen + $p4.pruefungen + $p5.pruefungen + [
    pr("verwaltung: Freigabe anlegen"; true; ($fput|fromjson|.hosts|map(.host)|index("eigene-ki.example")) != null),
    pr("verwaltung: Freigabe widerrufen"; true; ($fdel|fromjson|.hosts|map(.host)|index("eigene-ki.example")) == null),
    pr("verwaltung: ohne Token"; "401"; $fohne),
    pr("verwaltung: Instanz registrieren (PUT)"; "200"; $rput),
    pr("verwaltung: Subdomain doppelt"; "409"; $rdop),
    pr("caddy: registrierte Subdomain bekommt Zertifikat (Ziel fehlt, daher 502)"; "502"; $rask),
    pr("verwaltung: Registrierung löschen"; "200"; $rdel),
    pr("verwaltung: danach unbekannt"; "404"; $rweg),
    pr("caddy: bekannte Instanz https"; "200"; $cb),
    pr("caddy: /_betrieb/* von außen"; "404"; $cbt),
    pr("caddy: unbekannte Subdomain bekommt kein Zertifikat"; "000"; $cu),
    pr("caddy: http leitet auf https"; "308"; $ch),
    pr("instanz: HSTS gesetzt"; "1"; $chsts),
    pr("core: Hinzufügen http://169.254.169.254 abgelehnt"; true; ($km != "201")),
    pr("core: Hinzufügen boese.example (privat nach DNS) abgelehnt"; true; ($ki != "201")),
    pr("härtung: Wurzeldateisystem nur lesend"; "nur_lesen"; $schreiben),
    pr("härtung: kein root"; "1000"; $uid),
    pr("härtung: cap_drop ALL"; ["ALL"]; $h.caps),
    pr("härtung: kein Swap (swap = ram)"; true; ($h.grenzen.swap == $h.grenzen.ram)),
    pr("härtung: seccomp aktiv, no-new-privs, keine Fähigkeiten"; true; ($sec|test("Seccomp:\\s+2") and test("NoNewPrivs:\\s+1") and test("CapEff:\\s+0+ "))) ]) as $alle
  | { am:$am, image:$image, bestanden:($alle|all(.ok)), anzahl:($alle|length), fehlgeschlagen:($alle|map(select(.ok|not))),
      pruefungen:$alle, core_http:{meta:$km, boese:$ki}, nft_zaehler:$nft, proxy_gesperrt_zeilen:($pl|tonumber), instanz_status:$h }' > "$ERG"
jq -r '"bestanden: \(.bestanden) (\(.anzahl) Prüfungen)", (.fehlgeschlagen[] | "FEHLER: \(.name): erwartet \(.erwartet), ist \(.ergebnis)")' "$ERG"
jq -e .bestanden "$ERG" >/dev/null
