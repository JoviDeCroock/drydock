# Architecture

Drydock reviews release artifacts before a maintainer approves publication. The same scan pipeline handles npm registry-staged tarballs and GitHub workflow-gated artifacts by delegating ecosystem details to package adapters.

## Runtime components

```text
Browser UI
  │ same-origin authenticated fetch
  ▼
Hono Worker
  ├─ Better Auth session guard + organization ownership checks
  ├─ D1 persistence and R2 report/artifact storage
  ├─ Queue-backed scan/gate orchestration
  ├─ Dynamic Worker loader for untrusted archive parsing
  ├─ npm / PyPI / VS Code adapters and workflow-gate adapters
  └─ constrained brokers/gateways for registry/artifact downloads
        │
        ▼
      npm registry, PyPI, VS Code Marketplace, GitHub Actions artifacts

Dynamic Worker sandbox
  ├─ receives scan options and artifact URLs, not npm credentials
  ├─ fetches only through `globalOutbound` brokers/gateways
  ├─ parses tarballs, wheels, and VSIX artifacts safely
  └─ returns bounded file metadata, text evidence, and suspicious-entry flags
```

The Worker is the trusted control plane; the sandbox treats package bytes as hostile evidence. Route handlers should stay thin and call shared pipeline/library code so HTTP routes, queue consumers, and local `waitUntil()` execution behave the same.

## Trust boundaries

- **Browser/UI** — not trusted for authorization. It sends authenticated requests and renders escaped package text. It must not render package-provided HTML, scripts, images, SVG, or other active content.
- **Parent Worker** — authenticates users, resolves the organization, checks ownership, decrypts credentials only at the moment of registry use, invokes the sandbox, computes findings/risk, persists reports, and emits redacted audit events.
- **Dynamic Worker sandbox** — parses untrusted archive bytes. It must not execute code, install dependencies, resolve imports, run build steps, or receive token material.
- **NpmStageGateway** — the only place npm authorization is attached. Allowed npm egress is staged tarball fetch, package metadata JSON, and previous-version `.tgz` downloads needed for diffing.
- **PyPiBroker / VscodeBroker / GitHub artifact broker** — credential-free PyPI artifact downloads are restricted to `https://files.pythonhosted.org`; VSIX baseline downloads are restricted to allowed Marketplace/CDN hosts; GitHub artifact access is scoped to the workflow-gate installation/run being reviewed.

## Sandbox parser

Archive parsing is shared by the sandbox and tests rather than copied as strings. Tar parsing lives in `server/lib/tar-parser.js`; ZIP wheel/VSIX parsing is covered by `test/zip-parser.test.mjs` and adapter tests; shared fixture writers live in `test/helpers/archive-fixtures.mjs`. The parser enforces path safety, file-count and expansion caps, unsupported-entry reporting, duplicate-path handling, and fail-closed behavior. Both formats are parsed as a stream: entry bodies beyond the retention budget (`SANDBOX_MAX_TAR_BYTES`) — typically prepackaged platform binaries — are skipped rather than buffered, hashed with `crypto.DigestStream` on the way past, and recorded as `content-skipped` files/findings with path, size, and sha256 (so the diff can still prove whether an uninspected binary changed against the baseline); the first 64 discarded bytes are also retained and magic-byte sniffed (`sniffNativeArtifact`) into `native-elf`/`native-macho`/`native-pe`/`native-wasm` flags so extensionless platform binaries still raise `file.native-artifact`, all under a total stream cap (`SANDBOX_MAX_STREAM_TAR_BYTES`) enforced on both compressed wire bytes and decompressed output, so neither a high-ratio bomb nor padding that decodes to almost nothing can exceed the work budget. The streaming zip reader walks local file headers but cross-checks every central-directory record against them (consumers extract what the central directory says), failing closed on any mismatch and on data-descriptor, encrypted, or zip64 entries. VSIX archives are yazl-packed with data-descriptor entries, so they take a buffered central-directory-first parse under the wire cap instead of the streaming reader. `pnpm run fuzz` scales the archive-parser property suite for deeper exploration.

## Scan pipeline

`server/lib/scan-pipeline.ts` is the canonical orchestration layer. It accepts a `PackageAdapter` from `server/lib/adapters/types.ts`, then delegates ecosystem-specific behavior:

- input parsing and staged-detail summaries;
- artifact acquisition and baseline selection;
- package projection and deterministic findings;
- changed-file diff construction;
- report persistence and scan lifecycle updates.

`POST /api/v1/scans` creates a queued scan record. A Queue consumer in production, or local `waitUntil()` execution in development, runs the pipeline. The UI polls `GET /api/v1/scans/:id` for status and report data. `DELETE /api/v1/scans/:id` removes an organization-owned scan only when its persisted status is `failed`; all other lifecycle states return `409` and remain intact.

Baseline selection is tag-aware rather than simply highest-semver; see [`diff-baseline.md`](./diff-baseline.md).

## Workflow gates

Workflow gates reuse the scan pipeline when the registry cannot stage a release candidate. GitHub Actions uploads built release artifacts, GitHub Environment deployment protection pauses the publish job, and Drydock reviews artifacts before posting an accept/reject decision back to GitHub. Shared gate plumbing lives under `server/lib/workflow-gates/`; ecosystem details live in adapters. See [`workflow-gates.md`](./workflow-gates.md).

## Scheduled discovery

Cron-triggered npm discovery finds staged publishes for organizations with validated npm connections and creates scans using the same pipeline. Token-expiry and validation issues should surface through settings/UI status and redacted observability events.

## Data stores

- **D1** — Better Auth tables, organizations, npm connections, scans, scan files/findings, workflow gates, release targets, summaries, and audit/event metadata. D1 remains the operational source of truth.
- **R2** — canonical report JSON and redacted file/diff artifacts. D1 keeps compact metadata and historical fallback samples so list/detail pages remain cheap.
- **KV** — session-related state where configured.
- **Workers AI / AI Gateway** — optional advisory review path. The per-organization `ai-review` Flagship flag is a killswitch that is on by default; deterministic findings remain authoritative.

## Organization and auth model

All non-auth `/api/*` endpoints require a Better Auth session and an active organization, with one deliberate exception: the anonymous public package-diff endpoints under `/api/public/v1/package-diff` (below). Users may belong to multiple organizations; scan data, npm connections, workflow gates, release targets, Slack installs, and settings must be organization-scoped. Email verification and membership/invitation behavior are described in [`organization-members.md`](./organization-members.md).

## Public package diff

`/diff` is an anonymous marketing/utility surface: it diffs any two published versions of an npm package or PyPI project and runs the deterministic rule set over the newer artifact, reusing the scan pipeline's pure phases (`server/lib/public-diff.ts` with the PyPI side in `server/lib/public-diff-pypi.ts`, routes in `server/routes/public-diff.ts`). On npm, either side of the pair may also be a [pkg.pr.new](https://pkg.pr.new) continuous-release preview URL (validated by the shared parser in `src/lib/pkg-pr-new.ts`), so a pull-request preview build can be reviewed against a published release before it ships; preview refs are mutable, so pairs involving a preview are cached for at most 15 minutes and preview bytes never enter the shared tarball-byte cache. The endpoints take an `ecosystem` query parameter (`npm` default, or `pypi`); npm data comes from the canonical public npm registry, PyPI data from the `pypi.org` JSON API with artifact bytes only from `files.pythonhosted.org`. Because a PyPI release can carry dozens of platform wheels, each side of a PyPI diff is bounded to one sdist plus one wheel — preferring a wheel shape both versions publish, then the pure-Python `py3-none-any` wheel — and artifact contents are namespaced (`sdist/…`, `wheel/<tags>/…`) in the diff tree. The endpoints are mounted before the auth middleware, use no credentials, and are enabled only when `NPM_REGISTRY` is the canonical public npm registry; deployments configured for a custom registry return 404 for this API (including its PyPI mode, since a custom registry signals a private deployment). They persist no review data to D1 and never run AI review. Abuse control is per-IP rate limiting (expiring D1 `rate_limits` buckets), the shared anonymous tarball-byte cache described in [`diff-baseline.md`](./diff-baseline.md), and a versioned computed-result cache: an awaited `caches.default` write makes the first file navigation immediately available in the serving colo, while a 30-day `COMPARE_CACHE` KV entry supports cross-colo reuse. File-content cache misses share the stricter version-pair computation budget, while cache hits retain a higher navigation allowance. Cache keys include the ecosystem and the deterministic-rules and risk-schema versions (PyPI keys additionally carry the PyPI rules version and normalize the project name per PEP 503) so detection changes cannot reuse stale assessments; oversized KV values omit file samples based on their UTF-8 byte size. Sandbox archive caps bound per-request work. Version-pair responses require origin revalidation so a deployment cannot leave browsers on an older analysis, while `Cache-Tag: public-diff:<package>` (npm) and `Cache-Tag: public-diff:pypi:<project>` remain available for package-level purges. The static `/diff` shell is also used for direct detail URLs (`/diff/<name>/<from>/<to>` for npm, `/diff/pypi/<project>/<from>/<to>` for PyPI), with Worker-side HTML rewriting of package-specific title, description, Open Graph, Twitter, and canonical metadata before the client renders. Findings run on raw text samples before redaction — the same order as the scan pipeline — and only redacted evidence is cached or returned.

## npm connection model

Organizations store their own encrypted npm connection. The UI validates baseline registry auth/list access after save; discovery and scan workers re-check validation before use. Custom registries are supported, but token use still flows only through the constrained npm gateway.

## Report model

Reports should remain canonical and future-signable: stable ordering, explicit release/artifact/context risk sections, redacted evidence, and enough metadata to reproduce the reviewed artifact identity. Public signed reports are future work; do not expose signing semantics until the report contract is finalized.

## API direction

Keep request/response types shared between `server/` and `src/`. Prefer route helpers and typed fetch wrappers over ad hoc shape duplication. New API behavior should update this file only when it changes runtime shape, trust boundaries, storage, or cross-layer contracts; otherwise point to route-local tests and code.
