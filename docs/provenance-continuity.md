# Registry provenance continuity

A valid build attestation says _who built_ a release, not _what is in it_. ChainDrop (keyv/cacheable, npm) shipped with valid provenance from the real repository, and LiteLLM 1.107.0 was built by BerriAI's real release workflow from a lookalike source repository. Presence of provenance is therefore not a safety signal. A **change** in provenance between two releases of the same package is one: a stolen-token publish from a laptop drops provenance the package always had, and a build attested from an attacker-controlled repository names a different repository.

Two deterministic rules compare the registry's provenance record for a published baseline with the candidate's. They live in the `release.*` family, so they carry the `<release-process>` file label, land on the release delta, and feed release risk like [`release.source-drift`](./release-fingerprint.md).

| Rule                                   | Severity | Fires when                                                                                                                                                            |
| -------------------------------------- | -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `release.provenance-dropped`           | medium   | the registry lists build provenance for the baseline and the two releases before it, and affirmatively lists none for the candidate                                   |
| `release.provenance-dropped`           | low      | the same drop with fewer than three attested releases in a row; or a stable without provenance after an attested prerelease when no earlier stable carries provenance |
| `release.provenance-publisher-changed` | medium   | both releases are attested and the candidate names a repository the baseline did not (a different repository id when both have one)                                   |
| `release.provenance-publisher-changed` | low      | a repository change under the same owner when no repository id is recorded on both sides, or the same repository with a workflow the baseline was not built by        |

The pure rule and baseline selection (`provenanceLineage`) are `server/lib/provenance-continuity.ts`; the registry readers are `server/lib/ecosystems/npm/provenance.ts` and `server/lib/ecosystems/pypi/provenance.ts`. Unit tests: `test/provenance-continuity.test.ts`; golden and eval cases: the registry provenance section of [`security-detection-corpus.md`](./security-detection-corpus.md).

## Surfaces

The readers run inside the ecosystem's `publicDiff.acquire`, so every review of two **published** releases gets them:

- anonymous `/diff` for npm and PyPI;
- authenticated published-pair reviews (`server/lib/ecosystems/published-pair.ts`), including the post-release review started from a [publication monitor](./publication-monitor.md) alert.

Continuity reads forward: a pair whose `to` version is not newer than its `from` (by semver on npm, PEP 440 on PyPI; unparseable versions included) is not evaluated, so picking an older release as the `to` side on `/diff` cannot report it as having dropped its successor's provenance.

The provenance baseline is chosen within the candidate's channel, separately from the diff baseline. A stable candidate is compared with earlier stable releases only, so a stable published by hand is not compared with its own CI-built prerelease (the `/diff` suggestion and the published-pair default baseline are the semver predecessor, which is often that prerelease). A prerelease candidate may follow a release of either channel. A release published after the candidate is skipped too: a maintenance line that adopted provenance after the next major shipped (4.x.y published after 5.0.0) is not something 5.0.0 dropped. When the requested baseline fails either test, the highest qualifying release stands in and the evidence names it. A prerelease set aside for its channel still speaks when no earlier stable carries provenance (none exists, or it was published without): a stable published without provenance after attested prereleases is a low drop, so a project that adopted provenance during its betas does not go silent at its first stable, while projects that attest only prereleases get context rather than release risk. Publish times come from the packument's `time` (npm) and each release's earliest file upload (PyPI).

Not covered: staged npm reviews and workflow-gate reviews (the candidate is not published, so the registry has no provenance record for it yet), pkg.pr.new preview sides, atpm (its own verified-provenance rules, `atpm.trusted-publishing-lost` among them, see [`atpm-trusted-publishing.md`](./atpm-trusted-publishing.md)), and VS Code. The publication monitor's own observation does not read provenance; it only hashes bytes.

## Sources and what is trusted

**npm.** Presence comes from the packument: `versions[v].dist.attestations.provenance` is written by the registry, never by the publisher, and is projected as `hasProvenance` by `projectRegistryMetadata`. A packument cached before that projection reads as unknown. Identity comes from `GET https://registry.npmjs.org/-/npm/v1/attestations/<name>@<version>`, which returns `{ attestations: [{ predicateType, bundle }] }` where `bundle` is a Sigstore bundle whose `dsseEnvelope.payload` is a base64 in-toto statement. The reader uses the `https://slsa.dev/provenance/*` entry whose statement subject is `pkg:npm/<name>@<version>`:

- SLSA v1 (`buildType` `https://slsa-framework.github.io/github-actions-buildtypes/workflow/v1`, npm ≥ 9.6 on GitHub Actions): `buildDefinition.externalParameters.workflow.{repository,path}` and `buildDefinition.internalParameters.github.repository_id`.
- SLSA v0.2 GitHub (`https://github.com/npm/cli/gha/v*`, early 2023 releases): `invocation.configSource.uri` (`git+https://github.com/<repo>@<ref>`), `configSource.entryPoint`, `invocation.environment.GITHUB_REPOSITORY_ID`.
- SLSA v0.2 GitLab (`https://github.com/npm/cli/gitlab/*`): `configSource.uri`, `invocation.parameters.CI_CONFIG_PATH`, `invocation.parameters.CI_PROJECT_ID`.
- Any other build type (for example `--provenance-file` statements) is present with unreadable identity.

Real examples: `sigstore@3.0.0` (SLSA v1, repository id `495574555`) and `sigstore@1.3.0` (SLSA v0.2, same id); `left-pad@1.3.0` answers `404 {"error":"Not found"}` and has no `dist.attestations`.

**PyPI** ([PEP 740](https://peps.python.org/pep-0740/), [integrity API](https://docs.pypi.org/api/integrity/)). `GET https://pypi.org/integrity/<project>/<version>/<filename>/provenance` with `Accept: application/vnd.pypi.integrity.v1+json` returns `{ version: 1, attestation_bundles: [{ publisher, attestations }] }`. `publisher` is written by PyPI from the Trusted Publisher that uploaded the file: `{ kind: "GitHub", repository: "owner/repo", workflow: "release.yml", environment }` or `{ kind: "GitLab", repository, workflow_filepath, environment }`. Google and other publishers name a service identity rather than a repository and read as present with unreadable identity. Each side checks the files the diff selected (one sdist, one wheel). A release is absent only when every checked file is; any attested file makes it present. A release whose other wheels are attested but whose checked files are not reads as absent, so the evidence says "none for the checked files".

PyPI's 404 means both "no provenance for this file" and "no such file". Only the JSON body `{"message": "No provenance available for <filename>"}` counts as absent; the HTML not-found page, `403` (integrity API administratively disabled), `406`, and every other shape are unknown. Real examples: `urllib3-2.5.0.tar.gz` (attested, `urllib3/urllib3` `publish.yml`) and `urllib3-1.26.20.tar.gz` (JSON 404).

**No signature verification.** Neither reader re-verifies the Sigstore bundle. Both trust the registry's served record over TLS: npm validates provenance against the publishing identity (and the package's `repository`) before accepting a publish, and PyPI verifies attestations against the Trusted Publisher at upload and writes the `publisher` object itself. The findings and evidence say what the registry reports, never "verified". The atpm path is different because atpm stores bundles in publisher-writable records; it re-verifies them against a pinned root.

## Unknown is never a finding

Every read degrades instead of failing the review, and a `/diff` result built on an undetermined read on either side or in the history is cached for 15 minutes instead of the immutable pair's 30 days, so a transient registry failure does not hide a finding for a month (authenticated published-pair reviews persist their result and are not re-run on their own; rescan to re-read): the rule fires only when the baseline is affirmatively present and the candidate is affirmatively absent, or when both sides have a readable identity. A custom `NPM_REGISTRY` (including the local fake registry) reads as unknown: another registry's attestation endpoint carries no npm-validated meaning. A failed attestations fetch after the packument listed provenance leaves that side present with unreadable identity, so a drop on the other side still fires but nothing is compared.

The records are attacker-influenced even when served by the registry (whoever ran the attested build chose the workflow file name), so reads are bounded: fixed origins, no credentials, redirects not followed (`redirect: "manual"`), one attempt with a 5-second timeout (a retry would add latency to every warm-cache diff, and a lost read is only a missed comparison), a 256 KiB body cap through `readBoundedJson`, at most 8 attestations or bundles per document, a 128 KiB cap on a DSSE payload, and each attested string at most 256 characters with no control, zero-width, or bidi formatting characters before it can reach evidence text or a comparison. Failures emit `public_diff.npm_provenance.unavailable` / `public_diff.pypi_provenance.unavailable` with a status code only, never a body.

## False-positive posture

Medium, not high, for both repository-level rules, matching `atpm.trusted-publishing-lost`. Known legitimate triggers:

- **Dropped:** a maintainer publishes a hotfix from their machine, CI moves to a provider or setup that does not attest, or a project simply stops attaching attestations. LiteLLM itself attached PEP 740 provenance to 1.83.0–1.83.14 (from `BerriAI/project-releaser`) and none from 1.84.0 onward, so 1.83.14 → 1.84.0 fires on a release that was not, as far as is known, compromised.
- **Repository changed:** a package moves to a new repository or monorepo. A GitHub rename or organization transfer keeps the repository id, so npm (which attests the id) stays quiet. PyPI's publisher carries no id, so a rename is visible only by name; a change that keeps the owner (the first path segment, which an outside attacker cannot create repositories under; on GitLab that is the top-level group, so any subgroup counts as the same owner) is low, a change of owner stays medium. Comparison is case-insensitive.
- **Workflow changed:** release workflows are renamed and split routinely, hence low.

A drop is medium only after three attested releases in a row (the baseline and the two before it in the candidate's channel), matching `release.source-drift`'s three consistent prior releases; a shorter attested history is low. Projects adopting provenance commonly ship one or two attested releases and then publish from a laptop again while their CI settles. On npm the history is free: `projectRegistryMetadata` keeps `hasProvenance` for every version in the packument already in memory. On PyPI it costs one integrity request per prior release (one representative file: the sdist, else the first wheel by name), so it is read only when the baseline is present and the candidate absent.

Replaying the rules over registry metadata for the release pairs of the npm false-positive sweep's package list (318 packages, the 10 most recent stable pairs each, 3,171 pairs) fired a medium drop on 7 pairs (0.2%), down from 15 before the channel, publish-order, and history rules; every removed one was a new major compared with a maintenance release published after it, or a short attested history. The remaining medium drops are releases published without provenance after an established attested history, the shape the rule exists for.

## What this does not catch

LiteLLM 1.107.0 would not have fired on PyPI. Its baseline had no PEP 740 provenance, and even with provenance the PyPI publisher and an npm SLSA statement name the repository that ran the workflow (`BerriAI/project-releaser`), not a repository that workflow checked out. The checked-out source is visible only in the build's own logs (`actions/checkout` prints `Syncing repository: <owner>/<repo>`) or in build-system provenance such as BuildKit's; neither registry records it. ChainDrop-style compromises that publish through the real CI pipeline keep both presence and identity unchanged.
