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

### AI is advisory

Workers AI reviews evidence but does not decide approval. Deterministic findings are authoritative and cannot be downgraded by AI output.

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
- Record audit events for add, validate, use, rotate, and remove.
- Never return token material from an API.
- Never include token material in scan errors, AI inputs, logs, or persisted reports.

Current code has encrypted per-organization npm connections and a deployment-level `NPM_TOKEN` fallback for local/self-host development. SaaS production should configure `NPM_CONNECTIONS_ENCRYPTION_KEY` and set `REQUIRE_ORG_NPM_CONNECTION=true` rather than relying on a global npm token.

## Package artifact handling

### Default retention policy

Do not retain raw tarballs by default.

Persist by default:

- package name/version metadata;
- file path/size/hash/status/flags;
- bounded redacted text samples;
- package.json summary and diff;
- deterministic findings;
- AI findings;
- risk summary;
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

Allowed egress through `NpmStageGateway`:

- staged npm tarball endpoint;
- npm package metadata JSON;
- published npm `.tgz` tarballs for previous-version diffing.

This matches Cloudflare's [outbound Worker sandbox-auth model](https://blog.cloudflare.com/sandbox-auth/): auth injection happens in a trusted WorkerEntrypoint using parent-provided props, not inside the sandboxed workload.

Blocked:

- arbitrary origins;
- package-controlled URLs;
- install-time network calls;
- any request where npm auth would be forwarded to a non-registry origin.

The gateway should compare URL origins against the configured npm registry and should attach credentials only for the minimal endpoint set requiring auth.

## AI prompt-injection posture

Workers AI receives a static system prompt that says package contents are hostile evidence only. The user message should contain structured JSON with:

- deterministic findings;
- package.json diff;
- changed file diff;
- redacted changed-file samples.

Do not include unbounded package contents. Do not include unchanged files except as metadata where needed. Do not let package contents define instructions, schema, roles, or severity rules.

If AI fails or returns invalid data, the scan should require manual review and should not silently pass.

## Authorization posture

Current guardrail:

- every non-auth `/api/*` route requires a Better Auth session;
- scans are filtered by organization ID;
- personal organizations are stable per user.

Before SaaS launch:

- keep organization ownership checks on every scan/report/token route;
- add tests for cross-organization access denial;
- add route-level permission helpers even before full RBAC;
- make future RBAC additive rather than rewriting ownership checks.

RBAC is not required for the first launch slice, but the schema and route boundaries should not assume resources are global or user-only.

## Signed reports later

Signed reports are not launching yet. Prepare by making report payloads canonical and digestible.

Future signed report requirements:

- report payload has a version;
- report digest is computed over canonical JSON;
- signature records include signer user, organization, scan, digest, and timestamp;
- revocation/withdrawal is represented without mutating the original report;
- public access requires explicit sharing controls.

Do not expose signed report URLs until access controls, report canonicalization, and audit events are complete.

## Known gaps

- Per-organization encrypted npm connections exist, and validation can check staged-tarball access when supplied a real stage ID; npm list/view capability checks still need confirmation before launch.
- Scans are currently synchronous, not queue-backed.
- Persisted detail UI does not yet render all report data stored at scan time.
- Tar parsing now rejects traversal paths, skips symlinks/hardlinks, handles long-name/PAX paths, and caps expanded size, but it still needs deeper archive-bomb fuzzing before broad public launch.
- Basic D1-backed rate limits exist for scans and credential operations; production should add metrics, alerts, and edge/IP-based abuse controls.
- Team RBAC is deferred.
- Public signed reports are deferred.
