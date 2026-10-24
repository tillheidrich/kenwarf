#!/bin/sh
# Zweite Netzsperre auf dem Host (O1 1.8.2): Instanznetze kommen nur an Caddy und den Egress-Proxy im eigenen Netz.
#
#   nft-kern.sh anwenden     Tabelle inet kern_instanzen neu schreiben (atomar), nach jedem Anlegen/Entfernen
#   nft-kern.sh zeigen       Regeln und Zähler anzeigen
#   nft-kern.sh entfernen    Tabelle löschen (nur zur Fehlersuche)
#
# Warum eine eigene nftables-Tabelle statt Regeln in DOCKER-USER: Docker schreibt seine Ketten bei jedem Neustart neu
# und kennt DOCKER-USER nur im iptables-Modell. Eine eigene Tabelle mit eigener Basiskette an den Hooks forward und
# input (Priorität -10, vor Docker) wird von Docker nie angefasst; ein "drop" in irgendeiner Basiskette ist endgültig,
# Dockers "accept" kann ihn nicht aufheben. Für Hosts, auf denen Docker iptables-legacy nutzt, legt "anwenden"
# zusätzlich eine gleichwertige Regel in DOCKER-USER an (falls die Kette existiert).
#
# Regeln (Instanz-Bridges heißen kb-<10 Zeichen>, gesetzt von kern-host):
#   forward: aus einer Instanz-Bridge nur in dieselbe Bridge (Caddy, Proxy); alles andere verworfen, auch zu
#            anderen Instanz-Bridges; von außen in eine Instanz-Bridge ebenso verworfen.
#   input:   aus Instanz-Bridges an den Host nur Antworten auf Verbindungen, die der Host geöffnet hat
#            (Leitstand ruft /_betrieb/* auf); neue Verbindungen zum Host (sshd, Docker-API, Metadaten) verworfen.
# Sicherer Ausfall: Fehlt der Proxy, gibt es keinen Weg nach draußen; fehlt diese Tabelle, hält noch das
# Docker-Netz "internal: true".
set -eu
TABELLE=kern_instanzen

bruecken() { ls /sys/class/net 2>/dev/null | grep '^kb-' || true; }

regeln() {
  echo "table inet $TABELLE {"
  echo "  chain vorwaerts {"
  echo "    type filter hook forward priority -10; policy accept;"
  for b in $(bruecken); do
    echo "    iifname \"$b\" oifname \"$b\" accept"
  done
  echo "    iifname \"kb-*\" counter drop comment \"Instanznetz nach außen oder in fremde Instanz\""
  echo "    oifname \"kb-*\" counter drop comment \"von außen direkt in ein Instanznetz\""
  echo "  }"
  echo "  chain eingang {"
  echo "    type filter hook input priority -10; policy accept;"
  echo "    iifname \"kb-*\" ct state established,related accept"
  echo "    iifname \"kb-*\" counter drop comment \"Instanz an den Host\""
  echo "  }"
  echo "}"
}

case "${1:-}" in
  anwenden)
    command -v nft >/dev/null || { echo "nft fehlt (apt install nftables)" >&2; exit 2; }
    tmp="$(mktemp)"; trap 'rm -f "$tmp"' EXIT
    { nft list table inet "$TABELLE" >/dev/null 2>&1 && echo "delete table inet $TABELLE"; regeln; } > "$tmp"
    nft -f "$tmp"
    if command -v iptables-legacy >/dev/null 2>&1 && iptables-legacy -L DOCKER-USER >/dev/null 2>&1; then
      iptables-legacy -C DOCKER-USER -i kb-+ ! -o kb-+ -j DROP 2>/dev/null || iptables-legacy -I DOCKER-USER -i kb-+ ! -o kb-+ -j DROP
    fi
    echo "nft: Tabelle inet $TABELLE mit $(bruecken | wc -l) Instanz-Bridges"
    ;;
  beobachten)
    # Dauerdienst (systemd kern-nft.service): schreibt die Tabelle bei jedem Anlegen/Entfernen eines Instanznetzes neu,
    # auch wenn ein Leitstand über die Docker-API statt über kern-host anlegt. Dazu stündlich als Rückfall (Timer).
    "$0" anwenden
    docker events --filter type=network --filter label=kern.instanz --filter event=create --filter event=destroy --format '{{.Action}}' |
      while read -r _; do sleep 1; "$0" anwenden || true; done ;;
  zeigen) nft list table inet "$TABELLE" ;;
  entfernen) nft delete table inet "$TABELLE" 2>/dev/null || true ;;
  regeln) regeln ;;
  *) echo "Aufruf: nft-kern.sh anwenden|zeigen|entfernen|regeln" >&2; exit 64 ;;
esac
