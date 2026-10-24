# Detonation sandbox (beta)

Static review reads a release. The detonation sandbox runs it: after a staged npm scan or a PyPI workflow-gate review completes, Drydock installs the reviewed bytes in an isolated container, runs the package's install scripts, interpreter startup hooks, and entry points with fake credentials planted, and records what it tries to do. The result is **advisory**: it never moves the scan's risk, findings, finding count, report digest, or a workflow-gate decision.

This is the one place Drydock executes package code. Everywhere else the rule in [`security-model.md`](./security-model.md) still holds.

## When it runs

- Only for organizations with the Flagship flag `detonation-sandbox` (default **off**) and only when the Worker has the `DETONATION_SANDBOX` binding. Without either, no container starts, starting a run is a 404, and the read reports nothing to show.
- Automatically after every completed npm staged-publish scan (`manual` and `auto_discovery` sources), via a message on its own `DETONATION_QUEUE` (concurrency 5, matching the container `max_instances`), so a run never holds a scan or workflow-gate consumer. When every container instance is busy, the run hands its claim back and is retried after a minute, up to 3 attempts.
- Automatically for each PyPI package a workflow gate reviews, once the review is attached to the gate. The request goes on the same queue after the gate is ready for a decision, so the gate never waits on it: a maintainer can approve or reject before the run finishes, and the run never posts or changes a decision. A gate scan is eligible only when it carries the gate id, a `workflow-gate:<gate>:pypi:` stage id, and the reviewed artifacts' digests (`summary.stagedPublish.provenance`). npm and VS Code gate scans are not eligible: an npm gate's artifact has no stage to fetch again, and a VS Code extension does not run outside an editor.
- On demand from the scan page (`POST /api/v1/scans/:id/detonation`, 10 per organization per hour). One live run per scan; a run that has not finished after 20 minutes is presumed lost and can be replaced.
- Never for published-pair scans or the anonymous `/diff` surface.

## What runs

### npm (staged publish)

```
DETONATION_QUEUE ─▶ executeDetonationJob (parent Worker)
                │ 1. NpmAdapterBroker.fetchStagedArchive ─▶ NpmStageGateway (token attached here only)
                │    bytes must hash to the scan's persisted SHA-256, else refused
                │ 2. DetonationSandbox (Durable Object, one per run) ─▶ container
                │       enableInternet: false; all HTTP + HTTPS ─▶ DetonationEgress
                │       POST /prepare   npm install --ignore-scripts (registry reads forwarded)
                │       POST /detonate  canaries planted; lifecycle → require → import → bin --help
                │ 3. parseHarnessReport + classifyDetonation ─▶ scan_detonations row
```

- **Bytes.** The staged tarball is fetched again through `NpmStageGateway`, which stays the only code that attaches the npm token. A stage is mutable, so the bytes are detonated only if their SHA-256 equals `summary.stagedPublish.artifactSha256`, the digest of what the scan reviewed. Otherwise the run fails with `artifact_digest_mismatch`. Tarballs over 16 MiB are skipped (`artifact_too_large`) rather than partially run.
- **Prepare.** `npm install --ignore-scripts` of the tarball into an empty project, as an unprivileged user. Dependencies resolve anonymously from `https://registry.npmjs.org` (GET/HEAD only, container headers stripped, redirects not followed). No package code runs in this phase, and its registry reads are counted, not recorded.
- **Detonate.** The Durable Object flips the egress policy to sinkhole-everything _before_ the harness is told to start. The harness plants canaries, then runs each installed package's `preinstall`/`install`/`postinstall` script itself (dependencies first, no npm process in the tree, so a credential read is the package's own), then `require()`, then `import()`, then each `bin` with `--help`. Every step has a 30 s budget, the whole phase 180 s. Processes are killed by process group, and everything owned by the package user is killed between steps.

### PyPI (workflow gate)

```
DETONATION_QUEUE ─▶ executeDetonationJob (parent Worker)
                │ 1. fetchGateReleaseFiles: the gate run's GitHub Actions artifact, downloaded
                │    again with the installation token (parent only); each file must hash
                │    to the digest the review recorded, else refused
                │ 2. DetonationSandbox ─▶ container
                │       POST /prepare-pypi  venv + pip install (PyPI reads forwarded)
                │       POST /detonate      canaries planted; startup → import → build → bin --help
                │ 3. parseHarnessReport + classifyDetonation ─▶ scan_detonations row
```

- **Bytes.** The parent Worker downloads the gate run's artifact bundle through the same `processReleaseBundleForGate` path the review used, minting the GitHub App installation token itself. The container receives only distribution bytes. GitHub artifacts are immutable, but the run still refuses (`artifact_digest_mismatch`) unless every selected file hashes to the SHA-256 in the scan's provenance. The fetch never writes gate state.
- **Selection.** One wheel and the sdist. The wheel is the best match for the container's interpreter (CPython 3.11, linux x86_64, glibc 2.36): an exact `cp311` tag, then `abi3`, then pure Python. A release with neither a runnable wheel nor an sdist is skipped as `platform_unsupported`. Both files together must fit in 16 MiB; the sdist is dropped first, and a wheel alone over the cap is `artifact_too_large`. The result records which files ran (`result.artifacts`).
- **Prepare.** A venv without pip, owned by the package user. pip runs from a separate root-owned installer environment with `--target` into the venv's site-packages, so installing a wheel never starts an interpreter that loads that wheel's `.pth` files. The reviewed wheel is installed with `--no-deps`. Its `Requires-Dist` entries are then resolved anonymously and only as wheels (`--only-binary :all:`), so no `setup.py` runs during prepare. Direct references (`dep @ file:///…` or an sdist URL) are dropped first, because pip would build them even with `--only-binary`. A dropped or unresolvable dependency makes coverage `partial`. The sdist is unpacked and its static `build-system.requires` are installed, also wheels only, into a separate build environment. Egress in this phase is limited to GET/HEAD under `https://pypi.org/simple/` and `https://files.pythonhosted.org/packages/`.
- **Detonate.** After the same sinkhole flip as npm, each step runs as the package user with the same 30 s budget, process-group kill, and strace:
  - `startup`: `python -c pass` in the venv. A `.pth` file or a `sitecustomize`/`usercustomize` module runs here, the LiteLLM 1.107.0 shape. Debian's own `sitecustomize.py` is removed from the image so a package's copy is the one that loads.
  - `import`: each top-level module the wheel's `RECORD` lists (its own package first, up to 8), with `python -P`.
  - `build`: PEP 517 `build_wheel` of the sdist with its declared backend (setuptools' legacy backend when `pyproject.toml` declares none), so `setup.py` code runs.
  - `bin`: each `console_scripts`/`gui_scripts` entry point with `--help`, up to 8.

### Container

`containers/detonation/` (Node 22, Debian bookworm's CPython 3.11, `strace`). One image serves both ecosystems: a second image would need its own container class, binding, and instance cap for a harness that is otherwise the same. The harness runs as root and serves only one prepare (`/prepare` or `/prepare-pypi`) then `/detonate`, once each. It stops accepting connections when detonation starts, so package code cannot talk to it. Package code runs as uid 10001.

## What is observed

| Source         | How                                                                                                                                                                                                                                                                                                                                                                                                                                                       | Can the package hide it?                            |
| -------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------- |
| `egress`       | `DetonationEgress` (a Worker entrypoint outside the container) sees every HTTP(S) request: method, host, redacted path, body size, and which canaries appear in the URL, headers, or body (raw, URL-encoded, hex, base64/base64url at any alignment, double base64; gzip/deflate bodies decoded and stream-scanned up to 32 MiB). Events that carry a canary or write to a registry are kept in their own bucket, so junk requests cannot crowd them out. | No, short of a channel it does not see (DNS, below) |
| `syscall`      | `strace -f` as root over each step: exec, file open/create/write/delete/rename/chmod, connect. Trace files are root-only.                                                                                                                                                                                                                                                                                                                                 | Not without a privilege escalation                  |
| `runtime-hook` | A Node `--require` preload hooking `child_process`, `fs`, `net`, `dns`; for PyPI, a Python audit hook loaded by a root-written `00-drydock-observe.pth`. Gives DNS names strace cannot see, and is the fallback when ptrace is unavailable.                                                                                                                                                                                                               | Yes: it runs in the package's process               |

`coverage.syscallTracing` on each result says which mode ran. Absence of signals is weaker evidence without syscall tracing, and the UI says so. The harness resolves relative paths against each process's working directory (strace `-y` plus tracked `chdir` and fork inheritance) and normalizes them, using the kernel's resolved path on successful opens so a symlink to `~/.npmrc` still counts. Events are attributed to the process (thread group), not the thread, because Node does its file I/O on pool threads. Every event that can raise a signal goes to a protected bucket for its signal category (64 distinct per step), which only events of the same category can fill, so a flood can only crowd out evidence for a signal it has already raised. A parity test keeps the harness's copy of the signal rules in step with the classifier. Other events are kept as context, 300 per step by tier. When the whole report must shrink, context goes before signal-bearing events, and each step keeps its earliest events in a fair share, so one step's volume cannot erase another's evidence. Trace parsing stops at a per-step deadline, which also leaves the harness time to report inside the parent's window, and the report is then marked truncated. Dependencies' lifecycle scripts share at most 40% of the time budget, so the reviewed package's own steps still run, and any step never started is counted in `coverage.stepsSkipped`.

With `enableInternet: false`, raw TCP/UDP to other hosts is refused, and those attempts still show up as `syscall` connects. DNS is the exception: queries reach Cloudflare's resolvers, so a payload can leak data in query names without crossing `DetonationEgress`. Node and Python lookups are recorded by the runtime hooks, and resolver tools (`dig`, `nslookup`, `host`, `drill`) raise `dynamic.suspicious-process`, but a native resolver call from another runtime is not recorded.

### Canaries

Generated per run (`server/lib/detonation/canaries.ts`), shaped like the real thing because stealers select by prefix: `NPM_TOKEN`/`NODE_AUTH_TOKEN` (`npm_…`), `GITHUB_TOKEN` (`ghp_…`), `PYPI_API_TOKEN`/`TWINE_PASSWORD` (`pypi-…`), AWS key pair, an Actions OIDC request token, and the files `~/.npmrc`, `~/.pypirc`, `~/.aws/credentials`, `~/.config/gh/hosts.yml`, `~/.git-credentials`, `~/.ssh/id_ed25519`. Both ecosystems get the same set. The environment also looks like a GitHub Actions release job (`CI`, `GITHUB_ACTIONS`, …), because worms check for one before acting. Canary values authorize nothing and are redacted from recorded paths as `[canary:<kind>]`.

## Signals

`classifyDetonation` (`server/lib/detonation/classify.ts`) maps telemetry to advisory signals:

| Signal                             | Severity                       | Raised by                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| ---------------------------------- | ------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `dynamic.canary-exfiltration`      | critical                       | A planted credential in any detonation-phase request                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `dynamic.registry-publish-attempt` | critical                       | A non-GET request to the npm, yarn, or PyPI registry                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `dynamic.network-egress`           | high if data sent, else medium | Any detonation-phase request, outbound connect (not loopback or DNS), or DNS lookup                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `dynamic.credential-file-read`     | high                           | Reads of `~/.npmrc`, `~/.pypirc`, `~/.ssh/`, `~/.aws/`, `~/.config/gh/`, `.git-credentials`, `.netrc`, docker/kube config. A package manager's own read of its config (`"postinstall": "npm run build"`) is excluded, but only for the root-owned binaries under `/usr/local`, matched by exec path and pid (including the launcher's `node` re-exec), not by argv[0]. A package that launches real npm with its own `NODE_OPTIONS` can read `~/.npmrc` or `~/.yarnrc.yml` under the exempt pid unnoticed; the other credential files are never exempt, and anything sent still crosses the egress boundary |
| `dynamic.persistence-write`        | high                           | Writes to shell rc files, `~/.npmrc`, `~/.pypirc`, a `.pth`/`sitecustomize.py`/`usercustomize.py` in any site-packages, `authorized_keys`, autostart/systemd/cron, `ld.so.preload`, `.github/workflows/`, `.git/hooks/`                                                                                                                                                                                                                                                                                                                                                                                     |
| `dynamic.package-tampering`        | high                           | Writes into another package's `node_modules` directory, the project `package.json`, or any `node_modules` write at require/import/bin time; for PyPI, any write into the installed venv outside `__pycache__`. An install script building into its own directory is normal, and so are shared dot directories (`.bin`, `.cache`, `.prisma`)                                                                                                                                                                                                                                                                 |
| `dynamic.suspicious-process`       | medium                         | curl, wget, nc, socat, ssh, gh, trufflehog, crontab, systemctl, nohup, xxd, dig, nslookup, host, drill; `sh -c` with download/`/dev/tcp`/`base64 -d`/`eval`; `python -c`/`perl -e` whose code reaches for sockets, HTTP, a shell, or base64 (node-gyp's own `python3 -c` probe does not)                                                                                                                                                                                                                                                                                                                    |
| `dynamic.sensitive-file-read`      | medium                         | `/etc/shadow`, `/proc/<pid>/environ` or `mem`, browser profiles, crypto wallets                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |

These are not deterministic findings: they are not in `scan_findings`, the security corpus, or the detection eval, and they carry no rule version.

## Persistence and API

`scan_detonations` holds the latest run per scan (`run_id` fences a rerun against a slow earlier run). It stays separate from `scans.summary_json` because the report digest is fixed at completion. `result_json` is a bounded `DetonationResult`: signals with at most 6 evidence lines each (canary values redacted), up to 200 steps, and at most 350 recorded egress events (100 carrying a canary or writing to a registry, 50 from prepare, 200 from detonation). It never includes request bodies.

- `GET /api/v1/scans/:id/detonation` returns `{ eligible, detonation }`. Outside the beta, and for a scan the organization does not own, it returns `{ eligible: false, detonation: null }` rather than 404, because the scan page asks on every load.
- `POST /api/v1/scans/:id/detonation` returns 202 when queued, 409 while a run is live, and 429 when rate limited. It records a `scan.detonation_requested` scan event.

Operational events: `detonation.job.completed` (status, error code, signal ids, tracing mode) and `detonation.job.failed`. They contain no package content.

## Local development

`vite dev` runs with `dev.enable_containers: false`, so no Docker is needed and the binding exists but no container starts. To work on the harness itself:

```sh
node scripts/detonation-local.mjs path/to/package.tgz [--cap-add-ptrace]
```

For PyPI, pass a wheel and optionally its sdist:

```sh
node scripts/detonation-local.mjs --pypi path/to/pkg-1.0-py3-none-any.whl [path/to/pkg-1.0.tar.gz]
```

This builds the image, runs the prepare step with network access, disconnects the network, runs `/detonate`, and prints the report. `test/fixtures/detonation/` has a benign package, synthetic npm canary thieves, and a defanged LiteLLM-shaped PyPI package.

## Limits

- Advisory and best-effort. A payload can wait out the 30 s step budget, check for a sandbox, or target a platform other than linux/x64. No signals does not mean safe.
- Code is loaded, not exercised (`coverage.exercise: "load"`): no export is called, so a payload that waits for a call never runs. Browser code never runs either, so a web library's payload (a wrapped `fetch` or `XMLHttpRequest`, a `window.ethereum` hook) is invisible here; static review is the stronger check for those. The harness reads the published manifest before any package code runs and sets `coverage.browserTargeted` for a `browser`, `unpkg`, or `jsdelivr` field or a `browser` export condition, and the UI then says a clean run says little. The manifest is the package's own claim, so it can only add that caveat, never strengthen a result. Detection is deliberately narrow: a web library that declares only `module` or `import`/`default` exports gets no browser caveat.
- Only HTTP(S) is visible at the boundary. Exfiltration over DNS queries to Cloudflare's resolvers is not observed beyond the runtime-hook DNS names and resolver tools, and canaries encoded as base32 subdomains are not matched.
- Packages with a `binding.gyp` but no install script get npm's implicit `node-gyp rebuild` in a real install. The harness does not emulate it.
- Dependencies resolve from the public registry, so private scoped dependencies leave the install `partial`. PyPI dependencies install only as wheels, so a dependency that ships only an sdist also leaves it `partial`.
- PyPI runs one wheel, the closest match to linux x86_64 CPython 3.11; a payload only in a Windows, macOS, or other-version wheel is not exercised. The sdist build installs only static `build-system.requires`, so a backend that asks for more through `get_requires_for_build_wheel` fails the build step. Dependencies' startup hooks also run at the `startup` step, and attribution is by step, not by distribution. The Python audit hook runs inside the package's interpreter, and a `.pth` that sorts before `00-drydock-observe.pth` loads first, so strace stays the record whenever it is available.
- Whether `strace` works depends on the container runtime allowing ptrace. When it does not, coverage drops to runtime hooks and results say so.
