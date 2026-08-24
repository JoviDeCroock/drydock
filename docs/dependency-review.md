# Dependency-artifact review

Drydock reviews the exact bytes of the release in front of it. A release that **adds a dependency** ships third-party code into every consumer install without any of those bytes appearing in the reviewed artifact — the manifest gains one line, and the report used to stop there.

That is a real propagation path, not a hypothetical one:

1. a maintainer account or release workflow is compromised;
2. the candidate release adds a dependency;
3. that dependency executes during install or build and fetches a payload;
4. consumers trust the parent package and inherit the payload.

The 2026 `arrayref` compromise is the reference case: `arrayref@0.3.10` added `proc-macro1`, whose `build.rs` downloaded a malicious payload, and the malicious versions were pulled afterwards — which is also why the review record has to survive the artifact disappearing.

Dependency-artifact review closes that gap for **newly introduced direct dependencies** on the npm release paths (staged publish and workflow gate). It is not SCA, not reputation scoring, and not a vulnerability database. It extends exact-artifact release review to the new third-party code a candidate release starts pulling in.

## What a review packet can now say

> This release introduces `arrayref@0.3.10 → proc-macro1@0.1.0 → package.json#scripts.postinstall → shell command that fetches and executes remote code`.

## Scope

Selected (`selectAddedDependencies`, `server/lib/review/dependency-selection.ts`):

- `dependencies` and `optionalDependencies` — a plain consumer install downloads both;
- **required** peers — npm 7+ installs peers automatically, so a required peer this release newly declares, or changes from optional to required without the same runtime spec already installed, is code that starts arriving in consumer trees because of it; a same-named runtime declaration suppresses review only when its effective spec matches the new peer;
- a required peer moved into an installing section with a different spec — the changed range can resolve package bytes that were not covered by the previous release's peer declaration.

When the same key appears in both `dependencies` and `optionalDependencies`, npm treats the optional declaration as the effective install spec. Selection follows that precedence so Drydock reviews the version consumers actually resolve.

Deliberately excluded:

- `devDependencies` — no consumer install fetches them;
- optional peers (`peerDependenciesMeta[name].optional`) — a consumer opts into those rather than inheriting them;
- keys that were already installed at the same effective spec and merely moved between sections — a relocation ships no new code; moving to or adding an overriding declaration at a different spec is reviewed because npm can resolve different bytes;
- dependencies declared through `bundleDependencies` / `bundledDependencies` whose direct child under `node_modules/` has a readable `package.json` with the matching name and a version are not fetched from the registry. npm still runs lifecycle scripts inside bundled children, so Drydock assesses the exact embedded child subtree and its own manifest before the raw parent files are released; a placeholder directory does not suppress registry review;
- every dependency of a first-ever release (no baseline manifest), where the whole list diffs as "added" and inspecting it would describe the package rather than the release.

A missing baseline manifest caused by metadata, connection, download, or parsing failure is not a first release. A parseable staged manifest that lacks its package name or version is likewise an acquisition gap rather than proof that no prior release exists. In those cases Drydock conservatively selects every staged install dependency so the comparison gap cannot turn dependency review into `not-applicable`.

The same relocation and previously-installed signals the `dependency.added` rule reads are reused here, so one surface cannot say "no new dependency" while the other says the opposite.

Transitive closure is **out of scope** for now. So is any ecosystem other than npm — PyPI build backends and Cargo build scripts are the natural next adapters, and the capability is optional on `PackageAdapter` precisely so they can be added without touching the pipeline.

## How a dependency is reviewed

`server/lib/ecosystems/npm/dependency-artifacts.ts` owns resolution and acquisition, `server/lib/review/dependency-selection.ts` owns dependency selection, `server/lib/review/dependency-analysis.ts` owns install observations, and `server/lib/review/dependency-evidence.ts` owns persistence and finding projection.

1. **Resolve** the declared spec against the registry's published versions. A dist-tag resolves through the packument's tag map (a tag is a moving pointer, not a range). For a range, Drydock mirrors npm's default-tag preference without letting a deprecated `latest` override a healthy match: use non-deprecated `latest` when it satisfies the range, otherwise use the highest non-deprecated satisfying version, and consider deprecated versions only when every satisfying version is deprecated. The bounded matcher in `server/lib/ecosystems/npm/semver.ts` rejects non-canonical numeric identifiers, unsafe integers, invalid prerelease identifiers, oversized specs, excessive union branches/comparators, and grammar it cannot represent rather than selecting bytes npm would ignore or spending unbounded synchronous CPU.
2. **Acquire exact bytes.** Registry dependencies stream into the credentials-free sandbox exactly like the previous-version baseline. Bundled direct children are read from their embedded `node_modules/<name>/` subtree instead, so a registry snapshot can never replace the bytes consumers actually receive. Neither path installs or executes package code.
3. **Assess** the parsed bytes with the same deterministic rule set the reviewed release gets, then record install execution and dangerous behavior as separate observations. When danger-shaped behavior exists but the install graph cannot prove or disprove the edge, risk is `unknown`, never a safety verdict.
4. **Record** the declaration, the review-time resolution, the digest the registry advertised, the digest recomputed from the bytes fetched, and the observations. Artifact provenance retains only the registry origin; every registry-controlled path, plus URL userinfo, query parameters, and fragments, is discarded before persistence so signed download capabilities cannot enter a public report. Bundled evidence carries no registry digest because the parent artifact's own digest binds those embedded bytes.

### Observations

Coverage, execution, and risk are intentionally separate:

| Axis      | Values                                  | Meaning                                                                                                     |
| --------- | --------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| Coverage  | `inspected` / `uninspectable`           | Whether the exact artifact bytes and install metadata were completely available to the bounded analyzer.    |
| Execution | `observed` / `not-observed` / `unknown` | Whether an automatic install or build entrypoint was observed.                                              |
| Risk      | `observed` / `not-observed` / `unknown` | Whether the install path reaches danger-shaped behavior; `unknown` means the graph could not close an edge. |

An aggregate review is `complete` only when every selected dependency is inspected. Any uninspectable or omitted dependency makes it `partial`.

"Something runs on install" means a `preinstall`/`install`/`postinstall` script, or an implicit `node-gyp` build. Process execution alone is deliberately **not** a danger capability: prebuilt-binary packages spawn `node-gyp` by design, and treating that as blocking would make every release adding a native dependency unapprovable — which is how a tier stops meaning anything. When the install-reachable path contains both a process launch and a bundled native artifact, however, Drydock reports a proven high-risk native execution path rather than describing it as network-capable.

### Findings and severity

Findings are namespaced to the dependency path with a synthetic `<dependency>name@version:path` file label. There is no such file in the release's own diff, so the label is never an open-in-the-workbench link (`isDependencyFindingFile`).

Gate severity is policy applied after observation. **Certainty** asks whether the install hook can statically reach the behavior; static reachability can miss a dynamic edge, so unknown reach is demoted rather than dropped. **Strong** asks whether the behavior has a benign reading — remote shell, credential access, dynamic evaluation, and embedded secrets do not; a plain HTTPS download does.

| Rule ID                                  | Severity   | When                                                                                                                                                               |
| ---------------------------------------- | ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `dependency-artifact.install-risk`       | `critical` | Strong behavior, provably reachable from the install hook. The arrayref shape.                                                                                     |
| `dependency-artifact.install-risk`       | `high`     | Strong behavior present but unproven reach, a provably reachable install-time download, **or** a reachable process launch paired with a bundled native executable. |
| `dependency-artifact.install-risk`       | `medium`   | Install-time download present but unproven reach.                                                                                                                  |
| `dependency-artifact.install-execution`  | `medium`   | Runs on install, nothing of the above behind it.                                                                                                                   |
| `dependency-artifact.capability`         | `info`     | Reviewed, nothing runs on install; records what the artifact can do.                                                                                               |
| `dependency-artifact.integrity-mismatch` | `critical` | Fetched bytes disagree with the digest advertised by the registry; the review is invalid.                                                                          |
| `dependency-artifact.uninspectable`      | `medium`   | Drydock could not review the dependency's own bytes.                                                                                                               |

Both `critical` and `high` land on "block manual approval", so an install-time download does hold the release — a newly added dependency that fetches on every consumer install is worth reading once. It sits a tier below the dropper because `prebuild-install` fetching a platform binary and a dropper fetching a payload look identical to a scanner, and spending `critical` on `sharp` leaves nothing for the dropper. `added-dependency-prebuilt-downloader` in the corpus is that call, written down.

Reachability comes from `lifecycleReachablePaths` (`server/lib/review/rules/reachability.ts`), which seeds **only** from install/build entrypoints — narrower than the consumer-reachable walk, because "installing this runs it" and "requiring this can run it" are different claims. Named scripts reached through `npm run` / `npm run-script` are part of that install chain and are expanded recursively, including invocations with npm config flags before or after the subcommand. Inline commands in the expanded chain are scanned separately: the whole manifest is one file, so a capability elsewhere in `scripts.test` or another unrelated field must not be attributed to every consumer install merely because its finding is filed against `package.json`. The walk follows relative specifiers only, so an unproven edge downgrades severity rather than disappearing.

The whole family is release-scoped (`isReleaseScopedFinding`), so it counts toward `releaseRisk` and therefore reaches the workflow gate. That remains true when baseline acquisition failed: the file diff status is honestly `unknown`, but evidence about a dependency this release introduces must not be downgraded to package context. A `critical` install-risk finding puts the release at "block manual approval".

`info` when no install execution is observed is the load-bearing choice in the other direction: adding a dependency is normal software work, and a benign new dependency must not make a release high risk just for being new.

### Where it runs in the pipeline

`analyzeRelease` runs the pass **after** `releaseResolvedArtifacts`, not before. The pass makes bounded network calls and needs only the redacted manifest diff, so keeping both unredacted package sides alive for its duration would raise the scan's peak memory — which is what caps reviewable package size. `applyDependencyReview` folds the resulting findings back into the same `DeterministicFindings` arrays, so they are redacted, annotated, scored, and persisted exactly like any other rule finding. `test/scan-pipeline-phases.test.mjs` pins the ordering.

## Resolution honesty

A review-time resolution is a **snapshot**, never permanent provenance. The report distinguishes:

- **exact evidence** — the candidate's bytes, the dependency declaration, and the dependency bytes Drydock fetched with the digest it recomputed from them;
- **resolved snapshot** — the version selected at review time (`declarationKind: "range"`);
- **dist-tag exposure** — the declaration points at a moving tag, so the bytes can change with no manifest change at all (`"tag"`);
- **exact version** — the declaration fixes the version coordinate, but not the bytes; the recomputed digest remains the byte-level review evidence (`"exact"`);
- **unresolved / uninspected** — no artifact was read, so the release cannot be represented as fully reviewed (`"unusual"`, or any `uninspectable` reason).

`digestVerified` is three-valued on purpose: `true` when the registry's advertised digest and the recomputed digest agree, `false` when they disagree, and `null` when one was missing or unsupported. A missing digest is unverified, never a match. When an SRI lists several SHA-512 digests, matching any one follows npm's integrity semantics; the matching digest is the one retained in the evidence row. A valid legacy `dist.shasum` is used only when `dist.integrity` is absent. If integrity is present but has no supported SHA-512 token or exceeds the retained metadata bound, Drydock preserves that presence and does not fall through to SHA-1 and claim that the registry's authoritative SRI was verified.

## Failing visibly

Every way a dependency can end up unreviewed produces an evidence record and a `medium` finding, which floors the release at "review carefully":

| Reason                 | Cause                                                                                                         |
| ---------------------- | ------------------------------------------------------------------------------------------------------------- |
| `unresolvable-spec`    | git / URL / workspace-protocol spec, or grammar the range parser cannot model.                                |
| `no-matching-version`  | Nothing published satisfies the spec.                                                                         |
| `metadata-unavailable` | The registry answered nothing to a credential-free request — the private-dependency case.                     |
| `artifact-unavailable` | The tarball could not be downloaded.                                                                          |
| `artifact-too-large`   | Past the sandbox's size or entry caps.                                                                        |
| `artifact-unparseable` | Not a parseable package archive.                                                                              |
| `artifact-ambiguous`   | Links, duplicate paths, or visually-confusable paths make extraction semantics ambiguous.                     |
| `artifact-truncated`   | At least one file was clipped or retained hash-only; partial evidence is not graded as the complete artifact. |
| `manifest-unavailable` | The archive has no readable root `package.json`, so lifecycle behavior cannot be assessed.                    |
| `budget-exhausted`     | The dependency-count cap or the whole-pass deadline stopped the review before this artifact was fetched.      |
| `review-failed`        | The adapter-level dependency pass failed before the dependency could be inspected.                            |

`budget-exhausted` and `review-failed` records aggregate into bounded findings — a refactor or hostile manifest with many dependencies must not fill the packet with identical mediums or inflate persisted evidence. The report preserves the full selected/uninspectable counts, retains at most `MAX_RECORDED_DEPENDENCIES` (64) individual rows, and discloses the omitted count.

## Safety and bounds

- Dependency bytes are hostile evidence, handled exactly like the reviewed release's bytes: downloaded by the trusted parent, streamed into the credentials-free sandbox, never installed, never executed, never imported.
- **Every dependency fetch is credential-free, and the token is never even decrypted on this path.** `NpmBroker.registryUrl()` reads the connection row for its registry URL and stops there — asking which registry to talk to cannot become a reason to hold a credential in scope. The broker snapshots that URL on its first lookup so provenance, metadata, and tarball origin checks cannot drift to different registry connections during one scan. It applies the same connection preconditions as the credentialed path, so a scan cannot silently fall back to the public registry for an organization whose connection is missing or unvalidated, and it is resolved lazily so a release that adds no dependency does no work at all. `NpmBroker.fetchAnonymousPackageMetadata` / `downloadAnonymousTarball` are separate methods rather than a flag on the credentialed ones, because the two differ in exactly the property that matters and a boolean parameter is the kind of thing a later refactor flips by accident. A dependency only a credential could reach records as `metadata-unavailable`; private-dependency support needs its own credential and cache-isolation review.
- Anonymous packuments and dependency tarballs bypass shared registry caches so a range or dist-tag and its bytes come from the registry's current snapshot. This matters for custom registries that may mutate a version-pinned URL in place; the recomputed digest then binds the evidence to the bytes fetched in this pass.
- Bounds per release: `MAX_INSPECTED_DEPENDENCIES` (6) registry artifacts fetched, `MAX_RECORDED_DEPENDENCIES` (64) evidence rows persisted across embedded and registry evidence, `DEPENDENCY_ARTIFACT_MAX_FILES` (600) full-text entries retained per fetched artifact, `DEPENDENCY_TEXT_SAMPLE_LIMIT` (256 KiB) per file, a 32 MiB packument body cap with a 15 s body-read deadline, npm ranges capped at 4,096 characters / 64 union branches / 32 comparator tokens per branch / 64 expanded comparators total, and a 20 s wall-clock deadline for the network pass. Any file clipped by the text-sample cap or retained hash-only with `content-skipped` makes that dependency visibly `artifact-truncated`. If an install-reachable module uses a computed `require()` or `import()`, every deliberately omitted file body is treated as a possible target regardless of extension. A missing/unreadable root manifest or an archive with active non-regular, duplicate, or confusable paths likewise fails visibly instead of receiving a not-observed result. A prefix or digest without complete, unambiguous install evidence is never treated as a complete review. The deadline includes registry-connection lookup, aborts anonymous metadata bodies and tarball streams inside the broker, stops awaiting an in-flight broker call, and fences a late metadata response from starting an artifact fetch. Archive size caps are the sandbox's own.
- The pass adds evidence to the release, but a terminal dependency record replaces the older manifest-only `dependency.added` or `dependency.optional-added` finding for the same declaration. That keeps an inspected dependency with no observed install behavior low risk and lets the more precise observation or uninspectable evidence set the gate tier. Dependencies omitted by the record budget keep their declaration-only finding. An adapter without the capability yields an empty review, while a capable adapter that throws yields a bounded `review-failed` coverage gap for every selected dependency. Failures are logged (`scan.dependency_review.failed`) and remain visible to the gate.
- AI review may explain dependency evidence but cannot downgrade it — the same rule that applies to every other deterministic finding.

## Persistence

The review is secret-redacted before finding projection and persisted in `scans.summary_json.dependencyReview`, in the digested report payload, and in the `drydock.report.v2` export (`dependencyReview`, `null` for scans that predate the feature). Findings persist as ordinary `scan_findings` rows.

That is deliberate: the `arrayref` malicious versions were unpublished after the fact. Once the version is gone, the record still says what was declared, what it resolved to, which bytes were read, what digest they had, and what they did. Persisted blobs are re-validated through `normalizeDependencyReview` on the way out rather than trusted, so a malformed or pre-feature record renders as "no dependency review" instead of half a record.

## Surfaces

`src/features/review/DependencyReviewSection.tsx` renders the section in both the authenticated scan workbench and the public report, above the manifest diff — the manifest shows that a dependency line was added, this shows what adding it ships. Its tone and explanatory copy use the same policy mapping as deterministic finding projection, so unknown medium/high evidence is not presented as observed critical behavior.

## Tests

| Layer                                                                                              | Covers                                                                                   |
| -------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| `test/npm-semver.test.mjs`                                                                         | Range grammar, prerelease rules, structural bounds, unresolvable specs.                  |
| `test/dependency-evidence.test.mjs`                                                                | Selection, assessment, finding projection, persisted-blob validation.                    |
| `test/npm-dependency-artifacts.test.mjs`                                                           | Resolution, digest binding, every uninspectable path, deadlines, record budgets.         |
| `test/security-corpus-dependencies.test.mjs` + `test/fixtures/security-corpus/cases-dependencies/` | Golden fixtures, including benign, invalid-artifact, and reachability calibration cases. |
| `test/scan-pipeline-phases.test.mjs`                                                               | Adapter-capability wiring, release scoping, degrade-on-throw.                            |
| `test/workers/scan-report-export.test.ts`                                                          | The persisted record survives into the export.                                           |
| `test/e2e/local-registry.spec.ts` (`added-dependency`)                                             | End-to-end against the fake registry, plus the credential-free journal assertion.        |

## Follow-up scope

- Recursive inspection of the newly introduced transitive closure, with depth and node budgets.
- Consumer-side lockfile review for Dependabot/Renovate PRs.
- Re-evaluation when a reviewed dependency is yanked, deleted, or receives an advisory.
- Ecosystem adapters for Cargo build scripts and PyPI build backends.
