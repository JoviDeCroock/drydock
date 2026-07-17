# Rebuild attestation

Opt-in verification that a staged npm artifact can be reproduced from its
declared source repository: check out the repo, install dependencies, run the
build, pack, and compare the result against the staged bytes. It is the
empirical upgrade of the [intent envelope](./intent-envelope.md)'s `declared`
tier — the envelope records what the package _claims_, the rebuild tests it.

Like the envelope, the result is **advisory metadata only**. It never changes
risk levels or findings. A match proves _binding_ ("these bytes are exactly
what this commit builds"), never benignness — if malicious code is committed to
the repository, the rebuild truthfully matches, and source review covers it.

## Opt-in

The per-organization Cloudflare Flagship flag `rebuild-attestation` gates the
feature and **defaults to off** (the inverse of the `ai-review` killswitch).
Without a Flagship binding, or without an explicit organization rule turning it
on, no rebuild plan is ever computed.

v1 covers staged npm scans only. Workflow-gate scans are excluded (their
artifact is already bound to a workflow run and their acquisition path has no
staged shasum); PyPI and VS Code have no rebuild strategy yet.

## Flow

1. **Scan time** (`scan-pipeline.ts`): when the flag is on and the scan is
   rebuildable, `computeRebuildPlan` (`server/lib/rebuild-attestation.ts`)
   derives a plan — the envelope's normalized repository URL, checkout
   candidates (`gitHead` from the staged version manifest first, then
   `v{version}`/`{version}` tags), the manifest's `repository.directory` for
   monorepos, and the staged tarball's SHA-1 `shasum`. The plan is persisted as
   `summary.rebuildAttestation` with `status: "pending"` (summary blob only —
   never the frozen `report.json` artifact, because the record is mutable).
2. **Deferred job** (`rebuild-job.ts`): scan completion enqueues a
   `rebuild_attestation` message on `SCAN_QUEUE` (waitUntil fallback in local
   dev). Container rebuilds take minutes and never hold up scan completion.
3. **Rebuild** (`rebuild-sandbox.ts` + `rebuild-steps.ts`): a disposable
   Cloudflare container clones the repo at the first resolvable ref, detects
   the strategy (`packageManager` field via corepack, else lockfile heuristics;
   npm and pnpm supported, yarn reports unsupported), installs with
   `--ignore-scripts`, runs the `build` script if declared, packs, and emits a
   hash manifest: the tarball SHA-1 plus per-file sha256 of the unpacked
   contents.
4. **Comparison** (`compareRebuildOutput`): runs in the Worker against the
   scan's persisted artifact hashes (R2 `files.json`) and the staged `shasum`.
   The staged bytes are never re-fetched and never enter the container.
5. The outcome replaces the pending record in `summary.rebuildAttestation`,
   surfaces under "Source binding" on the scan detail page, and exports as the
   additive optional `rebuildAttestation` field of `drydock.report.v1`.

## Outcome ladder

| Status           | Meaning                                                                                                |
| ---------------- | ------------------------------------------------------------------------------------------------------ |
| `byte-identical` | Rebuilt tarball SHA-1 equals the staged `shasum` (and the file sets agree). The strongest claim.       |
| `file-identical` | Every packed file's sha256 matches the staged artifact; only tarball/pack metadata differs.            |
| `diverged`       | The build succeeded but file sets differ. Informational evidence (divergent/missing/extra path lists). |
| `inconclusive`   | No ref resolved, clone/install/build/pack failed, unsupported strategy, or no sandbox configured.      |
| `pending`        | Plan persisted, deferred job not finished yet.                                                         |

Ecosystem reality check: vlt's `reproduce` project found only ~6% of
high-impact npm packages rebuild byte-for-byte, so `inconclusive` and
`diverged` are expected, neutral outcomes — the UI renders them with
informational tones, never severity colors. `file-identical` is the practical
"reproduced" bar; `npm pack` itself is deterministic (fixed mtimes, sorted
entries), so divergence almost always means the build output differs, not the
packaging.

## Security model

The rebuild deliberately executes hostile code — repository contents, build
scripts, and the dependency tree are all attacker-controlled. This is a second
isolation ring, separate from the parse-only Dynamic Worker sandbox; the
boundary is containment (see `docs/security-model.md`):

- **Zero credentials in the container.** Public repos clone anonymously. The
  npm staged token stays in the Worker. Because the staged tarball is
  unpublished and requires that token, a hostile build _cannot_ fetch the
  expected bytes and replay them — the classic self-fetch bypass of
  post-publish rebuilders does not exist pre-publish.
- **Deny-by-default egress.** `RebuildSandbox.allowedHosts` covers the source
  forges (github.com, gitlab.com, bitbucket.org) and registry.npmjs.org for
  dependency install; `interceptHttps` keeps the filter authoritative for TLS.
- **Container output is hostile input.** Only a bounded hash manifest leaves
  the container; the Worker re-validates it and performs the comparison itself.
  A forged manifest can only produce a false `diverged`/`inconclusive`
  (self-harm), because forging a _match_ requires the staged hashes.
- **Dependency lifecycle scripts stay disabled** during install; the package's
  own build/prepack scripts are the thing being attested and run inside the
  container.
- **Single-shot containers.** Sandbox ids are scan-scoped and destroyed after
  one attestation; nothing is shared across scans or organizations.

## Persistence and compatibility

Everything lives in the scan's `summaryJson` blob — no schema migration. Every
reader re-validates through `normalizeRebuildAttestation` (the
`normalizeIntentEnvelope` pattern): scans that predate the feature, malformed
blobs, and verdicts missing their evidence all read as `null`, and the UI hides
the row. The report export carries `"rebuildAttestation": null` for those scans.

## Deployment

`wrangler.jsonc` defines the `RebuildSandbox` container (Durable Object binding
`REBUILD_SANDBOX`, image `container/Dockerfile` pinned to the same version as
the `@cloudflare/sandbox` dependency). Environments without the binding degrade
gracefully: the job records `inconclusive` with a "sandbox not configured"
signal instead of failing.
