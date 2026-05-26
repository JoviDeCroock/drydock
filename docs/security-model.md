# Security model

Staged Publish Review handles untrusted package artifacts and sensitive npm credentials. The core security posture is: **package bytes are hostile evidence; npm credentials stay outside the sandbox; approval remains a human 2FA action.**

## Assets to protect

- Organization npm credentials.
- Better Auth sessions and user data.
- Scan reports and package evidence.
- Package contents that may be private/proprietary before approval.
- Cloudflare account resources: D1, Workers AI, Dynamic Worker loader, future R2/Queues.
- Maintainer trust in the final report.

## Adversaries and risky inputs

- Malicious package author attempting to hide malware in a staged publish.
- Package contents attempting prompt injection against the AI reviewer.
- Archive payloads attempting parser/resource exhaustion.
- Package files containing accidentally leaked secrets.
- Unauthorized users trying to read another organization's scans.
- Credential misuse if an npm token is over-broad or leaked.

## Non-negotiable boundaries

### No approval automation

The product must not run `npm stage approve`, must not collect npm 2FA codes, and must not represent AI output as approval. Approval remains a maintainer action in npm CLI or npmjs.com.

### No package execution

The product must not execute package code, install dependencies, run lifecycle scripts, import modules, run builds, invoke shell commands, or render package-provided active content.

### No token in sandbox

The Dynamic Worker sandbox must never receive npm token material. Only `NpmStageGateway` may attach npm authorization, and only for allowed npm registry endpoints.

### AI is advisory (and currently disabled)

Workers AI review is currently disabled in the pipeline; deterministic findings are the only review signal. The reviewer module is preserved on disk and is planned to return behind a paid tier. When it returns, Workers AI reviews evidence but does not decide approval — deterministic findings remain authoritative and cannot be downgraded by AI output.

## npm credential posture

Production SaaS should use per-organization npm connections.

Recommended customer guidance:

- Use a granular npm access token.
- Scope it to the smallest package/scope set npm allows.
- Prefer short expiration and planned rotation.
- Do not grant broad organization management access unless npm proves it is needed.
- Avoid 2FA bypass unless npm proves a specific staged-review download endpoint requires it.
- Continue using npm's 2FA-protected approval flow manually.

Implementation requirements:

- Store token material encrypted at rest.
- Show only a label/fingerprint/last-used timestamp after storage.
- Validate credentials before use.
- Record audit events across the full lifecycle:
  - `npm_connection.created` — first save for an organization.
  - `npm_connection.rotated` — subsequent saves; metadata includes the previous and new token fingerprint plus the previous validation status.
  - `npm_connection.registry_changed` — a rotate that also changes the stored registry URL.
  - `npm_connection.validated` — validation passed.
  - `npm_connection.validation_failed` — validation rejected; metadata records the structured reasons (`registry_auth_failed`, `staged_list_denied`, `staged_view_denied`, `staged_tarball_denied`, `no_stages_to_probe`).
  - `npm_connection.validation_downgraded` — a token previously marked `valid` has been rejected on revalidation.
  - `npm_connection.used` — a scan worker decrypted the token to run a scan.
  - `npm_connection.deleted` — connection removed.
  - `npm_connection.suspicious_use` — three or more validation failures recorded for the organization within a 15-minute window. Idempotent within the window; surfaces as a signal that an org's token may be leaking, rotating without cleanup, or under brute-force attempt.
- Never return token material from an API.
- Redact credential metadata fields (`tokenCiphertext`, `tokenNonce`, `tokenFingerprint`, `tokenLast4`, `previousTokenFingerprint`) from scan lifecycle events before returning them to the UI.
- Never include token material in scan errors, AI inputs, logs, or persisted reports.

Current code has encrypted per-organization npm connections only. SaaS production must configure `NPM_CONNECTIONS_ENCRYPTION_KEY`; scans require an organization-owned npm token.

### Minimum viable npm token capability set

Drydock needs these registry endpoints to function. Customers should grant exactly this set and no more on granular npm tokens:

- `GET /-/whoami` — identity probe used by validation only.
- `GET /-/stage?perPage=N` — list open staged publishes for discovery.
- `GET /-/stage/:id` — fetch staged publish metadata (manifest/diff inputs).
- `GET /-/stage/:id/tarball` — download the staged artifact for scanning. The validation probe uses a `Range: bytes=0-0` request to confirm download capability without consuming bandwidth.
- `GET <registry>/:package` and `GET <registry>/:package/-/<tarball>` — public/private package metadata + previous-version tarballs for diffing. Required only when scanning private packages.

Tokens that authenticate at `/-/whoami` and list `/-/stage` but cannot view or download an individual stage are marked **capability-limited** and rejected for scanning.

### Validation status taxonomy

A stored npm connection is always in one of these states; the scan pipeline and staged-publish discovery refuse anything other than `valid`:

- `missing` — no row stored for the organization.
- `unvalidated` — token row present, validation has never been run (or was reset after rotation).
- `invalid` — `/-/whoami` or `/-/stage` denied the token. The connection is unusable.
- `capability_limited` — auth + list succeeded, but the staged-publish view/download probe failed (capability gap), or the staged list was empty so view/download could not be confirmed. The connection is rejected by scans; the user must either wait for a staged publish, paste a stage ID, or fix the token's capability set.
- `valid` — all probed capabilities passed.

API error responses for credential-dependent routes include a stable `code` field — `token_missing`, `token_unvalidated`, `token_invalid`, `token_capability_limited`, or `rate_limited` — alongside the human-readable `error` string. The UI parses `code`, not the message, so wording can change without breaking automation.

Validation runs:

1. Always: `/-/whoami` + `/-/stage?perPage=1`.
2. When a stage exists (auto-pick from list, or caller-supplied stage ID): `GET /-/stage/:id` + `GET /-/stage/:id/tarball` with a one-byte range.

Scans and staged-publish discovery require the organization npm connection to be `valid`. The dashboard automatically runs the baseline npm auth/list validation after token save and probes a representative stage from the list response when one exists. Users can still re-run a stage-ID-specific validation check from workspace setup. Queued scan workers re-check validation immediately before decrypting and using the current token, so token rotation cannot bypass the validation gate. Custom npm registries are supported for organization npm connections and should be paired with explicit abuse controls in production operations.

## Package artifact handling

### Default retention policy

Do not retain raw tarballs by default.

Persist by default:

- package name/version metadata;
- file path/size/hash/status/flags;
- bounded redacted text samples;
- package.json summary and diff;
- deterministic findings;
- AI findings (paused — persisted as `null` while AI review is disabled);
- risk summary split into release, artifact, and context risk so unchanged package hazards do not dominate the package-to-package release verdict;
- safety posture;
- audit events;
- future canonical report JSON.

Avoid by default:

- raw staged tarball;
- raw previous-version tarball;
- full unredacted source files;
- binary payload contents;
- package-provided rendered assets.

Rationale: staged packages may contain secrets, proprietary code, or malicious content. Raw retention increases SaaS liability and incident impact. If raw retention is added later, it should be opt-in per organization, short-TTL, clearly labeled, and audited.

### Redaction

Redaction is a defense-in-depth feature, not a proof that data is safe. Redact known token/key patterns before persistence and AI review, but still treat all package-derived text as sensitive.

## Sandbox egress policy

Allowed credentialed egress through `NpmStageGateway`:

- `GET` staged npm tarball endpoint;
- `GET` npm package metadata JSON endpoint;
- `GET` published npm `.tgz` tarballs for previous-version diffing.

The trusted parent Worker may also call npm's staged list/view endpoints (`/-/stage`, `/-/stage/:id`) with organization credentials for discovery, validation, tag-aware baseline selection, and shasum/mismatch checks. Current staged-view responses are metadata-only, not prepared manifests. Those responses are treated as registry metadata and are not fetched from inside the sandbox; token material still never enters the sandbox.

This matches Cloudflare's [outbound Worker sandbox-auth model](https://blog.cloudflare.com/sandbox-auth/): auth injection happens in a trusted WorkerEntrypoint using parent-provided props, not inside the sandboxed workload.

Blocked:

- arbitrary origins;
- package-controlled URLs;
- install-time network calls;
- any request where npm auth would be forwarded to a non-registry origin.

The gateway compares URL origins against the configured npm registry and attaches credentials only for the minimal endpoint set requiring auth. Previous-version compare cache entries are scoped by organization so cached private-package evidence is not shared across tenants.

## AI prompt-injection posture (paused)

AI review is disabled today; the posture below documents the contract the reviewer must continue to honor when it returns behind a paid tier.

Workers AI receives a static system prompt that says package contents are hostile evidence only. The only instruction-bearing inputs are the application-owned system prompt and top-level review task. Everything derived from a package is untrusted evidence, including filenames, package.json fields, lifecycle scripts, dependency names/specifiers, README text, comments, source code, diffs, deterministic finding evidence, and changed-file samples.

The user message should contain structured JSON with:

- deterministic findings;
- package.json diff;
- changed file diff;
- redacted changed-file samples.

Prompt-injection handling is explicit: if package-derived text tells the model to ignore rules, hide findings, mark the release safe, change severity, reveal prompts, or output non-JSON, the model must ignore that text as an instruction and may report it only as evidence.

The prompt's npm-specific risk checklist prioritizes:

- install-time lifecycle hooks such as `preinstall`, `install`, `postinstall`, `prepare`, `prepack`, `postpack`, and publish/prepublish hooks;
- lifecycle script bodies that invoke shells, `node`, package managers, `curl`/`wget`, `powershell`, `git`, or `child_process`-style behavior;
- added or modified dependencies, optional dependencies, peer dependencies, and bundled dependencies, because their own lifecycle scripts may run on consumer install even when they are not present in the staged tarball evidence;
- unusual dependency specs such as git/http/tarball/file URLs, npm alias syntax, broad ranges, typo-squat-looking names, native/build tooling, or optional platform-specific packages;
- entrypoint changes, credential/environment access, network/process execution, obfuscation/dynamic code, native binaries, unparseable package manifests, and package-shape surprises.

The AI must not claim an added dependency is malicious without evidence. If dependency risk depends on unavailable dependency metadata or maintainer reputation, it should require manual review and recommend checking the dependency tarballs/metadata rather than guessing.

Do not include unbounded package contents. Do not include unchanged files except as metadata where needed. Do not let package contents define instructions, schema, roles, or severity rules.

If AI fails or returns invalid data, the scan should record AI review as unavailable/invalid and should not silently pass.

## Authorization posture

Current guardrail:

- every non-auth `/api/*` route requires a Better Auth session;
- scans are filtered by organization ID;
- personal organizations are stable per user;
- public sign-up is enabled for launch.

Before SaaS launch:

- keep organization ownership checks on every scan/report/token route;
- add tests for cross-organization access denial;
- add route-level permission helpers even before full RBAC;
- make future RBAC additive rather than rewriting ownership checks.

RBAC is not required for the first launch slice, but the schema and route boundaries should not assume resources are global or user-only.

## Signed reports later

Signed reports are not launching yet. Prepare by making report payloads canonical and digestible.

Current foundation:

- newly completed scans store a report version and SHA-256 digest in `summary_json.report`;
- the digest is computed over stable canonical JSON containing redacted scan evidence only.

Future signed report requirements:

- promote report metadata to dedicated columns or immutable artifact metadata if needed;
- signature records include signer user, organization, scan, digest, and timestamp;
- revocation/withdrawal is represented without mutating the original report;
- public access requires explicit sharing controls.

Do not expose signed report URLs until access controls, report canonicalization, and audit events are complete.

## Known gaps

- Per-organization encrypted npm connections exist with a four-state validation taxonomy (`unvalidated` / `invalid` / `capability_limited` / `valid`) and the validator auto-probes staged view + download against a representative stage when one is available. Multi-connection support, rotate-without-revalidate hardening, and per-token audit metrics are still open follow-ups for production hardening (tracked in [`production-roadmap.md`](production-roadmap.md)).
- Queue-backed scan retry/dead-letter behavior exists in code and Wrangler config, but production queue resources and operational metrics still need deployment validation.
- Persisted detail UI now renders core report data, but finding grouping and lifecycle timelines still need polish.
- Tar parsing now rejects traversal paths, skips symlinks/hardlinks, handles long-name/PAX paths, caps expanded size, and fails closed when the safe file-count limit is exceeded, but it still needs deeper archive-bomb fuzzing before broad public launch.
- Basic D1-backed rate limits exist for scans and credential operations; production should add metrics, alerts, and edge/IP-based abuse controls.
- Team RBAC is deferred.
- Public signed reports are deferred.
