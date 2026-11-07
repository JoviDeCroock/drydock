# Architecture

Drydock reviews release artifacts before a maintainer approves publication: a Hono Worker control plane, a Dynamic Worker sandbox for hostile bytes, per-ecosystem adapters, D1 + R2 persistence. **Owner:** `server/index.ts`. Where each module lives: [`repository-map.md`](./repository-map.md).

## Runtime components

```text
Browser UI
  │ same-origin authenticated fetch
  ▼
Hono Worker  (trusted control plane)
  ├─ Better Auth session guard + organization ownership checks
  ├─ D1 persistence and R2 report/artifact storage
  ├─ Queue-backed scan/gate orchestration
  ├─ Dynamic Worker loader for untrusted archive parsing
  ├─ npm / PyPI / VS Code / atpm adapters, plus npm / PyPI / VS Code workflow gates
  └─ constrained brokers/gateways for registry/artifact downloads
        │
        ▼
      npm registry, PyPI, VS Code Marketplace, GitHub Actions artifacts,
      AT Protocol identity + PDS hosts (atpm)

Dynamic Worker sandbox  (package bytes are hostile evidence)
  ├─ receives scan options and artifact URLs, not npm credentials
  ├─ fetches only through `globalOutbound` brokers/gateways
  ├─ parses tarballs, wheels, and VSIX artifacts safely
  └─ returns bounded file metadata, text evidence, and suspicious-entry flags
```

Route handlers stay thin and call shared pipeline/library code, so HTTP routes, queue consumers, and local `waitUntil()` execution behave the same.

## Ecosystems and capabilities

`server/lib/ecosystems/index.ts` is the only registry. One directory per ecosystem (`server/lib/ecosystems/<id>/`) holds acquisition, broker, findings, manifest parsing, and its capability adapters.

| Capability | Field | Contract | Meaning |
| --- | --- | --- | --- |
| Stage Watchtower — advisory | `staged` | `PackageAdapter` (`package-adapter.ts`) | The registry holds a private candidate Drydock reviews and records; npm controls approval. |
| Workflow Gate — enforced | `gate` | `WorkflowGateAdapter` | A configured protected GitHub publish job is held for Drydock's approve/reject decision. |
| Public diff | `publicDiff` | `PublicDiffAdapter` | Two published versions diff anonymously on `/diff`, credential-free. Identity normalization and optional `versionsEquivalent` also support dependency-review malware matching. |
| Published-pair review | `published` | `PublishedPairAdapter` | An organization runs the full authenticated pipeline over two published versions. |

| Ecosystem | `staged` | `gate` | `publicDiff` | `published` | Why not |
| --- | :---: | :---: | :---: | :---: | --- |
| npm | ✓ | ✓ | ✓ | ✓ | — |
| PyPI |  | ✓ | ✓ | ✓ | the registry cannot stage a candidate |
| VS Code |  | ✓ |  |  | — |
| atpm |  |  | ✓ |  | releases live in the publisher's AT Protocol repo; versions are mutable record refs ([`atpm.md`](./atpm.md)) |

Invariants:

1. Capability presence is data. `getStagedAdapter` / `getWorkflowGateAdapter` fail closed with `UnsupportedEcosystemError`; nothing falls back to another ecosystem's reviewer. `test/ecosystem-registry.test.ts` pins the matrix.
2. `published` wraps a `PublicDiffAdapter` as a `PackageAdapter` (`server/lib/ecosystems/published-pair.ts`): no new egress. It is still declared separately because persisting an org-owned review of public releases is a product decision.
3. Routes and orchestrators read capabilities off the registry; never `if (ecosystem === …)`. Ecosystem-specific needs become optional adapter hooks (example: `WorkflowGateAdapter.narrowParsedArtifact`, which PyPI uses to collapse duplicate text across platform wheels).
4. Ecosystem ids are spelled once in `server/lib/ecosystems/labels.ts` (`EcosystemId`, `ECOSYSTEM_LABELS`, `isEcosystemId`). It is dependency-free so the browser bundle and persisted-value validators can import it.

Adding an ecosystem: one directory + one registry entry; follow the `add-ecosystem` skill.

## Trust boundaries

| Boundary | May | Must not |
| --- | --- | --- |
| Browser UI | send authenticated requests; render escaped package text | authorize anything; render package HTML, scripts, images, SVG, active content |
| Parent Worker | authenticate, resolve org, check ownership, decrypt credentials at the moment of registry use, invoke the sandbox, compute findings/risk, persist, emit redacted events | — |
| Dynamic Worker sandbox | parse untrusted archive bytes ([`sandbox-parser.md`](./sandbox-parser.md)) | execute code, install deps, resolve imports, run builds, receive tokens |
| `NpmStageGateway` | attach npm auth (the only place); staged tarball, package metadata JSON, previous-version `.tgz`; resolve redirects of pinned `publicArtifactUrls` itself: same-origin only, at most 3 hops | attach auth anywhere else; follow cross-origin redirects |
| PyPI broker | credential-free downloads from `https://files.pythonhosted.org` only | other hosts |
| VS Code broker | VSIX baselines from allowed Marketplace/CDN hosts | other hosts |
| GitHub artifact broker | artifacts of the installation and run under review | other runs |
| atpm identity resolution | the only egress whose host the reviewed party picks (a DID document names its PDS); credential-free; every URL rebuilt from validated parts and re-checked by the public-host policy; redirects off, each hop bounded and re-validated | use path-prefix PDS endpoints; redirect a pinned blob off its origin. Details: [`atpm.md`](./atpm.md) |

The full boundary list, anonymous surfaces, and egress policy: [`security-model.md`](./security-model.md).

## Scan pipeline

Owner: `server/lib/scan/pipeline.ts`, driven by a `PackageAdapter` (`server/lib/ecosystems/package-adapter.ts`).

| Step | What happens |
| --- | --- |
| 1 | `POST /api/v1/scans` validates input and inserts a queued scan (shared per-org scan rate limit). |
| 2 | `SCAN_QUEUE` consumer (prod) or `waitUntil()` (local dev) runs the pipeline. |
| 3 | `analyzeRelease`: acquire both sides, pick the baseline ([`diff-baseline.md`](./diff-baseline.md)), diff, run deterministic findings on **raw** text. |
| 4 | Project what later phases need into `ArtifactFacts` (package summary, file counts, baseline, intent-envelope repository) and release raw file arrays. |
| 5 | Redact; AI review ([`ai-review-eval.md`](./ai-review-eval.md)), risk, report assembly, persistence ([`artifact-storage.md`](./artifact-storage.md)). |
| 6 | UI polls `GET /api/v1/scans/:id/status` (one indexed row, lifecycle columns only) and fetches `GET /api/v1/scans/:id` once on a terminal status. A detail read of a completed scan records a report view on the scan row after the response ([`product-analytics.md`](./product-analytics.md#report-views)). |

`POST /api/v1/scans` input shapes:

| Body | Reviews | Credential | Persisted as |
| --- | --- | --- | --- |
| `{ stageId }` | an npm staged publish | validated org npm token | staged scan with `registry_url` |
| `{ ecosystem, packageName, version, baselineVersion? }` | two published releases (`published`) | none | `source: "published"`, no `registry_url` (outside stage-status and supersession tracking in `server/db/scan-registry-status.ts`) |

Pipeline invariants:

1. Findings run before redaction; everything after step 4 sees only redacted records. `ResolvedArtifacts` never leaves `analyzeRelease`; `persistResults` takes facts. `ComputedDiff.stagedManifestText` is dropped at the same boundary. Reading raw evidence after it silently reads nothing, so new needs become facts.
2. Peak memory (both sides in a 128 MiB isolate) caps reviewable size. The step-4 release frees record wrappers, arrays, and rewritten text; it is a no-op on the workflow-gate path, where the prepared-package list (up to 3 packages concurrently) keeps artifacts alive.
3. Published-pair requests resolve against the public registry before a scan row exists: an unpublished version is a `404`, and `baselineVersion` defaults to the immediately preceding release. Mutable refs (pkg.pr.new URLs) are rejected.
4. `DELETE /api/v1/scans/:id` deletes only `failed` scans; any other status returns `409`.
5. Registry packument reads are cached 5 minutes in `COMPARE_CACHE` (`fetchPackageMetadataCached`, shared with the compare/versions routes), keyed `org:<id>` because a token-authenticated packument can include private packages. The decision-time dependency readiness check keeps its streamed versions-only answers in a sibling `<scope>|versions` partition of the same namespace. The scan path uses the abbreviated packument (separate key). Documents are projected to `versions[].dist.tarball`, `dist-tags`, `time` at fetch. The decision-time dependency readiness check keeps its streamed versions-only answers in a sibling `<scope>|versions` partition of the same namespace.
6. Cache staleness usually picks an older baseline (louder diff, recorded in `BaselineInfo`). Exception: a dist-tag rolled back within the 5-minute TTL diffs against a baseline ahead of the release, which reads quieter. The report's baseline version shows which one was used.

## Workflow gates

Enforced path for registries without private staging. GitHub Actions uploads candidates, a GitHub Environment protection rule holds the protected publish job, Drydock reviews and posts approve/reject. Authority ends at that configured job. Shared plumbing: `server/lib/workflow-gates/`; ecosystem behavior in `server/lib/ecosystems/<id>/workflow-gate.ts`.

| Rule | Behavior |
| --- | --- |
| Shard family `pypi-release-candidate-*` | PyPI only (`shardedArtifactNames`); npm and VS Code match exact artifact names |
| Shard processing | each outer ZIP capped, downloaded, digest-verified, sandbox-parsed, discarded before the next; baselines also sequential |
| Larger shard budget | only for release targets that pin an ecosystem; auto-detect targets keep the single-upload budget |
| Same distribution filename in two shards | accepted once if bytes match; gate fails if they differ |
| Duplicate text across platform wheels | retained once; paths, hashes, sizes, flags stay per artifact |
| Baseline body retention | mirrors the candidate's per wheel namespace: both sides carry a body or neither does, so a changed file never renders as a one-sided hunk (`server/lib/ecosystems/pypi/acquire.ts`, `test/pypi.test.mjs`) |
| Baseline exists but exceeds download budget | `BaselineInfo.comparisonSkipped`; findings marked `unknown` package context; report leads "no baseline to compare"; advisory recommendation `manual_review` |

Full contract: [`workflow-gates.md`](./workflow-gates.md), [`pypi-workflow-gate.md`](./pypi-workflow-gate.md).

## Scheduled discovery

Cron (every 15 minutes, `server/scheduled.ts`) sweeps organizations with validated npm connections and starts scans for new staged publishes through the same pipeline.

| Case | Handling |
| --- | --- |
| Transport failure (status `0`), 408, 429, 5xx | `staged_publishes.cron.org_failed` with `transient: true` at **warn** (`isTransientSweepFailure`); next tick retries |
| Other statuses, D1 errors, sweep bugs | same event at **error** |
| Expired npm token | `recordExpiredNpmConnection`, never the failure log |
| Many new stages in one org | started through `mapWithConcurrency`, capped at `STAGED_PUBLISH_SCAN_START_CONCURRENCY` (`server/lib/ecosystems/npm/staged-publishes-discovery.ts`); raise only after measuring CPU per tick |
| Same stage visible to several orgs | one `StageStartCoordinator` per cron run starts matching stage ids one at a time |
| Package with a durable claim | only the canonical org may scan; claim and scan insert commit together ([`package-claims.md`](./package-claims.md)) |

Repeated transient failures are not escalated (no cross-tick counting).

## Data stores

| Store | Binding | Holds |
| --- | --- | --- |
| D1 | `DB` | Better Auth tables, orgs, npm connections, scans and lifecycle, workflow gates, release targets, audit/event metadata. Operational source of truth. |
| R2 | `ARTIFACTS` (required) | canonical `report.json`, redacted file samples, `diff.json`. Scan detail and findings are read from here, digest-verified against D1 ([`artifact-storage.md`](./artifact-storage.md)). |
| KV | `COMPARE_CACHE`, `AUTH_SESSIONS` | registry/compare/public-diff caches; Better Auth session cache (optional, D1 without it) |
| Queues | `SCAN_QUEUE` | scan and workflow-gate messages (`server/queue.ts`) |
| Workflows | `PUBLISHER_SETUP_WORKFLOW` | durable publisher setup jobs ([`publisher-setup.md`](./publisher-setup.md)) |
| Workers AI / AI Gateway | `AI` | advisory AI review; never authoritative over deterministic findings |
| Flagship | `FLAGS` | per-org flags: `ai-review` (killswitch, on by default), `clef-injection-screen` (default off) |
| Analytics Engine | `PRODUCT_ANALYTICS` | aggregate counters ([`product-analytics.md`](./product-analytics.md)); AI aggregate dimensions by reviewer version |

All bindings with required/optional status: [`self-hosting.md`](./self-hosting.md); types are hand-declared in `server/env.d.ts`.

## Organization and auth model

| Rule | Detail |
| --- | --- |
| Non-auth `/api/*` | Better Auth session + active organization, except the anonymous surfaces listed in [`security-model.md`](./security-model.md) |
| Organization API keys | accepted instead of a session only on allowlisted routes: reads; plus starting a review and "Check npm" for `scan` keys; plus staged-publish decisions for `decide_staged` keys. No key decides a workflow gate ([`api-keys.md`](./api-keys.md)) |
| Scoping | scans, npm connections, workflow gates, release targets, Slack installs, settings are organization-scoped |
| `x-organization-id` | a selector only; a non-member selector falls back to the caller's personal organization |
| `x-organization-strict: 1` | non-member selector returns `403 not_organization_member` instead of falling back (pages whose URL names the org) |
| Members, invitations, email verification | [`organization-members.md`](./organization-members.md) |

## npm connection model

Each organization stores its own encrypted npm connection (`NPM_CONNECTIONS_ENCRYPTION_KEY`). The UI validates registry auth/list access after save; discovery and scan workers re-check validation before use. Custom registries are supported; token use still flows only through `NpmStageGateway`.

## Report model

| Property | Rule |
| --- | --- |
| Canonical export | `drydock.report.v2`: stable ordering, release/artifact/context risk sections, redacted evidence, artifact identity |
| Signing boundary | public shares serve those exact bytes at `/public/reports/:token`; attestation signs their SHA-256 in DSSE ([`public-reports.md`](./public-reports.md)) |
| Changing the export | changes attested bytes; bump the schema tag when consumers must branch |

## Package API

| Endpoint | Auth | Owner |
| --- | --- | --- |
| `GET /api/v1/packages/:name/releases[?ecosystem=&cursor=&limit=]` | session + active org | `server/routes/packages.ts`, `server/db/scan-package-releases.ts` |
| `GET /api/v1/packages/:name/badge[?ecosystem=]` | member | `server/routes/packages.ts`, `server/db/package-badge.ts` |
| `PUT /api/v1/packages/:name/badge[?ecosystem=]` | owner/admin, audited; `enabled: false` only for a registry-verified publisher org | same |

Releases view: keyset-paginated with the list cursor, newest first. Package identity is `coalesce(registry_package_name, package_name)` within one ecosystem (`scanEcosystemSql`, the SQL twin of `scanEcosystem`). A pending gate scan without a known ecosystem is not listed. Rows add dist-tag (`summary_json.stagedPublish.tag`), persisted baseline, and decider display name; the summary block has total reviews, per-channel counts, newest release, and published-without-decision / published-over-a-block counts.

Badge opt-out: one registry-verified publisher's switch silences the badge for every organization; a row whose org lost that evidence is ignored. Keyed by the badge's own key, so name normalization matches the badge route ([`public-badge.md`](./public-badge.md)).

## API conventions

- Share request/response types between `server/` and `src/`; use route helpers and typed fetch wrappers.
- Update this file only for changes to runtime shape, trust boundaries, storage, or cross-layer contracts.
