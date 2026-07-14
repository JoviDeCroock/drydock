# Security model

Drydock handles hostile package artifacts, private review evidence, and npm credentials. The core posture is: **package bytes are evidence, credentials stay outside the sandbox, and approval remains a human release action.**

## Assets

- Organization npm credentials and GitHub/Slack integration secrets.
- Better Auth sessions, users, memberships, and organization boundaries.
- Scan reports, package evidence, changed-file samples, and private pre-release contents.
- Cloudflare resources: D1, R2, Queues, Workers AI, AI Gateway, and Dynamic Worker loader.
- Maintainer trust in the review report and release decision workflow.

## Risky inputs

- Malicious package artifacts attempting to hide supply-chain malware.
- Archives attempting traversal, duplicate-path confusion, resource exhaustion, or parser edge cases.
- Package text attempting prompt injection against the AI reviewer.
- Package files containing accidentally leaked secrets.
- Unauthorized users trying to read or act on another organization's scans.
- Over-broad or leaked registry credentials.

## Non-negotiable boundaries

- **No approval automation.** Drydock must not run `npm stage approve`, collect npm 2FA codes, publish packages, or represent AI output as release approval.
- **No package execution.** Do not execute package code, install dependencies, run lifecycle scripts, import modules, run builds, invoke shells, or render package-provided active content.
- **No npm token in the sandbox.** The Dynamic Worker must never receive npm token material. Only `NpmStageGateway` may attach npm authorization, and only for allowlisted npm registry endpoints.
- **AI is advisory and on by default.** Workers AI runs behind the per-organization Flagship `ai-review` killswitch; set the flag to false to disable it for an organization or globally. Deterministic findings remain authoritative and cannot be downgraded by AI output.
- **Fail closed.** Artifact acquisition, validation, parsing, report generation, workflow-gate callback, and credential checks must block/reject on uncertainty rather than silently approving.

## Credential posture

Organizations store their own encrypted npm connection. Operators should recommend read-only, granular, minimally scoped, expiring tokens without publish/write/org-management permission unless npm proves a staged-review endpoint requires more.

Implementation requirements:

- configure `NPM_CONNECTIONS_ENCRYPTION_KEY` for deployed instances;
- encrypt token material at rest and never return it from APIs;
- show only label/fingerprint/last-used metadata after storage;
- validate registry auth and staged access before use;
- re-check validation immediately before queued workers decrypt/use a token;
- record add/validate/use/rotate/remove audit events;
- redact credentials from lifecycle events, UI responses, logs, errors, AI inputs, and persisted reports.

Custom npm registries are supported for organization npm connections, but token use must still flow through constrained gateway code and production abuse controls.

## Artifact handling and retention

Do not retain raw tarballs by default. Persist redacted, reviewable evidence:

- package identity/version, file path/size/hash/status/flags;
- bounded redacted text samples, package.json summaries, and diffs;
- deterministic findings and optional AI findings;
- release/artifact/context risk summaries;
- safety posture and audit events;
- canonical report JSON plus redacted file/diff artifacts in R2, with D1 holding compact metadata and historical fallback samples.

Avoid storing raw staged/baseline tarballs, unredacted full source, binary payload contents, or rendered package assets unless a future explicit short-TTL org setting is added.

## Sandbox and broker posture

The sandbox parses untrusted bytes under archive/file/expanded-size caps and returns evidence only. Direct Internet egress is intercepted. Registry/artifact fetches go through constrained brokers:

- `NpmStageGateway` for npm staged tarballs, metadata, and previous-version tarballs;
- PyPI artifact downloads restricted to `https://files.pythonhosted.org`;
- GitHub artifact downloads scoped to the workflow-gate installation/run being reviewed.

The sandbox must remain small and boring. Genuine parser bugs and malformed archives fail closed — the scan errors rather than returning partial evidence. Size is the one deliberate exception: tar and zip archives are parsed as streams (VSIX zips are the sub-exception — their yazl-packed entries carry sizes in data descriptors, so they buffer under the wire cap and are read via the central directory exactly as VS Code does), and a regular-file body larger than the per-file inspection limit, or one that no longer fits the archive's cumulative retention budget, is recorded as a `content-skipped` finding (path, declared size, a sha256 hashed over the bytes as they are discarded, and a native-format flag magic-byte sniffed from the first 64 discarded bytes — no text) so oversized prepackaged binaries can be reviewed without buffering them, and an extensionless Linux/macOS binary raises the same `file.native-artifact` finding as a Windows `.exe`. The streamed hash lets the diff prove whether a skipped body is byte-identical to the published baseline; its contents are still never inspected, so skipped content is surfaced as a medium finding on every ecosystem path and changed bytes must be verified out of band. The root npm manifest is always retained (or the scan fails closed); other manifests draw on bounded extra retention headroom. An oversized baseline (previous-version) archive degrades to a no-baseline scan rather than failing the staged review.

## Workflow-gate posture

Workflow gates never publish. GitHub Environment protection holds the publish job, Drydock reviews uploaded artifacts, and Drydock only posts an accept/reject callback to GitHub. Gate state must resolve to the original installation, repository, workflow run, environment, callback URL, and organization. Artifact identity/digests are recomputed from bytes, not trusted from file names alone.

## AI prompt-injection posture

Package contents are hostile instructions. AI prompts must frame package text as evidence, restrict outputs to schema-validated findings, and keep deterministic findings/risk independent. AI input should include only the minimum changed-file evidence needed for review, never credentials, sessions, raw headers, or operator secrets. Invalid, partial, or unsafe AI output is ignored/unavailable rather than treated as a clean review.

For npm registry tarballs, consumer install lifecycle hooks are `preinstall`, `install`, and `postinstall`. `prepare`, `prepack`, `postpack`, and publish/prepublish hooks are packaging-time hooks and should not be treated as consumer-install evidence unless other evidence shows they changed the shipped artifact.

## Authorization posture

Every non-auth `/api/*` endpoint requires a Better Auth session and organization resolution. Reads and writes for scans, reports, npm connections, Slack installs, release targets, workflow gates, and settings must check organization ownership. UI state is not an authority; server routes make all access-control decisions.

One deliberate exception: the `/api/public/v1/package-diff` endpoints are anonymous by design. They serve only data derived from public registry artifacts (never organization resources), attach no credentials to any fetch, target only the configured `NPM_REGISTRY` origin, persist nothing to D1, and never run AI review. Their abuse controls are per-IP rate limits enforced before any validation or fetch, KV caching of immutable version pairs, and the sandbox's archive caps. Any new public endpoint must document the same properties here or require a session.

## Browser response headers

Production responses should keep conservative security headers: no package-provided active content, no cross-origin credential leakage, and no relaxed CSP/CORS decisions for convenience.

## Known gaps / future work

- Public signed reports are not exposed yet; report data should remain canonical and future-signable.
- Raw-artifact retention, if ever added, must be explicit, short-TTL, organization-scoped, and documented.
- Additional ecosystems need adapter-specific credential, baseline, artifact, and failure-mode review before enablement.
- Keep dependency and parser updates covered by regression/fuzz tests because archive handling is a trust boundary.
