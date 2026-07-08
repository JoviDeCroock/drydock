# Detonation sandbox — prototype (Drydock proposal #7)

A **standalone** dynamic-analysis harness that installs a package's lifecycle
scripts inside an isolated environment and records what they *do* — process
spawns, filesystem writes, network egress, and access to planted credential
canaries — then emits a behavior report shaped to attach to a Drydock scan.

This is the "ocean-adjacent" bet from the ambition review: static rules catch
what is visible in the bytes; detonation catches what only manifests at
runtime (payloads decrypted from strings, install-time credential theft,
time-delayed callbacks).

## Why it is a separate system

Drydock's core boundary is **never execute package code** — the Worker treats
package bytes as hostile evidence and only ever parses them. This prototype
deliberately does the opposite, so it must live entirely outside that boundary:

- It is **not** under `server/` or `src/`, is **not** referenced by
  `wrangler.jsonc`, and is **never imported** by the Worker.
- It has its own `package.json` and its own test runner (`node --test`); the
  root `pnpm run verify` does not build, lint, or run it.
- Its only contract with Drydock is the **report format** (`src/report.mjs`,
  schema `drydock.detonation.v1`) — the Worker would consume a report produced
  by this service running elsewhere, never call the harness in-process.

## Isolation model

| Mode | Isolation | Use |
| ---- | --------- | --- |
| `docker` (default target) | Container: `--network none`, `--read-only` rootfs, `--cap-drop=ALL`, `--security-opt no-new-privileges`, non-root user, pids/memory/cpu limits, tmpfs workdir. The sink runs *inside* the container on loopback, so the container needs no external network at all. | The real trust boundary. What a production detonation service would use (micro-VM / Firecracker for the hardened version). |
| `local` (dev/demo) | Best-effort, in-process instrumentation: scrubbed env, throwaway `HOME`, PATH shims for common exfil tools, a `--require` preload that instruments `child_process`/`net`/`dns`/`http`/`fs`, and **loopback-only egress** (non-loopback TCP is logged and blocked). | Fast, offline demonstration of the instrumentation and report. **Not** sufficient containment for real malware — use `docker` for anything untrusted. |

`local` mode fails closed on network egress (it blocks non-loopback
connections), but it shares the host kernel and filesystem namespace. Treat it
as a demo of the *instrumentation*, not as a sandbox.

## What it observes

- **Process spawns** — every `child_process.*` call and every invocation of a
  shimmed CLI tool (`curl`, `wget`, `nc`, `python`), with arguments.
- **Network egress** — `net.connect` / `dns.lookup` / `http(s).request` targets,
  plus any request that reaches the loopback sink (with its body).
- **Filesystem writes outside the work dir** — e.g. home-directory persistence.
- **Credential canary access** — the harness plants fake `~/.npmrc`,
  `~/.aws/credentials`, `~/.ssh/id_rsa`, and `.env` files with unique tokens.
  Reading a canary is flagged; a canary token appearing in an egress body or a
  tool argument is flagged as **exfiltration** (the highest signal).

## Usage

```sh
cd prototypes/detonation
npm run demo          # detonate the benign-suspicious fixture (local mode)
npm run demo:clean    # detonate the clean fixture — shows no false positives

# Any extracted package directory (contains package.json):
node bin/detonate.mjs --package /path/to/extracted/package --out report.json

# Real isolation (requires Docker):
node bin/detonate.mjs --package /path/to/extracted/package --mode docker
```

The report is printed as a summary and written to `--out` (default
`detonation-report.json`).

## Fixtures

- `fixtures/benign-suspicious/` — a harmless package whose `postinstall`
  *simulates* an attack: reads the canary `~/.npmrc`, POSTs it to the sink,
  spawns `env`, shells out to `curl`, and writes a home-dir persistence file.
  Every "malicious" action targets the local sink or fake canaries — nothing
  leaves the machine.
- `fixtures/clean/` — a normal package that only writes a build artifact inside
  its own directory. The harness must report it as clean (no false positives).

## Status / roadmap

Prototype. Proves the harness, instrumentation, canary-exfil detection, and
report shape. Not built yet, in rough priority order:

1. Real dependency resolution (`npm install` inside the container) rather than
   just running the target package's own lifecycle scripts.
2. Micro-VM isolation (Firecracker/gVisor) to replace the container for a
   stronger kernel boundary and anti-evasion.
3. Syscall-level capture (seccomp/eBPF) instead of Node-level monkeypatching, so
   non-Node payloads are observed with the same fidelity.
4. Ecosystem coverage beyond npm (PyPI `setup.py`, wheels with native builds).
5. Feeding confirmed runtime behaviors back as a Drydock `detonation` finding
   source and into the cross-package intelligence feed (proposal #3).
