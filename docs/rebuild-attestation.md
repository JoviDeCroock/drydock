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
   `v{version}`, changesets-style `{name}@{version}`, and `{version}` tags),
   the manifest's `repository.directory` for monorepos, and the staged
   tarball's SHA-1 `shasum`. The plan is persisted as
   `summary.rebuildAttestation` with `status: "pending"` (summary blob only —
   never the frozen `report.json` artifact, because the record is mutable).
2. **Deferred job** (`rebuild-job.ts`): scan completion enqueues a
   `rebuild_attestation` message on `SCAN_QUEUE` (waitUntil fallback in local
   dev). If that handoff fails after scan persistence, redelivery of the
   original scan message recovers the pending handoff. Rebuild-job D1/R2
   failures retry through the queue and reach its DLQ after exhaustion instead
   of being acknowledged while still pending. Container rebuilds take minutes
   and never hold up scan completion.
3. **Rebuild** (`rebuild-sandbox.ts` + `rebuild-steps.ts`): a disposable
   Cloudflare container clones the repo at the first resolvable ref, detects
   the strategy from the repository root (`packageManager` field via corepack,
   else lockfile heuristics; npm and pnpm supported, yarn reports
   unsupported), installs with `--ignore-scripts`, runs the `build` script if
   declared, packs, and emits a hash manifest: the tarball SHA-1 plus per-file
   sha256 of the unpacked contents.

   **Monorepos**: install runs at the repository root (so the workspace graph
   resolves); build and pack run in the package directory. That directory is
   `repository.directory` when the manifest declares it; otherwise, when the
   staged package name differs from the root manifest's name, the container
   greps the workspace (depth ≤ 5, `node_modules` excluded) for the
   package.json declaring that name, and the Worker validates both the located
   path shape and that the located manifest's `name` matches before using it.
   No unambiguous location → `inconclusive` with a `package-not-located`
   signal, never a guess.

   **What gets compared** is decided by `pack` itself, not by Drydock: `npm
pack`/`pnpm pack` apply the same `files`-field/`.npmignore` rules the
   publisher's client did, so the rebuilt file set is exactly "what this
   commit would publish" — dist/ output included, sources excluded when the
   manifest excludes them.

4. **Comparison** (`compareRebuildOutput`): runs in the Worker against the
   scan's persisted artifact hashes (R2 `files.json`) and the staged `shasum`.
   The staged bytes are never re-fetched and never enter the container.
5. The outcome replaces the pending record in `summary.rebuildAttestation`,
   surfaces under "Source binding" on the scan detail page, and exports as the
   additive optional `rebuildAttestation` field of `drydock.report.v1`. A
   completed scan page keeps polling while this record is pending, then stops
   when the deferred outcome arrives.

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

The feature ships in two stages because a container needs a Durable Object
class as its control plane, and DO migrations cannot ride the versioned
uploads Workers Builds performs (`wrangler versions upload` fails with error
10211 for any version that carries an unapplied migration):

1. **Feature code** (this layer): everything including the `RebuildSandbox`
   class export, with **no** container/DO config in `wrangler.jsonc`.
   Versioned uploads stay green. `env.REBUILD_SANDBOX` is absent, so if the
   flag is turned on early the job records `inconclusive` with a "sandbox not
   configured" signal instead of failing.
2. **Container infra** (config-only follow-up): the exact block to add to
   `wrangler.jsonc` (same convention as the detonation prototype, PR #472):

   ```jsonc
   "containers": [
     {
       "class_name": "RebuildSandbox",
       "image": "./container/Dockerfile",
       "max_instances": 5
     }
   ],
   "durable_objects": {
     "bindings": [{ "name": "REBUILD_SANDBOX", "class_name": "RebuildSandbox" }]
   },
   "migrations": [{ "tag": "v1", "new_sqlite_classes": ["RebuildSandbox"] }],
   ```

   This change must be applied by a one-time non-versioned `wrangler deploy`
   run with Docker available — the image (`container/Dockerfile`, pinned to
   the same version as the `@cloudflare/sandbox` dependency) is built at
   deploy time, which the Workers Builds pipeline does not support. Once the
   migration is applied, subsequent versioned uploads carry no _new_ migration
   and succeed again. If the detonation prototype's container lands too, one
   deploy can provision both under the same migration tag.
