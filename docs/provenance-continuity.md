# Registry provenance continuity

Compares registry-reported build provenance across published releases to flag a drop or changed publisher identity. **Authority:** enforced deterministic findings (presence alone is not a safety signal). **Owner:** `server/lib/provenance-continuity.ts`.

## At a glance

| Thing | Owner | Trigger / caller | Pinned by |
| --- | --- | --- | --- |
| Rules + `provenanceLineage` | `server/lib/provenance-continuity.ts` | Published npm/PyPI pairs | `test/provenance-continuity.test.ts` |
| npm reader + lineage | `server/lib/ecosystems/npm/provenance.ts` | Ecosystem `publicDiff.acquire` | `test/public-diff-npm-provenance.test.ts` |
| PyPI reader + lineage | `server/lib/ecosystems/pypi/provenance.ts` | Ecosystem `publicDiff.acquire` | `test/provenance-continuity.test.ts` |
| Registry-record corpus | `test/helpers/provenance-security-corpus.mjs` | Golden + eval fixtures | `test/security-corpus-provenance.test.mjs`; [`security-detection-corpus.md`](./security-detection-corpus.md#registry-provenance-corpus) |
| Public cache | `server/lib/public-diff/index.ts` | Anonymous `/diff` | `test/workers/public-diff-routes.test.ts` |

## Contract

### Findings

Both rules use the `release.*` family, `<release-process>` file label, release-delta attribution and release risk, like [`release.source-drift`](./release-fingerprint.md).

| Rule | Severity | Fires when |
| --- | --- | --- |
| `release.provenance-dropped` | medium | Baseline and the two releases before it in the candidate's channel are attested; candidate affirmatively has none (`ESTABLISHED_PROVENANCE_RELEASES` in `server/lib/provenance-continuity.ts`). |
| `release.provenance-dropped` | low | Same drop with fewer than three consecutive attested releases; or an unattested stable after an attested prerelease when no earlier stable carries provenance. |
| `release.provenance-publisher-changed` | medium | Both sides attested; candidate names a new repository, or a different repository id when both sides carry one (even under the same name). |
| `release.provenance-publisher-changed` | low | Same-owner repository change without ids on both sides; or a new workflow in the same repository. |

### Surfaces and baseline

| Surface / condition | Behavior |
| --- | --- |
| Anonymous `/diff` | npm + PyPI published pairs. |
| Authenticated published-pair review | Same readers through `server/lib/ecosystems/published-pair.ts`, including post-release review started from a [publication monitor](./publication-monitor.md) alert. |
| Staged npm / workflow gates | Not evaluated: candidate has no published registry provenance yet. |
| pkg.pr.new preview / VS Code | Not evaluated. |
| atpm | Uses its own verified-provenance rules, including `atpm.trusted-publishing-lost`; [`atpm.md`](./atpm.md). |
| Publication monitor observation | Hashes bytes only; does not itself read provenance. |
| Forward order | Candidate must be newer than requested baseline: semver (npm), PEP 440 (PyPI). Reverse, equal and unparseable pairs are not evaluated. |
| Stable candidate | Compare earlier stable releases only; provenance baseline is separate from the diff baseline, whose suggested/default semver predecessor can be the candidate's CI-built prerelease. |
| Prerelease candidate | May follow stable or prerelease releases. |
| Publication order | Skip releases published after the candidate (e.g. a 4.x maintenance release adopting provenance after 5.0.0); known equal publish times do not qualify either. |
| Baseline substitution | If requested baseline fails channel or publication-order tests, use the highest qualifying release and name it in evidence. |
| Set-aside prerelease | An unattested stable after an attested requested prerelease is low when the earlier stable is absent or none exists; adoption during betas remains visible while prerelease-only attestation stays context. |
| Publish time | npm packument `time`; PyPI release's earliest file upload (later interpreter wheels do not change it). |
| Unknown | No finding from an unknown baseline/candidate; unreadable identity prevents identity comparison. Unknown prior history prevents a medium drop but a confirmed drop can still be low. |

### Registry sources

| Registry | Presence | Identity / response |
| --- | --- | --- |
| npm | Registry-written `versions[v].dist.attestations.provenance`, projected as `hasProvenance` by `projectRegistryMetadata` in `server/lib/ecosystems/npm/registry.ts`; publisher cannot write it. Packuments cached before projection read unknown. | `GET https://registry.npmjs.org/-/npm/v1/attestations/<name>@<version>` → `{ attestations: [{ predicateType, bundle }] }`; Sigstore `bundle.dsseEnvelope.payload` is a base64 in-toto statement. |
| npm statement selection | Packument decides presence even when identity cannot be read. | `https://slsa.dev/provenance/*` predicate whose statement subject is `pkg:npm/<name>@<version>` (scoped `@` encoded as `%40`). |
| PyPI | [PEP 740](https://peps.python.org/pep-0740/), [integrity API](https://docs.pypi.org/api/integrity/): checks the diff's selected sdist + wheel. | `GET https://pypi.org/integrity/<project>/<version>/<filename>/provenance`, `Accept: application/vnd.pypi.integrity.v1+json` → `{ version: 1, attestation_bundles: [{ publisher, attestations }] }`. |
| PyPI GitHub publisher | Written by PyPI from the uploading Trusted Publisher. | `{ kind: "GitHub", repository: "owner/repo", workflow: "release.yml", environment }`. |
| PyPI GitLab publisher | Written by PyPI from the uploading Trusted Publisher. | `{ kind: "GitLab", repository, workflow_filepath, environment }`. |
| PyPI other publishers | Google and other service identities remain present. | Unreadable repository identity. |
| PyPI file aggregation | Any attested checked file makes the release present; absent only when every checked file is affirmatively absent; otherwise unknown. | Other wheels may be attested while checked files are not; evidence explicitly says "none for the checked files". |
| PyPI absence | Only HTTP 404 with JSON `{"message":"No provenance available for <filename>"}`. | HTML 404, HTTP 403 (integrity API administratively disabled), 406 and every other failure shape are unknown. A readable HTTP 200 with unrecognized document shape stays present with unreadable identity. |

| npm build type | Repository | Workflow | Stable id |
| --- | --- | --- | --- |
| SLSA v1: `https://slsa-framework.github.io/github-actions-buildtypes/workflow/v1` (npm ≥ 9.6 on GitHub Actions) | `buildDefinition.externalParameters.workflow.repository` | `buildDefinition.externalParameters.workflow.path` | `buildDefinition.internalParameters.github.repository_id` |
| SLSA v0.2 GitHub: `https://github.com/npm/cli/gha/v*` (early 2023 statements) | `invocation.configSource.uri`, `git+https://github.com/<repo>@<ref>` | `invocation.configSource.entryPoint` | `invocation.environment.GITHUB_REPOSITORY_ID` |
| SLSA v0.2 GitLab: `https://github.com/npm/cli/gitlab/*` | `invocation.configSource.uri` | `invocation.parameters.CI_CONFIG_PATH` | `invocation.parameters.CI_PROJECT_ID` |
| Other (e.g. `--provenance-file`) | Unreadable identity; present provenance retained. | — | — |

### Read bounds and caching

| Setting | Value / owner |
| --- | --- |
| Origins / credentials | Fixed registry origins over TLS; no credentials; `redirect: "manual"` in both readers. |
| Request attempts / timeout | One attempt, 5 seconds (`FETCH_TIMEOUT_MS` in both provenance readers); no retry because every warm-cache diff pays the latency and a lost read only loses a comparison. |
| JSON body | 256 KiB via `readBoundedJson` (`MAX_ATTESTATIONS_BYTES` in npm reader; `MAX_PROVENANCE_BYTES` in PyPI reader). |
| Entries | At most 8 attestations / bundles (`MAX_ATTESTATIONS` / `MAX_BUNDLES` in the respective readers). |
| DSSE payload | At most 128 KiB of base64 text (`MAX_PAYLOAD_BASE64_LENGTH` in npm reader), before decoding. |
| Attested strings | At most 256 characters, no control, zero-width or bidi formatting before evidence/comparison (`MAX_ATTESTED_FIELD_LENGTH`, `attestedField` in `server/lib/provenance-continuity.ts`). Workflow names are attacker-influenced even in registry-served records. |
| npm history | No extra fetches: projected `hasProvenance` for every packument version is already in memory. |
| PyPI history | Read only for baseline-present/candidate-absent drops; one integrity request per prior release, representative sdist else first wheel by name (`representativeFilenames` in PyPI reader). |
| Settled immutable `/diff` | 30 days (`CACHE_TTL_SECONDS` in `server/lib/public-diff/index.ts`). |
| Undetermined side / history | 15 minutes (`UNSETTLED_READ_CACHE_TTL_SECONDS` in `server/lib/public-diff/index.ts`), so transient failures do not hide findings for a month. |
| Authenticated published-pair review | Persisted result, no automatic rerun; rescan to reread registry provenance. |

## Invariants

1. Unknown is never evidence of a dropped attestation or changed publisher; `provenanceContinuityFindings` only compares confirmed presence/absence or readable identities (`server/lib/provenance-continuity.ts`).
2. Neither reader re-verifies Sigstore signatures: npm validates provenance against the publishing identity and package repository before accepting it; PyPI verifies against the Trusted Publisher at upload and writes `publisher` itself. Findings say what the registry reports, never "verified" (`server/lib/ecosystems/npm/provenance.ts`, `server/lib/ecosystems/pypi/provenance.ts`).
3. atpm re-verifies publisher-writable bundles against a pinned root; its trust argument differs from registry-served npm/PyPI records (`server/lib/ecosystems/atpm/record.ts`; [`atpm.md`](./atpm.md)).
4. Equal stable repository ids survive a rename or organization transfer silently; differing ids reveal deletion/re-registration even when the name is unchanged (`sameRepository` in `server/lib/provenance-continuity.ts`).
5. Repository and workflow comparisons are case-insensitive. Without ids on both sides, owner is the first repository path segment (GitLab's top-level group includes its subgroups), which an outside attacker cannot create repositories under; same owner is low, changed owner medium (`sameOwnerWithoutIds` in `server/lib/provenance-continuity.ts`).
6. Read failures degrade instead of failing a review. Operational events contain only status codes or status labels, never response bodies (`server/lib/ecosystems/npm/provenance.ts`, `server/lib/ecosystems/pypi/provenance.ts`).

## Failure modes

| Condition | Cause | Result | Action |
| --- | --- | --- | --- |
| Custom `NPM_REGISTRY`, including fake registry | Another registry's attestation endpoint has no npm-validated meaning. | Reader returns unknown; continuity skips evaluation. | Use public npm for registry provenance comparisons. |
| npm attestations fetch fails after present marker | Transient failure, unreadable document or unsupported build type. | Present with unreadable identity: a later drop can still fire; identity comparison stays quiet. | Rescan if identity matters. |
| Registry read unavailable | Network / invalid response. | `public_diff.npm_provenance.unavailable` or `public_diff.pypi_provenance.unavailable`; status only, no body. | Retry after short public cache expiry or explicitly rescan persisted reviews. |
| Confirmed drop on a legitimate release | Local hotfix, CI provider/setup without attestations, or project stops attesting. | Medium only after three consecutive attested releases; shorter history low (same history bar as `release.source-drift`). | Confirm publication method with maintainer. |
| New repository / monorepo | Legitimate project move or attack. | Medium repository change, low same-owner rename without stable ids (PyPI carries no id). | Confirm repository identity. |
| New workflow in the same repo | Routine rename or workflow split. | Low, context rather than release risk. | Confirm workflow intent. |
| Real CI compromised / wrong source checkout | Provenance identifies the workflow repository, not what it checked out. | Unchanged presence/identity stays quiet. | Review package behavior and source separately. |

## Change checklist

1. Change rule semantics → update version, inventory, behavior/history docs and exact synthetic registry-record corpus expectations; [`security-detection-corpus.md`](./security-detection-corpus.md).
2. Change lineage → pin channel, forward-version and publication-order boundaries in `test/provenance-continuity.test.ts`.
3. Change registry readers → preserve bounds, no credentials, manual redirects, unknown semantics and redacted status events; run `test/public-diff-npm-provenance.test.ts`, `test/provenance-continuity.test.ts` and `test/security-corpus-provenance.test.mjs`.
4. Change undetermined-read caching → verify `test/workers/public-diff-routes.test.ts`; run `pnpm run eval` after detection changes.

## Why

| Evidence / limitation | Detail |
| --- | --- |
| Presence is not safety | ChainDrop (keyv/cacheable, npm) retained valid provenance from the real repository; LiteLLM 1.107.0 used BerriAI's real release workflow with lookalike source. Continuity detects changes, not malicious contents. |
| Source-checkout blind spot | LiteLLM 1.107.0 would not fire on PyPI: its baseline lacked PEP 740 provenance. Even if present, PyPI publisher/npm SLSA name workflow repository `BerriAI/project-releaser`, not the checkout. Only build logs (`actions/checkout`: `Syncing repository: <owner>/<repo>`) or build-system provenance such as BuildKit's expose that source; neither registry records it. |
| Known legitimate drop | LiteLLM 1.83.0–1.83.14 had PEP 740 provenance from `BerriAI/project-releaser`; 1.84.0 onward had none, so 1.83.14 → 1.84.0 fires without a known compromise at that transition. Adoption often alternates one or two CI-attested releases with laptop publishes. |
| npm examples | `sigstore@3.0.0`: SLSA v1, repository id `495574555`; `sigstore@1.3.0`: SLSA v0.2, same id. `left-pad@1.3.0`: `404 {"error":"Not found"}`, no `dist.attestations`. |
| PyPI examples | `urllib3-2.5.0.tar.gz`: attested, `urllib3/urllib3`, `publish.yml`; `urllib3-1.26.20.tar.gz`: JSON 404 absence. |
| FP replay | 318 npm sweep packages, ten most recent stable pairs each, 3,171 pairs: seven medium drops (0.2%), versus fifteen before channel/publication-order/history filters. Removed cases were newer majors compared with maintenance releases published afterward, or short attested histories; remaining drops had established attestation history. Medium is the ceiling for repository-level rules, matching `atpm.trusted-publishing-lost`. |
