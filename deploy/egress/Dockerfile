# kern-egress: Ausgangs-Proxy, Verwaltung der Freigaben und TLS-Ask für Caddy. Eine Datei, keine Abhängigkeiten.
#   docker build -f deploy/egress/Dockerfile -t kern-egress:dev deploy/egress
ARG NODE_ALPINE_IMAGE=node:22-alpine
ARG ALPINE_IMAGE=alpine:3.22
FROM ${NODE_ALPINE_IMAGE} AS node
FROM ${ALPINE_IMAGE}
RUN apk add --no-cache libstdc++ libgcc tini && addgroup -g 1000 egress && adduser -u 1000 -G egress -D -H -s /sbin/nologin egress \
 && mkdir -p /var/lib/kern-egress && chown 1000:1000 /var/lib/kern-egress
COPY --from=node /usr/local/bin/node /usr/local/bin/node
COPY kern-egress.mjs /opt/kern-egress/kern-egress.mjs
USER 1000:1000
ENV KERN_EGRESS_DIR=/var/lib/kern-egress NODE_ENV=production
EXPOSE 3128
HEALTHCHECK --interval=30s --timeout=3s CMD node -e "require('net').connect(3128,'127.0.0.1').on('connect',()=>process.exit(0)).on('error',()=>process.exit(1))"
ENTRYPOINT ["/sbin/tini", "--", "node", "/opt/kern-egress/kern-egress.mjs"]
