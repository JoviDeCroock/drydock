# Hardened container for detonation `--mode docker`. This is the real isolation
# boundary the prototype points at: the harness runs inside here with no network
# (the sink is intra-container loopback), a read-only rootfs, dropped
# capabilities, and a non-root user. `docker run` flags in src/harness.mjs
# (buildDockerArgs) enforce the runtime restrictions; this image just carries
# node + the harness.
FROM node:20-alpine

# Non-root user the container runs as (matches buildDockerArgs --user 1000:1000).
RUN addgroup -g 1000 detonation && adduser -u 1000 -G detonation -D detonation

WORKDIR /app
COPY package.json ./
COPY bin ./bin
COPY src ./src

USER detonation

# Two entrypoints:
#   * As a service (the Cloudflare Container wiring): an HTTP server the Worker
#     POSTs reviewed file bytes to. This is the default.
#   * As a one-shot CLI: `docker run ... node bin/detonate.mjs --package /pkg`
#     (see buildDockerArgs in src/harness.mjs).
EXPOSE 8080
ENV PORT=8080
ENTRYPOINT ["node"]
CMD ["src/server.mjs"]
