# Security model

Trust boundaries, anonymous surfaces, credential and egress rules, and auth posture for Drydock. **Authority:** enforced. **Owner:** `server/index.ts` (route order), `server/lib/sandbox.ts` (egress), `server/lib/auth/index.ts` (sessions).

Package bytes are evidence; credentials stay outside the sandbox; humans authorize releases.

## At a glance

|Boundary|Owner file|Failure posture|Pinned by|
|---|---|---|---|
|Session or scoped API-key guard on `/api/*`|`server/index.ts`, `server/middleware/api-key-auth.ts`|`401` for missing/invalid auth; key route allowlists|`test/api-auth-boundary-invariants.test.mjs`|
|Organization scoping|`server/lib/auth/active-organization.ts`|Personal-org fallback, or `403` when strict|`test/workers/organization-members-routes.test.ts`|
|npm credential egress|`NpmStageGateway` in `server/lib/sandbox.ts`|Rejects non-allowlisted endpoints|`test/sandbox-gateway.test.mjs`, `test/workers/sandbox-gateway-runtime.test.ts`|
|Archive parsing|Sandbox parser ([sandbox parser](./sandbox-parser.md))|Fails closed; size degrades to hash-only|`test/sandbox-boundary-invariants.test.mjs`, `test/sandbox-sample-retention-invariants.test.mjs`|
|AI review|`server/lib/review/risk.ts`|Advisory; cannot downgrade deterministic findings|`test/risk.test.mjs`, `test/ai-review.test.mjs`|
|Public disclosure|`publicDisclosureAllowedCondition` in `server/db/scan-query.ts`|Same `404` as an unknown token|`test/workers/public-reports.test.ts`, `test/workers/threat-feed-badge.test.ts`|
|Per-action email verification|`server/lib/auth/email-verification.ts`|`403 { code: "email_verification_required" }`|`test/workers/email-verification-guard.test.ts`|
|Session cache|`server/lib/auth/index.ts`|Bounded revocation lag|`test/workers/auth-session-cache.test.ts`|
|Rate limiting|`server/lib/rate-limit.ts`|`429` + `Retry-After`; D1 fallback without bindings|`test/workers/rate-limit.test.ts`, `test/rate-limit-boundary-invariants.test.mjs`|
|Browser headers|`server/middleware/security-headers.ts`|Deny-all policy on `/api` and `/public`|`test/workers/security-headers.test.ts`|

## Non-negotiable boundaries

1. **No server approval automation.** The service never runs `npm stage approve`, collects npm 2FA codes, publishes packages, or presents AI as approval. The local [CLI](../cli/README.md) can invoke npm after explicit maintainer confirmation.
2. **No package execution.** Never execute package code, install dependencies, run lifecycle scripts, import modules, run builds, invoke shells, or render package-provided active content.
3. **No npm token in the sandbox.** The Dynamic Worker never receives npm token material. Only `NpmStageGateway` may attach npm authorization, and only for allowlisted npm registry endpoints.
4. **AI is advisory and on by default.** Workers AI runs behind the per-organization Flagship `ai-review` killswitch; set it false to disable AI review for one organization or globally. Deterministic findings stay authoritative; AI cannot downgrade deterministic findings.
5. **Fail closed.** Artifact acquisition, validation, parsing, report generation, workflow-gate callback, and credential checks block or reject on uncertainty; they never silently approve.
6. **Server routes decide access.** Non-auth `/api/*` routes require a Better Auth session and organization resolution except the anonymous surfaces below and the scoped organization API-key alternative in [API keys](./api-keys.md). Scans, reports, connections, Slack, release targets, gates, and settings always check organization ownership. UI state is not authority.

|Asset|Risky input|
|---|---|
|Organization npm credentials; GitHub/Slack integration secrets|Malicious package artifacts hiding supply-chain malware|
|Better Auth sessions, users, memberships, organization boundaries|Archives using traversal, duplicate paths, resource exhaustion, parser edge cases|
|Scan reports, evidence, changed-file samples, private pre-release contents|Package text attempting prompt injection against the AI reviewer|
|D1, R2, Queues, Workers AI, AI Gateway, Dynamic Worker loader|Package files with leaked secrets|
|Maintainer trust in the report and release decision|Cross-organization reads; over-broad or leaked registry credentials|

## Anonymous surfaces

Hono registration order makes mounts above the session guard anonymous (`server/index.ts`). This table mirrors the test-enforced `REGISTRATIONS_ALLOWED_ABOVE_SESSION_GUARD` in `test/api-auth-boundary-invariants.test.mjs`; additions are security decisions.

|Registration|Routes served|Trust boundary|Abuse control|Owner|
|---|---|---|---|---|
|`use *` (x2)|Security headers, canonical-host redirect|Middleware only|—|`server/middleware/security-headers.ts`, `server/middleware/canonical-host.ts`|
|`route /webhooks`|`POST /webhooks/github`|GitHub App webhook HMAC signature; no Origin/Referer, so above CSRF|Per installation per event kind per minute: `deployment_protection_rule` 240, `installation` 60, `pull_request` 240, `check_run` 120, `check_suite` 120|`server/routes/github-webhooks.ts`|
|`route /api/public/v1/package-diff`|`GET /`, `/versions`, `/file`, `/atpm-stage`|Public release data only|Per-IP limits before validation or fetch; shared cold-computation budget|`server/routes/public-diff.ts`|
|`route /api/public/v1/mcp`|`GET`, `POST`, `DELETE /`|Tools over public package diff only; no organization selector or arbitrary fetch target|Per-IP 120/minute; 16 KiB body cap; canonical Origin only when present|`server/routes/public-mcp.ts`|
|`route /og`|`GET /og/diff/**/card.png`|Reads public-diff result cache only|Per-IP limit charged only on a cold render|`server/routes/og.ts`|
|`route /public`|`GET /public/reports/:token` (+ `/file`, `/attestation`), `GET /public/attestation-key`, `GET /public/threat-feed.json`, `GET /public/badge/:ecosystem/*`, `GET /public/badge-verdict/:ecosystem/*` ([subset of the badge](./public-badge.md#badge-verdict))|Share token (256-bit) or publication rules below|One per-IP bucket for reports/feed; separate per-IP badge bucket|`server/routes/public-reports.ts`|
|`use /api/*` (x2)|Better Auth init (`503` if unconfigured), CSRF origin check|Middleware only|—|`server/middleware/csrf-origin.ts`|
|`use /api/auth/*`|Per-IP auth buckets|Middleware only|See [rate limiting](#rate-limiting)|`server/middleware/auth-rate-limit.ts`|
|`get /api/auth/config`|`{ githubSignIn, emailVerification, passwordReset }` booleans|Env presence only; no bindings, D1, KV, or caller data|None needed; it cannot be made to do work|`server/index.ts`|
|`get /api/auth/reset-password/*`|Always `404`|Refuses URL-borne reset tokens|—|`server/index.ts`|
|`post /api/auth/reset-password`|`400` when `?token=` is present, else Better Auth|Refuses URL-borne reset tokens|`password-reset-redeem` bucket|`server/index.ts`|
|`all /api/auth/*`|Better Auth handler|Better Auth|Per-IP auth buckets|`server/lib/auth/index.ts`|

### Public package diff (`/api/public/v1/package-diff`, `/og`)

1. Serves only public release data: the public npm registry and public `pkg.pr.new` preview tarballs (`ecosystem=npm`), the `pypi.org` JSON API with bytes only from `files.pythonhosted.org` (`ecosystem=pypi`), the publisher's own AT Protocol identity and PDS (`ecosystem=atpm`, see [atpm](./atpm.md)). Never organization resources.
2. Attaches no credentials, persists no review data to D1, never runs AI review. npm/PyPI provenance reads use the fixed-origin contract below.
3. Returns `404` when `NPM_REGISTRY` is a custom origin, PyPI mode included; the card route shares this killswitch.
4. With Rate Limiting bindings, no request path reaches D1 (`test/workers/public-diff-routes.test.ts` binds a D1 that throws on use).
5. Abuse controls: per-IP limits before validation or fetch, a shared computation budget for cold diff and file requests, anonymous colo caching of published tarball bytes, versioned colo/KV caching of results, and sandbox archive caps.
6. A share card never triggers analysis: on a cache miss it renders name and version with no numbers. Names and versions are XML-escaped, stripped of control characters and bidi overrides, and width-fitted.
7. `pkg.pr.new` egress goes through the strict parser in `src/lib/pkg-pr-new.ts`: only `https://pkg.pr.new` (exact host, no port, credentials, query, or fragment) with a canonical `owner/repo/name@ref` path. `fetchPkgPrNewTarballStream` accepts no token option. Preview bytes never enter the shared colo tarball cache; results with a preview side are cached at most 15 minutes.
8. `/api/public/v1/package-diff/atpm-stage` redirects browsers and returns JSON to API callers; it persists no staged record or link-resolution event and creates no session. Requiring a session would gate a diff of public bytes at the one moment it matters, before publication.
9. Public pages carry no visitor analytics; the only event is `public_diff.viewed` with the package name ([product analytics](./product-analytics.md)).

|Registry provenance|Endpoint|Bounds / owner|
|---|---|---|
|npm|`https://registry.npmjs.org/-/npm/v1/attestations/…`|No redirects; 256 KiB `MAX_ATTESTATIONS_BYTES`, 5-second `FETCH_TIMEOUT_MS` in `server/lib/ecosystems/npm/provenance.ts`|
|PyPI|`https://pypi.org/integrity/…`|No redirects; 256 KiB `MAX_PROVENANCE_BYTES`, 5-second `FETCH_TIMEOUT_MS` in `server/lib/ecosystems/pypi/provenance.ts`|

Unreadable provenance is unknown, never proof of loss; npm retains packument-proven presence when identity is unreadable ([continuity](./provenance-continuity.md)). New public endpoints must document these protections or require a session.

### Public MCP (`/api/public/v1/mcp`)

|Boundary|Contract / enforcement|
|---|---|
|Dispatch|Fresh in-process request to the same public-diff router on the canonical app origin; only caller IP and constant `x-drydock-client: mcp` analytics tag cross (`server/routes/public-mcp.ts`)|
|Credentials / inputs|No organization selectors, credentials, arbitrary fetch targets, cookies, Authorization, or Origin reach public analysis|
|Shared protections|Inherits custom-registry `404`, public artifact-host policy, no package execution or AI review, caches, archive caps, and shared analysis budgets|
|Protocol|Every request passes the 120/minute per-IP bucket; body cap 16 KiB (`maxRequestBodySize`, `server/lib/public-mcp.ts`); present Origin must exactly equal canonical app origin|
|Persistence|No auth session or review persistence; native rate-limit bindings avoid D1, absent bindings use existing fallback|
|Results|Explicit tool errors retain status/retry metadata; package samples remain untrusted evidence; `test/workers/public-mcp.test.ts` pins the boundary|

Usage: [package review](./agent-package-review.md).

### Public reports, feed, and badge (`/public`)

`/public` consent:

|Surface|Needs|
|---|---|
|`GET /public/reports/:token` + `…/attestation`|Owner/admin share of a completed scan|
|`GET /public/reports/:token/file?path=`|Share with `public_share_includes_files` true (column default false; new shares set true; re-sharing upgrades an old token)|
|`GET /public/threat-feed.json`|Share plus a second opt-in (feed listing)|
|Badge, listed path|Share plus feed listing|
|Badge, default-on path|No opt-in: approved, npm-published release of a provably public npm package whose reviewed bytes matched npm's stage digest (`badge_public`, set at write time)|
|Badge, post-release path|No opt-in: the organization decided a post-release review of a publication-monitor alert, as a registry-verified publisher, with reviewed digests equal to the monitor's ([public badge](./public-badge.md))|
|`GET /public/attestation-key`|Nothing; public key material only|

**Pre-publication disclosure.** No opt-in exposes an unreleased review. SQL predicate `publicDisclosureAllowedCondition` (`server/db/scan-query.ts`) governs share-token resolution (report/file/attestation), threat feed, and listed badge.

|Scan source|Public once|
|---|---|
|npm staged review|npm reports the version `published` or `deleted`|
|Published-pair review|Always (public registry bytes)|
|PyPI or VS Code gate review|Its gate approves the publish job|
|npm gate review|npm evidence shows the gate's bytes shipped: a matched published staged review, or a publication-monitor approved match naming it|
|Unknown status or source|Never (unreleased)|
|Decided `no_publish` and listed|At once: a listed rejection is a threat disclosure; unlisting or approving takes it dark again|

Early links return the unknown-token `404`; only authenticated sharing reports `awaitingPublication`. Private pre-publication channels: Slack/email (`package@version`, risk, no bytes), AI in the operator's Cloudflare account (Gateway payload logging off), operational logs/traces (package names). A per-org "embargo staged releases" setting is the remedy if more isolation is needed.

Invariants (report detail in [public reports](./public-reports.md), badge detail in [public badge](./public-badge.md)):

1. Unknown, malformed, revoked, and not-yet-public tokens are indistinguishable `404`s. Report routes are `no-store`, so revocation is immediate; they return the canonical report export and never scan events or org/user identifiers.
2. Only `file` anonymously discloses private-review bytes. It shares `getScanFile` with `GET /api/v1/scans/:id/file`: samples cannot exceed the maintainer read or reduce redaction. It serves one persisted `files.json` entry (other paths: bad-token `404`), never a baseline fetch using org npm credentials. The share dialog discloses this before link creation/upgrade.
3. Badge indexing by ecosystem/name requires credential-backed identity: a public-npm staged review readable by the org token (read access suffices), npm stage name (`registry_package_name`) matching manifest, and canonical org claim. Otherwise `scanPublicPackageName` gives no public identity; feed labels it `manifest-claimed`.
4. npm workflow-gate scans never answer the badge; PyPI and VS Code gate badges stay `unverified`; published-pair reviews never qualify alone (`badgeLookupKey`, `listBadgeCandidateScans`). `scanPackageIdentity` fails closed, so adding a badge-capable scan source is a security decision.
5. No enumeration oracle: a badge carries no package name, org identity, or share token, and unlisted-but-scanned, never-scanned, and switched-off packages return byte-identical bodies. A throttled badge says `unavailable`, never `not reviewed`.
6. A default-on badge carries a verdict only, never an undecided or rejected review, report link, findings, or feed entry.
7. For an already-answering package, a newer unlisted release on its line, or same-org monitor evidence short of approved match (discrepancy/digest mismatch), displays `<version> not reviewed`. `unknown` evidence and other-org watches never count. Version comes from npm's `registry_version`, never the tarball manifest.
8. Badge, badge verdict, and feed are colo-cached for 300 s; revoke/unlist purges only the serving colo (best effort), so other colos and badge proxies serve the old body until TTL. Treat them as eventually consistent; the report route is the authority.

## Egress

|Path|Hosts|Credential|Redirects|Owner / detail|
|---|---|---|---|---|
|npm staged tarball/metadata/baseline|Organization's npm registry, allowlisted staged/metadata/tarball endpoints|Org npm token, attached only by `NpmStageGateway`|Runtime default|`server/lib/sandbox.ts`|
|PyPI artifacts|`https://files.pythonhosted.org` only|None|—|[PyPI workflow gate](./pypi-workflow-gate.md)|
|GitHub artifacts|Scoped to the workflow-gate installation and run under review|Installation token, attached only to `api.github.com` (`server/lib/github-app/artifacts.ts`)|302 to a signed artifact-storage URL with the token dropped; other hosts blocked (`evaluateGithubArtifactEgress`)|[workflow gates](./workflow-gates.md)|
|Public diff npm / pkg.pr.new|Public npm registry; `https://pkg.pr.new`|None|—|[public diff](./public-diff.md)|
|atpm identity, records, blobs|Hosts named by the publisher's handle, DID, and PDS|None|Manual; ≤3 hops, each re-checked; pinned blob same-origin only|[atpm](./atpm.md)|
|Publication monitor|Fixed public npm origin (loopback fake registry only with the local override)|None; never reads a connection token|`redirect: "manual"`; a 3xx is unavailable evidence|[publication monitor](./publication-monitor.md)|
|Workers AI reviewer and Clef|`drydock-gateway` AI Gateway inside the Cloudflare account|Binding|—|`server/lib/ai-review/gateway.ts`|

1. Direct Internet egress from the sandbox is intercepted; registry and artifact fetches go through brokers.
2. The atpm path is bounded, not trusted: every URL is rebuilt from validated parts (a record's `meta.dist.tarball` is ignored), checked against one public-host policy, and the Worker sets `global_fetch_strictly_public`.
3. atpm requires blob SHA-256/CID match, locally recomputed staged-record CID, and Sigstore verification against a pinned root (`server/lib/platform/x509.ts`). Malformed bundles display "does not verify", never fail the page. Displayed handles are resolution-proved, never repository claims; `did:web` domain control is disclosed. Pairs/cards expire after five minutes.
4. Monitor tarball reads require an org Drydock record or started post-release review, plus published-tarball origin-policy approval. Responses stream into bounded state; unverified evidence becomes an explicit coverage gap.

## Credential posture

1. Organizations store their own encrypted npm connection. Recommend read-only, granular, minimally scoped, expiring tokens with no publish/write/org-management permission.
2. The npm granular form is `Packages and scopes: Read-only` over the staged packages or their scope plus `Organizations: No access`; an org-scoped package such as `@nanostores/i18n` is reached by selecting the `@nanostores` scope. The npm connection card in Organization settings → npm access states this verbatim; keep them in sync.
3. The npm version-status lookup ([registry version status](./registry-version-status.md)) documents a publish-access requirement and returns authorization failures as `404`. It is advisory and fails closed to "no status"; do not broaden the requested scope to enable it.
4. Registry URLs cannot embed usernames or passwords, so scan metadata, pasteable commands, and notification email never become a second secret channel.
5. Deployed instances configure `NPM_CONNECTIONS_ENCRYPTION_KEY`. Tokens are encrypted at rest, never returned by APIs (label/fingerprint/last-used only), validated before use and re-checked immediately before a queued worker decrypts them.
6. Add/validate/use/rotate/remove produce audit events. Credentials are redacted from lifecycle events, UI responses, logs, errors, AI inputs, and persisted reports.
7. Custom npm registries are supported; token use still flows through `NpmStageGateway` and production abuse controls.
8. Issued org API keys store only SHA-256; secrets appear once and always expire. Keys are deleted with creator membership (`server/db/invitations.ts`), and auth joins membership ([API keys](./api-keys.md); `server/db/api-keys.ts`).

## Artifact evidence

1. Raw tarballs are not retained by default. Persisted evidence: package identity/version; file path/size/hash/status/flags; bounded redacted text samples, package.json summaries, and diffs; deterministic and AI findings; risk summaries; safety posture; audit events.
2. Canonical report JSON and redacted file/diff artifacts live in R2; D1 holds compact metadata only, with no D1 copy or fallback ([artifact storage](./artifact-storage.md)).
3. Never store raw staged/baseline tarballs, unredacted full source, binary payloads, or rendered assets unless an explicit, short-TTL, organization-scoped setting is added and documented.
4. Parser bugs and malformed archives fail closed (the scan errors, never partial evidence). Size is the one deliberate exception, and coverage degrades to hash-only, never to unseen; path-based skipping of vendored/test/doc trees is never used because payloads hide there (xz's backdoor lived in build scripts and test fixtures). Caps and parser rules: [sandbox parser](./sandbox-parser.md).
5. The root npm manifest is always retained or the scan fails closed; other manifests draw on bounded extra headroom.

|Size condition|Result|
|---|---|
|Body over the per-file inspection limit|`content-skipped` medium finding: path, declared size, streamed sha256, native-format flag sniffed from the first 64 bytes; no text|
|Retention budget spent or `SANDBOX_MAX_FILES` tier filled|Hash-only bodies; one aggregate `retention-tier` finding per cause: info when every hash-only body is byte-identical to the baseline, medium when any was added or modified|
|Hash-only body that would carry no sample anyway|No escalation for a sniffed native binary (`file.native-artifact`) or a source map unless the package loads it|
|Baseline stored hash-only, release inspected|Not a gap: the reviewed side's record decides|
|More than `SANDBOX_MAX_ENTRIES` entries|Parse fails|
|Oversized baseline (previous-version) archive|Degrades to a no-baseline scan; the staged review does not fail|
|PyPI artifact over a cap on the anonymous public diff|Dropped from both sides of the pair, never one, and disclosed as a notice; transient download failures stay fatal|

Streamed hashes prove skipped bodies equal baseline bytes; verify changed uninspected bytes out of band. Extensionless ELF/Mach-O binaries raise `file.native-artifact` like a `.exe`. All but native, media, font and archive bodies are decoded for the rules ([parser](./sandbox-parser.md#text-classification)).

**npm install hooks.** Consumer install lifecycle hooks for npm tarballs are `preinstall`, `install`, and `postinstall`. `prepare`, `prepack`, `postpack`, and publish/prepublish hooks are packaging-time and are not consumer-install evidence unless other evidence shows they changed the shipped artifact.

### Byte binding

The sandbox digests each archive's raw wire bytes with SHA-1 (npm's `shasum`); the npm staged path compares it with the digest npm recorded for the stage. This proves transport and parse integrity against the registry's own record; it is not publisher authentication, and SHA-1 is used only because npm publishes it.

|Condition|Verdict|Effect|
|---|---|---|
|Digests equal|`verified`|—|
|Digests differ and a second stage read confirms|`mismatch`|Critical `stage.tarball-digest-mismatch`; the confirming record becomes canonical for manifest merge, baseline selection, persistence|
|Digest missing on either side|`unverified`|No finding (absence of evidence)|
|Confirmation read unavailable|`unverified`|No finding|
|Stage-detail request failed|`unverified`|Persisted explicitly; the section is never hidden|

Verification fails to `unverified`, never to `mismatch`. The verdict and both digests appear in the report's staged-publish block, the workbench, and the downloadable report.

## AI review posture

1. Package text is hostile instruction. Prompts frame it as evidence; output is schema-validated findings; deterministic findings and risk stay independent.
2. AI input is the minimum changed-file evidence, never credentials, sessions, raw headers, or operator secrets. Invalid, partial, or unsafe output is ignored or `unavailable`, never a clean review.
3. AI risk is bounded by verdict and attributed by file; only findings on the release delta reach `releaseRisk`. Scoring is owned by [AI review](./ai-review-eval.md#submission-and-scoring).
4. `file.review-manipulation` (verdict coercion; never discounted by a prior approval) and `file.prompt-injection` (instructions aimed at any LLM reading package bytes) are deterministic rules, so the killswitch and a swayed model cannot suppress them. The reviewer does not restate an injection a rule already reports for the same file and attempt.
5. AI Gateway logs keep metadata only (model, status, token counts, duration, `cf-aig-metadata` scan/organization/stage ids). Every Workers AI call sends `cf-aig-collect-log-payload: false` from `AI_GATEWAY_POLICY_HEADERS` (`server/lib/ai-review/gateway.ts`), pinned by `test/ai-review.test.mjs` and `test/ai-review-clef.test.mjs`, because a retained prompt could expose an embargoed fix to anyone with account access.
6. Agent Traces are fully sampled; wrapper `storeMessages`/`storeTools` and SDK `recordInputs`/`recordOutputs` disable payloads. Allowed metadata: operation/timing, model/usage, tool names, reviewer version, ecosystem, random invocation id. A `run`-only binding facade excludes Gateway log ids. Traces exclude scan/stage/org/package/file/prompt/evidence/tool-result content.
7. A maintainer decision is feedback, never an automatic truth label.

### Clef injection screen

|Property|Contract|
|---|---|
|Flag|`clef-injection-screen` Flagship flag, default off; runs only after a completed review, so `ai-review` also disables it (`server/lib/scan/pipeline.ts`)|
|Input|Changed text from redacted samples, windows ≤2,000 chars, two cue-richest windows per file, then filled across files before path order; at most `MAX_SPANS` (6) and `MAX_TOTAL_SPAN_BYTES` (12 KiB, UTF-8) per scan (`server/lib/ai-review/injection-screen.ts`). Changed lines come from a linear multiset match, not an LCS diff|
|Scope|Only files where both phrase rules and reviewer found nothing; adds evidence, never restates it|
|Payload|Ecosystem and package-relative paths; no package name, version, organization, or credential (Gateway metadata carries scan/org ids)|
|Output|Hazard probabilities and severity per span; a row needs a probability and severity to agree; any malformed or missing answer discards the batch|
|Finding|AI finding `category: "prompt-injection"`, `source: "injection-screen"`; excluded from deterministic export and release memory; describes the span, never quotes it|
|Risk|Forces `requiresManualReview` (reviewer's own kept as `reviewerRequiresManualReview`) and adds only the medium floor; never lowers or contradicts a rule finding|
|Limit|Samples; never claims a file clean. A payload with no review/AI cue words behind enough cue-bearing text can go unsampled; the phrase rules read every byte and remain the floor|

## Authorization and accounts

1. Session org ids are selectors; non-member selectors fall back to personal org unless `x-organization-strict: 1` returns `403 { code: "not_organization_member" }`.
2. `GET /api/v1/scans/:id/organization` resolves a scan through the caller's own memberships (one D1 join per request), so gate-comment links without `?org=` open correctly. A scan in another organization returns the same `404` and body as a nonexistent id; scan ids are random UUIDs and open nothing for non-members.
3. Organization membership and role, resource ownership, two-factor enrollment (`userHasTwoFactor`), the organization two-factor policy, and the encrypted TOTP secret read D1 on every request; nothing that authorizes a release decision is cached.
4. Roles and route guards: [organization members](./organization-members.md). Step-up: [two-factor auth](./two-factor-auth.md).

### Organization API-key alternative

|Boundary|Contract / enforcement|
|---|---|
|Routes|`API_KEY_ROUTES` reads; `scan` also `API_KEY_SCAN_ROUTES`; `decide_staged` also `API_KEY_DECIDE_ROUTES` (`server/lib/auth/api-keys.ts`)|
|Principal|Plain member of exactly one organization; never combined with a cookie session (`server/middleware/api-key-auth.ts`)|
|Decisions|Never decides a workflow gate or its packages: staged npm reviews outside every gate only, checked again in the decision write (`server/db/scan-decisions.ts`)|
|Creator step-up|`decide_staged` creation and use require creator 2FA; every decision needs a fresh, once-accepted creator TOTP; attempts are rate limited, five wrong codes in a row revoke the key (`server/routes/scans/decisions.ts`)|
|CSRF|Key-presenting `/api/v1/` requests skip Origin checks because they never authenticate by cookie; cross-site Authorization needs a CORS preflight the app never grants. `/api/auth/*` keeps the check (`server/middleware/csrf-origin.ts`)|

Full contract: [API keys](./api-keys.md#recording-staged-decisions).

### Email verification

Sign-in never needs a verified address; unverified accounts can use the dashboard and review published pairs. `requireVerifiedEmail` gates actions that spend trust in the address or reach a third party, answering `403 { code: "email_verification_required" }`:

|Action|Route|
|---|---|
|Connect / validate npm token|`POST /api/v1/npm-connection` and `/validate`|
|Personal scanning consent|`POST /api/v1/npm-connection/personal-confirmation`|
|Record a scan decision|`POST /api/v1/scans/:id/decision`, `POST /api/v1/scans/batch-approval`|
|Create a public share link|`POST /api/v1/scans/:id/share`|
|Invite a member|`POST /api/v1/organizations/invitations`|
|Mail recipient or watch|`POST /api/v1/organizations/:id/notification-recipients`, `POST /api/v1/publication-watches`|
|GitHub App install|`POST /api/v1/github-app/install` and `/install/callback`|
|Decide a workflow gate|`POST /api/v1/github-app/workflow-gates/:gateId/decision`|
|Publisher setup|Every `/api/v1/github-app/setup/*` route|
|Accept an invitation|`POST /api/v1/organizations/invitations/accept`; checks the user row, not the session (`403`)|

1. The guard reads Better Auth's `emailVerified` session flag; absent counts as verified, so a payload change never removes access.
2. It is inert when `emailVerificationAvailable(env)` is false (no `SEND_EMAIL`, or a local `BETTER_AUTH_URL`), because no account could clear it. `GET /api/auth/config` reports it for the banner.
3. Resend (`/send-verification-email`): 5/hour per IP and per address digest, sign-up's send included; over budget looks sent (`auth.verification_address_limited`).
4. `autoSignInAfterVerification: false`: verification never signs in, because Better Auth 2FA guards only `/sign-in/*` and `/verify-email` sessions would bypass password/TOTP. `hooks.after` on `/verify-email` refreshes a signed-in account's flag.

### Password reset

`server/lib/auth/index.ts`: `POST /api/auth/request-password-reset` mails a link; `POST /api/auth/reset-password` redeems it, creating a missing `credential` row for [GitHub-only 2FA enrollment](./two-factor-auth.md#management). `setPassword` is server-only; cookies alone cannot mint passwords.

|Property|Contract|
|---|---|
|First password|Mailed only when signed in as that same account and `emailVerified` is true; otherwise identical response, no mail, `auth.first_password_link_refused`|
|Availability|Only when `passwordResetAvailable(env)` (verification mail requirements plus `BETTER_AUTH_URL`); `GET /api/auth/config` reports `passwordReset`|
|No account oracle|Same body for registered and unknown addresses; mail sent from `waitUntil`. Sign-up still reports a taken address|
|Link origin|Built from `BETTER_AUTH_URL`, never the request `Host`; token in the fragment (`/reset-password#token=…`), stripped from the address bar|
|URL-borne tokens|`GET /api/auth/reset-password/:token` → `404`; redeem `POST` with `?token=` → `400`; `redactCapabilityPath` still rewrites callback paths in logs|
|Return target|`passwordResetPageReturnTo` (`src/lib/auth-return.ts`): only this origin's `/reset-password`, inner `returnTo` a `/dashboard` or `/diff` path, view params `org`, `tab`, `filter`, `file`, `changedOnly`, `version`, `path`, `ecosystem` plus a section fragment, ≤768 encoded chars; anything else yields the bare link|
|Token|24 alphanumeric chars (~143 bits), single use, one hour (`PASSWORD_RESET_TOKEN_TTL_SECONDS`); D1 stores only its SHA-256 (`verification.storeIdentifier`)|
|After redeem|`revokeSessionsOnPasswordReset` deletes all sessions in D1 and KV; the reset page signs its browser out; sets `emailVerified`; mails a linkless "your password was set" notice; an enrolled second factor stays|
|Per-IP limits|`password-reset-request` 5/hour, `password-reset-redeem` 10/hour|
|Per-address limit|3 mails/hour (`PASSWORD_RESET_MAILS_PER_ADDRESS`), spent in background so the response is unchanged; `auth.password_reset_address_limited`; key is SHA-256 of the trimmed lowercased address. A sender can hold back an owner's mail for the hour|

## Session posture

Sessions are Better Auth cookies signed with `BETTER_AUTH_SECRET` (`server/lib/auth/index.ts`).

|Layer|Contract|
|---|---|
|Cookie cache|`spr.session_data` holds a signed session copy for `SESSION_COOKIE_CACHE_SECONDS` (5 minutes); fresh cookies resolve with no storage read|
|KV secondary storage|With `AUTH_SESSIONS` bound, session reads/writes use KV; `storeSessionInDatabase` keeps D1 durable. Token miss or read failure falls back to D1; cache-write failure does not fail creation|
|Fallback values|D1 fallback and `active-sessions-*` hydration stay request-local, never written through, so a fallback racing a revocation cannot restore a session|
|Key guard|`isSessionStoreKeyAllowed` refuses any `<namespace>:<identifier>` key, so verification records (reset tokens, 2FA challenges) never become KV key names|
|Verification storage|`verification.storeInDatabase` keeps consumption transactional on D1, so a reset token or 2FA challenge cannot be redeemed twice|
|Better Auth limiter|Pinned to `memory`; the KV adapter rejects `getAndDelete` and `increment`, so routing either into KV fails closed|
|Expired rows|Scheduled tick deletes `session` and `verification` rows expired more than a day (`pruneExpiredAuthRows`, indexes `session_expires_idx`, `verification_expires_idx` in migration `0037`)|

1. **Revocation lag.** After sign-out, revocation, or account deletion, a replayed fresh `spr.session_data` cookie can be served for up to the cookie-cache lifetime plus KV eventual consistency. Sign-out expires both cookies. Keep `SESSION_COOKIE_CACHE_SECONDS` short.
2. Sign-out preflights the KV token eviction; if it fails, sign-out errors without clearing cookies or deleting the D1 row, so the caller can retry. The active-session index is best-effort and rebuilt from D1.
3. Account deletion evicts every known KV session key before destructive cleanup; if eviction fails, nothing is deleted.
4. `ensurePersonalOrganization` checks the user row still exists, so a cached session of a deleted account gets `401` (`UnauthorizedError`), not a `500` from the `owner_user_id` foreign key.

## Rate limiting

`enforceRateLimit` (`server/lib/rate-limit.ts`) is the single entry point: Cloudflare's native Rate Limiting binding (per-colo fixed window, no D1 write), with a D1 fallback.

|Budget|Mechanism|Examples|
|---|---|---|
|Per-minute|One `ratelimits` binding per limit (`NATIVE_TIERS`: 10, 20, 30, 60, 120, 240); `period` may be only 10 or 60 s|Anonymous `/diff`, `compare`/`compare-file`/`versions`, GitHub proxy lookups, gate decisions, Slack channel listing, GitHub webhooks, API-key requests per IP and per key|
|15-minute and hourly|D1 `rate_limits` counter behind a native per-minute burst guard at or above the long limit|Sign-in (10/15 min), sign-up (5/hour), two-factor (10/15 min), password reset, org creation, invitations, npm or Slack connect|

1. Counters are per colo: abuse controls, not quotas.
2. `Retry-After` is from the wall-clock window; `pruneExpiredRateLimitBuckets` sweeps expired D1 buckets.
3. Without `ratelimits` bindings every limit holds via D1 (logging `rate_limit.tier_missing`); a new per-minute limit needs a tier and binding.
4. GitHub never retries a rejected webhook, so per-event budgets are runaway-loop backstops; rejections log `github_webhook.rate_limited` at error.
5. Better Auth's own limiter (production `NODE_ENV` only, per isolate) is not relied on.
6. `clientRateLimitKey` keys by `cf-connecting-ip` only (not `x-forwarded-for`): IPv4 whole, IPv6 by /64, mapped and 6to4 as IPv4. A missing address shares one bucket, never skipped. A /48 still spans many buckets; edge/WAF limits back that up.

## Workflow gates and publisher setup

1. Gates never publish: GitHub Environment protection holds the job; Drydock posts accept/reject. State binds installation/repository/run/environment/callback URL/org; approval needs the reviewed run attempt and artifacts; digests are rehashed from bytes ([workflow gates](./workflow-gates.md)).
2. Setup requires verified session and `roleCanManageIntegrations`; reads use org-owned installations. Workflows/proposals/conversations are hostile evidence. Tools expose no shell, package execution, installation, external fetch, or GitHub writes.
3. Persisted `createPullRequest: true` authorizes draft-PR writes. Each mutation rechecks authorization/membership/installation/killswitch/source revision/proposal digest/independent verdict. Multi-file commits are atomic; recovery never overwrites collaborator edits.
4. The write token is repository-scoped and needs already-granted Contents, Pull requests, and Workflows permissions. Setup cannot grant permissions, enable environment protection, approve, merge, or publish. Setup status reports observed configuration; it never certifies workflow code.
5. Private setup state: org-scoped R2; authorization/safe metadata: D1. Logs exclude prompts, tool payloads, raw errors; Gateway retains no workflow payloads. Deletion/expiry removes private data; late writes cannot restore it ([publisher setup](./publisher-setup.md)).

## Package claims

1. A claim governs badges, enrollment, and management only; it never deactivates another organization's public-release monitoring unless that organization holds competing staged reviews of the package.
2. Authenticated package management permits one personal→shared reservation move after personal-ownership and destination owner/admin checks; claim/enrollment/audit write atomically. No scans/reports/observations/credentials move. Shared/ownerless reservations have no self-service transfer.
3. Registry-less pre-claim history and ownerless `*` reservations after last-scan deletion block only public npm claims, preventing private-registry org-name probing. History blocks only unrelated orgs ([package claims](./package-claims.md)).

## Browser response headers

1. Every response passes through the Worker (`run_worker_first`); `server/middleware/security-headers.ts` sets the policy.
2. `/api/*` and `/public/*` get the deny-all API policy, even for HTML. Everything else gets `DOCUMENT_CSP` (same-origin scripts only).
3. HTML outside `/api` and `/public` also gets a fresh per-response `script-src` nonce, solely for Cloudflare's Bot Fight Mode injected script. The app ships no inline script and must not depend on the nonce; `'unsafe-inline'` stays out.
4. Never relax CSP/CORS for convenience or allow package-provided active content.

## Workers Issues

Workers Issues stores invocation and request details, and request URLs can carry share, invite, and verification tokens. An automation sends that outside the account, so its destination is a trust decision; rules are in [release safety](./release-safety.md#workers-issues-destinations).

## Known gaps

1. Raw-artifact retention, if added, must be explicit, short-TTL, organization-scoped, and documented.
2. New ecosystems need adapter-specific credential, baseline, artifact, and failure-mode review before enablement.
3. Archive handling is a trust boundary; keep dependency and parser updates covered by regression and fuzz tests.

## Change checklist

- New route above the session guard → add a row to the anonymous table, update `REGISTRATIONS_ALLOWED_ABOVE_SESSION_GUARD`, run `test/api-auth-boundary-invariants.test.mjs`.
- New egress host or fetch path → add an egress row and test that no credential is attached.
- New per-minute limit → add a `NATIVE_TIERS` entry and `ratelimits` binding, and check `server/env.d.ts` parity (`test/env-binding-parity.test.mjs`).
- New action that reaches a third party → add `requireVerifiedEmail` and a row above.
- New scan source that could answer the badge → security review; `scanPackageIdentity` must stay fail-closed.
