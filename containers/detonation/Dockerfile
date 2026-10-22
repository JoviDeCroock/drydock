# Detonation sandbox: runs untrusted npm and PyPI package code. Only
# harness.mjs runs as root (it needs root for strace and to drop to `pkg`);
# package code always runs as uid 10001 with no_new_privs.
#
# One image serves both ecosystems: a second image would need its own container
# class, binding, and instance cap for a harness that is otherwise identical.
# Bookworm's python3 is CPython 3.11, which `DETONATION_PYTHON` in
# server/lib/detonation/pypi.ts selects wheels for.
FROM node:22.23.3-bookworm-slim

# Debian's stdlib `sitecustomize.py` shadows any `sitecustomize` a package
# installs into site-packages; upstream CPython has none, so remove it to run
# a package's startup hook the way most interpreters would.
RUN apt-get update \
  && apt-get install -y --no-install-recommends strace ca-certificates procps python3 python3-venv \
  && rm -rf /var/lib/apt/lists/* \
  && rm -f /usr/lib/python3*/sitecustomize.py /etc/python3*/sitecustomize.py

RUN groupadd --gid 10001 pkg \
  && useradd --uid 10001 --gid 10001 --home-dir /home/pkg --create-home --shell /bin/sh pkg

COPY harness.mjs canary-files.mjs trace-parse.mjs event-budget.mjs manifest.mjs pypi.mjs observe.cjs /opt/drydock/
RUN chmod 0755 /opt/drydock && chmod 0644 /opt/drydock/*

COPY py/observe.py py/run.py py/build.py py/build_system.py /opt/drydock/py/
# pip lives in its own root-owned venv, never in the environment the package
# is installed into, so installing a wheel cannot load that wheel's `.pth`.
RUN chmod 0755 /opt/drydock/py && chmod 0644 /opt/drydock/py/* \
  && python3 -m venv /opt/drydock/pyinstaller \
  && chmod -R go-w /opt/drydock/pyinstaller

EXPOSE 8080
CMD ["node", "/opt/drydock/harness.mjs"]
