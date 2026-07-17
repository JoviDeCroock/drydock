# Rebuild-attestation container image. The Sandbox SDK base image version must
# match the @cloudflare/sandbox dependency in package.json — bump them together.
#
# The rebuild deliberately executes hostile repository code, so this image gets
# no credentials and its egress is filtered by the RebuildSandbox allowlist
# (server/lib/rebuild-sandbox.ts). Keep the toolchain here minimal and pinned:
# the base image ships node + git + coreutils; package managers are activated
# per-rebuild through corepack against the repository's `packageManager` pin.
FROM docker.io/cloudflare/sandbox:0.12.3

# Fail fast if a rebuild somehow reaches for interactive git auth instead of
# surfacing a prompt that would hang the container until its exec timeout.
ENV GIT_TERMINAL_PROMPT=0
ENV CI=true
