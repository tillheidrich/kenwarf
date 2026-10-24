#!/bin/sh
# Entfernt Ballast aus node_modules der Laufzeit (nur im Image-Bau, Aufruf: schlank.sh <node_modules>).
# Jede Zeile hat einen Grund; geprüft wird das Ergebnis mit deploy/e2e-Rauchtest (PDF, DOCX, Suche, Antwort).
set -eu
NM="${1:?node_modules fehlt}"
arch="$(uname -m)"; case "$arch" in x86_64) a=x64 ;; aarch64) a=arm64 ;; *) a="$arch" ;; esac


vorher="$(du -sk "$NM" | cut -f1)"

# pdfjs-dist: @napi-rs/canvas ist optional und nur zum Zeichnen von Seiten nötig. Kern liest nur Text.
rm -rf "$NM/@napi-rs/canvas" "$NM"/@napi-rs/canvas-*
# pdfjs-dist: core lädt nur legacy/build/pdf.mjs (+ Worker). Moderne Builds, Viewer, Typen weg.
rm -rf "$NM/pdfjs-dist/build" "$NM/pdfjs-dist/web" "$NM/pdfjs-dist/types" "$NM/pdfjs-dist/image_decoders" \
       "$NM/pdfjs-dist/legacy/web" "$NM/pdfjs-dist/legacy/image_decoders"
# better-sqlite3: nur die Binärdatei dieser Plattform; C-Quellen (SQLite-Amalgamation) und Bauhilfen weg.
# Beide Linux-Varianten (glibc und musl) dieser Architektur bleiben, weil dieselbe Stufe Debian und Alpine beliefert.
if [ -d "$NM/better-sqlite3/prebuilds" ]; then
  find "$NM/better-sqlite3/prebuilds" -type f ! -name "linux-${a}.node" ! -name "linuxmusl-${a}.node" -delete
fi
rm -rf "$NM/better-sqlite3/deps" "$NM/better-sqlite3/src" "$NM/better-sqlite3/binding.gyp" "$NM/node-addon-api"
# zod liefert seinen Quelltext mit (src/), gebraucht werden nur die übersetzten Dateien.
rm -rf "$NM/zod/src"
# Allgemein: Quellkarten, Typen, Doku, Testordner
find "$NM" -type f \( -name '*.map' -o -name '*.d.ts' -o -name '*.d.mts' -o -name '*.d.cts' -o -name '*.md' -o -name '*.markdown' \
  -o -name 'CHANGELOG*' -o -name 'HISTORY*' -o -name '.npmignore' -o -name '.eslintrc*' -o -name 'tsconfig*.json' \) \
  ! -iname 'LICENSE*' ! -iname 'LICENCE*' ! -iname 'NOTICE*' -delete
find "$NM" -depth -type d \( -name test -o -name tests -o -name __tests__ -o -name docs -o -name example -o -name examples \) \
  -prune -exec rm -rf {} + 2>/dev/null || true
nachher="$(du -sk "$NM" | cut -f1)"
echo "schlank: node_modules ${vorher} KB -> ${nachher} KB"
