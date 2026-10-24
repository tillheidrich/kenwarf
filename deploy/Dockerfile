# Kern (Arbeitstitel): ein Container mit Weboberfläche, REST-API, MCP und CLI.
# Bauen aus dem Repo-Wurzelordner:
#   docker build -f deploy/Dockerfile -t kern:dev .
# Hinter einem TLS-prüfenden Firmen-Proxy (Systemhaus, Behörde):
#   docker build -f deploy/Dockerfile --network host \
#     --build-arg HTTPS_PROXY=$HTTPS_PROXY --secret id=ca,src=/pfad/firmen-ca.pem -t kern:dev .
# Basis-Image austauschbar, z. B. --build-arg NODE_IMAGE=mirror.gcr.io/library/node:22-bookworm-slim

ARG NODE_IMAGE=node:22-bookworm-slim

# ---------- Bau ----------
FROM ${NODE_IMAGE} AS bau
WORKDIR /src
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 \
    npm_config_fund=false \
    npm_config_audit=false \
    npm_config_update_notifier=false
COPY package.json package-lock.json ./
COPY packages/core/package.json packages/core/
COPY packages/server/package.json packages/server/
COPY packages/cli/package.json packages/cli/
COPY packages/web/package.json packages/web/
# Abhängigkeiten. --ignore-scripts: better-sqlite3 13 bringt fertige Binärdateien (prebuilds/) mit, ohne
# den Schalter startet npm wegen binding.gyp einen unnötigen Compilerlauf. Eine optionale Firmen-CA kommt als Build-Secret, landet nie im Image.
RUN --mount=type=secret,id=ca,required=false \
    if [ -s /run/secrets/ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/ca npm_config_cafile=/run/secrets/ca; fi; \
    npm ci --no-audit --no-fund --ignore-scripts
COPY packages packages
# Feste Reihenfolge: core -> server -> cli -> web (Root-Skript baut alphabetisch, siehe NOTES/server.md)
RUN npm run build -w packages/core \
 && npm run build -w packages/server \
 && npm exec -w packages/cli -- tsc -p tsconfig.json \
 && npm run build -w packages/web \
 && npm prune --omit=dev --workspaces --include-workspace-root \
 && rm -rf packages/*/src packages/*/test packages/*/e2e packages/web/node_modules

# ---------- Laufzeit ----------
FROM ${NODE_IMAGE} AS laufzeit
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
    apt-get install -y --no-install-recommends git tini ca-certificates; \
    rm -rf /var/lib/apt/lists/* /etc/apt/apt.conf.d/99firmen-ca /tmp/firmen-ca.pem; \
    git config --system --add safe.directory '*'; \
    git config --system init.defaultBranch main
WORKDIR /app
COPY --from=bau /src /app
COPY deploy/scripts/einstieg.sh /usr/local/bin/kern-einstieg
COPY deploy/scripts/umzug.sh /usr/local/bin/kern-umzug
RUN chmod 0755 /usr/local/bin/kern-einstieg /usr/local/bin/kern-umzug /app/packages/cli/dist/cli.js \
 && ln -s /app/packages/cli/dist/cli.js /usr/local/bin/kern \
 && mkdir -p /daten && chown node:node /daten
ENV NODE_ENV=production \
    KERN_DATA=/daten \
    KERN_WEB_DIST=/app/packages/web/dist \
    PORT=7480 \
    HOST=0.0.0.0
USER node
VOLUME ["/daten"]
EXPOSE 7480
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||7480)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/kern-einstieg"]
CMD ["serve"]
