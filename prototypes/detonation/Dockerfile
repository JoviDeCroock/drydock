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

# The package under review is bind-mounted read-only at /pkg; the report is
# written to the bind-mounted /out. Overridden by buildDockerArgs at run time.
ENTRYPOINT ["node", "bin/detonate.mjs"]
CMD ["--package", "/pkg", "--mode", "local", "--out", "/out/detonation-report.json"]
