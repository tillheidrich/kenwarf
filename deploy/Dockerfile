# Kern (Arbeitstitel): ein Container mit Weboberfläche, REST-API, MCP und CLI.
#
# Bauen aus dem Repo-Wurzelordner:
#   docker build -f deploy/Dockerfile -t kern:dev .                          # Standard: Debian (glibc, mit sqlite-vec)
#   docker build -f deploy/Dockerfile --target laufzeit-alpine -t kern:alpine .   # kleiner, Vektorsuche in JS
# Hinter einem TLS-prüfenden Firmen-Proxy (Systemhaus, Behörde):
#   docker build -f deploy/Dockerfile --network host \
#     --build-arg HTTPS_PROXY=$HTTPS_PROXY --secret id=ca,src=/pfad/firmen-ca.pem -t kern:dev .
# Basis-Images austauschbar (Docker Hub drosselt, Spiegel z. B. mirror.gcr.io/library/...):
#   --build-arg NODE_IMAGE=... --build-arg DEBIAN_IMAGE=... --build-arg NODE_ALPINE_IMAGE=... --build-arg ALPINE_IMAGE=...
#
# Aufbau (D2, 24.10.2026): Bau und Laufzeit sind getrennt. Die Laufzeit startet nicht vom Node-Image
# (das bringt npm, corepack, yarn und Header mit), sondern von einem nackten Debian bzw. Alpine, in das
# nur die Node-Binärdatei kopiert wird. Abhängigkeiten werden ohne Entwicklungspakete neu installiert und
# danach von Ballast befreit (fremde Plattform-Binärdateien, Quelltexte nativer Module, Karten, Typen).
# Messung und Begründung: deploy/README.md, Abschnitt „Image“.

ARG NODE_IMAGE=node:22-bookworm-slim
ARG DEBIAN_IMAGE=debian:bookworm-slim
ARG NODE_ALPINE_IMAGE=node:22-alpine
ARG ALPINE_IMAGE=alpine:3.22

# ---------- Nur die package.json aller Workspaces (für den Cache der Installation) ----------
# Welche Pakete es gibt, ändert sich im Repo; die Liste wird deshalb nicht von Hand gepflegt.
FROM ${NODE_IMAGE} AS manifeste
COPY packages /p
RUN set -eu; for f in /p/*/package.json; do d="/m/packages/$(basename "$(dirname "$f")")"; mkdir -p "$d"; cp "$f" "$d/"; done

# ---------- Bau (alle Abhängigkeiten, TypeScript, Vite) ----------
FROM ${NODE_IMAGE} AS bau
WORKDIR /src
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 npm_config_fund=false npm_config_audit=false npm_config_update_notifier=false
COPY package.json package-lock.json ./
COPY --from=manifeste /m/ ./
# --ignore-scripts: better-sqlite3 13 bringt fertige Binärdateien (prebuilds/) mit; ohne den Schalter
# startet npm wegen binding.gyp einen unnötigen Compilerlauf. Firmen-CA nur als Build-Secret, nie im Image.
RUN --mount=type=secret,id=ca,required=false \
    if [ -s /run/secrets/ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/ca npm_config_cafile=/run/secrets/ca; fi; \
    npm ci --no-audit --no-fund --ignore-scripts
COPY packages/core packages/core
COPY packages/server packages/server
COPY packages/cli packages/cli
COPY packages/web packages/web
# Feste Reihenfolge core -> server -> cli -> web
RUN npm run build -w packages/core \
 && npm run build -w packages/server \
 && npm exec -w packages/cli -- tsc -p tsconfig.json \
 && npm run build -w packages/web
# Nur, was zur Laufzeit gebraucht wird
RUN set -eu; mkdir -p /out/packages; \
    for p in core server cli; do \
      mkdir -p /out/packages/$p; cp packages/$p/package.json /out/packages/$p/; cp -r packages/$p/dist /out/packages/$p/dist; \
    done; \
    mkdir -p /out/packages/core/pruefung; cp -r packages/core/pruefung/oeffentlich /out/packages/core/pruefung/oeffentlich; \
    mkdir -p /out/packages/web; cp packages/web/package.json /out/packages/web/; cp -r packages/web/dist /out/packages/web/dist; \
    find /out -name '*.map' -delete; find /out -name '*.d.ts' -delete

# ---------- Laufzeit-Abhängigkeiten (ohne dev, ohne Ballast) ----------
# Aus dem Bau-Stand abgeleitet (gleiche Lockfile-Auflösung, kein zweiter Download).
FROM bau AS abh
RUN set -eu; npm prune --omit=dev --workspaces --include-workspace-root --no-audit --no-fund; \
    rm -f node_modules/@kern/betrieb node_modules/@kern/import-outline; \
    mkdir -p /app; cp package.json package-lock.json /app/; cp -a node_modules /app/node_modules
COPY deploy/scripts/schlank.sh /tmp/schlank.sh
RUN sh /tmp/schlank.sh /app/node_modules

# ---------- Laufzeit Debian (Standard am Ende der Datei) ----------
FROM ${DEBIAN_IMAGE} AS basis-debian
# git: Versionsgeschichte des Datenordners (Pflicht). tini: saubere Signale. ca-certificates: KI-Anbieter per HTTPS.
RUN --mount=type=secret,id=ca,required=false \
    set -eu; \
    if [ -s /run/secrets/ca ]; then \
      sed -i 's#http://deb.debian.org#https://deb.debian.org#g' /etc/apt/sources.list.d/debian.sources; \
      install -m 0644 /run/secrets/ca /tmp/firmen-ca.pem; \
      echo "Acquire::https::CAInfo \"/tmp/firmen-ca.pem\";" > /etc/apt/apt.conf.d/99firmen-ca; \
      if [ -n "${HTTPS_PROXY:-}" ]; then echo "Acquire::https::Proxy \"${HTTPS_PROXY}\";" >> /etc/apt/apt.conf.d/99firmen-ca; fi; \
    fi; \
    apt-get update; \
    apt-get install -y --no-install-recommends git tini ca-certificates libstdc++6; \
    # perl (gut 40 MB) braucht git nur für interaktive und Mail-Befehle, die Kern nie aufruft; perl-base bleibt.
    dpkg --purge --force-depends git-man liberror-perl perl perl-modules-5.36 libperl5.36 libgdbm-compat4 >/dev/null; \
    git --version >/dev/null; \
    rm -rf /var/lib/apt/lists/* /var/cache/apt/* /var/log/* /etc/apt/apt.conf.d/99firmen-ca /tmp/firmen-ca.pem \
           /usr/share/doc/* /usr/share/man/* /usr/share/info/* /usr/share/locale/* \
           /usr/share/git-core/templates/hooks/* /usr/lib/git-core/git-gui* /usr/lib/git-core/gitk* /usr/share/gitweb /usr/share/git-gui; \
    git config --system --add safe.directory '*'; \
    git config --system init.defaultBranch main; \
    groupadd -g 1000 node; useradd -u 1000 -g node -m -d /home/node -s /usr/sbin/nologin node; \
    ln -s /usr/bin/tini /sbin/tini-kern

# ---------- Laufzeit Alpine (kleiner; sqlite-vec hat keine musl-Binärdatei, core nimmt dann JS-Kosinus) ----------
FROM ${NODE_ALPINE_IMAGE} AS node-alpine
FROM ${ALPINE_IMAGE} AS laufzeit-alpine
RUN set -eu; apk add --no-cache git tini ca-certificates libstdc++ libgcc; \
    git config --system --add safe.directory '*'; git config --system init.defaultBranch main; \
    rm -rf /usr/share/git-core/templates/hooks/* /usr/libexec/git-core/git-gui* /usr/libexec/git-core/gitk*; \
    addgroup -g 1000 node; adduser -u 1000 -G node -D -h /home/node -s /sbin/nologin node; \
    ln -s /sbin/tini /sbin/tini-kern
COPY --from=node-alpine /usr/local/bin/node /usr/local/bin/node
WORKDIR /app
COPY --from=abh /app /app
COPY --from=bau /out/packages /app/packages
COPY deploy/scripts/einstieg.sh /usr/local/bin/kern-einstieg
COPY deploy/scripts/umzug.sh /usr/local/bin/kern-umzug
RUN chmod 0755 /usr/local/bin/kern-einstieg /usr/local/bin/kern-umzug /app/packages/cli/dist/cli.js \
 && ln -s /app/packages/cli/dist/cli.js /usr/local/bin/kern \
 && mkdir -p /daten /daten-export && chown node:node /daten /daten-export
ENV NODE_ENV=production KERN_DATA=/daten KERN_WEB_DIST=/app/packages/web/dist PORT=7480 HOST=0.0.0.0
USER 1000:1000
VOLUME ["/daten"]
EXPOSE 7480
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||7480)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
ENTRYPOINT ["/sbin/tini-kern", "--", "/usr/local/bin/kern-einstieg"]
CMD ["serve"]

# ---------- Laufzeit Debian, Standardziel ----------
FROM basis-debian AS laufzeit
COPY --from=bau /usr/local/bin/node /usr/local/bin/node
WORKDIR /app
COPY --from=abh /app /app
COPY --from=bau /out/packages /app/packages
COPY deploy/scripts/einstieg.sh /usr/local/bin/kern-einstieg
COPY deploy/scripts/umzug.sh /usr/local/bin/kern-umzug
RUN chmod 0755 /usr/local/bin/kern-einstieg /usr/local/bin/kern-umzug /app/packages/cli/dist/cli.js \
 && ln -s /app/packages/cli/dist/cli.js /usr/local/bin/kern \
 && mkdir -p /daten /daten-export && chown node:node /daten /daten-export
ENV NODE_ENV=production KERN_DATA=/daten KERN_WEB_DIST=/app/packages/web/dist PORT=7480 HOST=0.0.0.0
USER 1000:1000
VOLUME ["/daten"]
EXPOSE 7480
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||7480)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
ENTRYPOINT ["/sbin/tini-kern", "--", "/usr/local/bin/kern-einstieg"]
CMD ["serve"]
