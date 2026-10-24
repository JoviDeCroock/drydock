# Detonation sandbox: runs untrusted npm package code. Only harness.mjs runs as
# root (it needs root for strace and to drop to `pkg`); package code always runs
# as uid 10001 with no_new_privs.
FROM node:22.23.3-bookworm-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends strace ca-certificates procps \
  && rm -rf /var/lib/apt/lists/*

RUN groupadd --gid 10001 pkg \
  && useradd --uid 10001 --gid 10001 --home-dir /home/pkg --create-home --shell /bin/sh pkg

COPY harness.mjs canary-files.mjs trace-parse.mjs event-budget.mjs manifest.mjs observe.cjs /opt/drydock/
RUN chmod 0755 /opt/drydock && chmod 0644 /opt/drydock/*

EXPOSE 8080
CMD ["node", "/opt/drydock/harness.mjs"]
