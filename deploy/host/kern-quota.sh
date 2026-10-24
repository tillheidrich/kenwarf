#!/bin/sh
# Plattenkontingent je Instanz über XFS-Projektkontingente (O1 1.8.1). Docker-Volumes ohne Kontingent wären
# eine offene Flanke: ein Kunde füllt die Platte für alle.
#
# Voraussetzung (einmal, cloud-init): eigenes Datengerät mit XFS, eingehängt mit prjquota, z. B.
#   mkfs.xfs /dev/sdb && echo '/dev/sdb /srv/kern xfs defaults,prjquota 0 2' >> /etc/fstab && mount /srv/kern
#
#   kern-quota.sh pruefen  <mountpunkt>                       ist prjquota aktiv? (Exit 0 ja, 3 nein)
#   kern-quota.sh setzen   <mountpunkt> <ordner> <id> <grenze>  Projekt anlegen und harte Grenze setzen (z. B. 5g)
#   kern-quota.sh zeigen   <mountpunkt> <id>                  Belegung in Bytes (eine Zahl)
#   kern-quota.sh loeschen <mountpunkt> <id>                  Grenze aufheben (beim Löschen der Instanz)
# Projektnummer: aus der Instanz-ID abgeleitet (CRC, 1..2^31), damit kein Zähler gepflegt werden muss; Kollision
# wird geprüft. KERN_TROCKEN=1 zeigt die Befehle nur an.
set -eu
lauf() { if [ "${KERN_TROCKEN:-0}" = 1 ]; then echo "+ $*"; else "$@"; fi; }
projid() { printf '%s' "$1" | cksum | awk '{ print ($1 % 2147483646) + 1 }'; }

befehl="${1:-}"; mp="${2:-}"
case "$befehl" in
  pruefen)
    [ -n "$mp" ] || exit 64
    if [ "${KERN_TROCKEN:-0}" = 1 ]; then echo "+ xfs_quota -x -c 'state -p' $mp"; exit 0; fi
    findmnt -n -o FSTYPE,OPTIONS --target "$mp" 2>/dev/null | grep -q '^xfs .*prjquota' && exit 0
    findmnt -n -o FSTYPE,OPTIONS --target "$mp" 2>/dev/null | grep -q '^xfs .*pquota' && exit 0
    echo "kein XFS mit prjquota unter $mp" >&2; exit 3 ;;
  setzen)
    ordner="${3:?ordner}"; id="${4:?id}"; grenze="${5:?grenze}"
    echo "$id" | grep -Eq '^i_[a-z0-9]{10}$' || { echo "ungültige ID" >&2; exit 2; }
    echo "$grenze" | grep -Eq '^[0-9]+[kmgt]?$' || { echo "ungültige Grenze" >&2; exit 2; }
    p="$(projid "$id")"
    if [ -f /etc/projid ] && grep -q ":$p\$" /etc/projid && ! grep -q "^kern-$id:$p\$" /etc/projid; then echo "Projektnummer $p belegt" >&2; exit 4; fi
    [ "${KERN_TROCKEN:-0}" = 1 ] || { grep -q "^kern-$id:" /etc/projid 2>/dev/null || echo "kern-$id:$p" >> /etc/projid; grep -q "^$p:" /etc/projects 2>/dev/null || echo "$p:$ordner" >> /etc/projects; }
    lauf xfs_quota -x -c "project -s -p $ordner $p" "$mp"
    lauf xfs_quota -x -c "limit -p bsoft=$grenze bhard=$grenze $p" "$mp"
    echo "Kontingent $grenze für $id (Projekt $p)" ;;
  zeigen)
    id="${3:?id}"; p="$(projid "$id")"
    if [ "${KERN_TROCKEN:-0}" = 1 ]; then echo "+ xfs_quota -x -c 'quota -p -N -b $p' $mp"; exit 0; fi
    xfs_quota -x -c "quota -p -N -b $p" "$mp" | awk '{ print $2 * 1024; exit }' ;;
  loeschen)
    id="${3:?id}"; p="$(projid "$id")"
    lauf xfs_quota -x -c "limit -p bsoft=0 bhard=0 $p" "$mp"
    [ "${KERN_TROCKEN:-0}" = 1 ] || { sed -i "/^kern-$id:/d" /etc/projid 2>/dev/null || true; sed -i "/^$p:/d" /etc/projects 2>/dev/null || true; } ;;
  *) echo "Aufruf: kern-quota.sh pruefen|setzen|zeigen|loeschen ..." >&2; exit 64 ;;
esac
