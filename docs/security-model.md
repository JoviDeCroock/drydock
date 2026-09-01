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

Registry URLs cannot contain embedded usernames or passwords. Registry authentication belongs in the separately encrypted npm token; keeping credentials out of URLs prevents captured scan metadata, pasteable approval commands, and notification email from becoming a second secret channel.

In npm's granular-token form that is `Packages and scopes: Read-only` over the staged packages (or their scope) and `Organizations: No access` — an org-scoped package such as `@nanostores/i18n` is reached by selecting the `@nanostores` scope, not by granting the Organizations permission, which covers member and settings management Drydock never reads. The npm connection card in `Organization settings → npm access` states this permission set verbatim; keep the two in sync.

The npm version-status endpoint (`docs/registry-version-status.md`) documents a publish-access requirement and returns authorization failures as `404`. That does not widen this stance: the lookup is advisory, fails closed to "no status", and a read-only token that cannot ask simply gets nothing. Do not broaden the requested scope to enable it.

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

Session records carry an IP address and user agent, so they are not kept past their usefulness: the scheduled tick deletes Better Auth `session` and `verification` rows once they expired more than a day ago (`pruneExpiredAuthRows`, see [`audit-log.md`](./audit-log.md)). Better Auth's Drizzle adapter does not do this itself.

## Sandbox and broker posture

The sandbox parses untrusted bytes under archive/file/expanded-size caps and returns evidence only. Direct Internet egress is intercepted. Registry/artifact fetches go through constrained brokers:

- `NpmStageGateway` for npm staged tarballs, metadata, and previous-version tarballs;
- PyPI artifact downloads restricted to `https://files.pythonhosted.org`;
- GitHub artifact downloads scoped to the workflow-gate installation/run being reviewed.

The sandbox must remain small and boring. Genuine parser bugs and malformed archives fail closed — the scan errors rather than returning partial evidence. Size is the one deliberate exception: tar and zip archives are parsed as streams (VSIX zips are the sub-exception — their yazl-packed entries carry sizes in data descriptors, so they buffer under the wire cap and are read via the central directory exactly as VS Code does), and a regular-file body larger than the per-file inspection limit, or one that no longer fits the archive's cumulative retention budget, is recorded as a `content-skipped` finding (path, declared size, a sha256 hashed over the bytes as they are discarded, and a native-format flag magic-byte sniffed from the first 64 discarded bytes — no text) so oversized prepackaged binaries can be reviewed without buffering them, and an extensionless Linux/macOS binary raises the same `file.native-artifact` finding as a Windows `.exe`. File counts degrade the same way: bodies past the `SANDBOX_MAX_FILES` full-inspection tier are recorded hash-only (manifests keep their bounded retention headroom regardless of position), and only the `SANDBOX_MAX_ENTRIES` hard walk cap fails the parse. The streamed hash lets the diff prove whether a skipped body is byte-identical to the published baseline; its contents are still never inspected, so a body over the per-file limit is surfaced as a medium finding, while bulk demotions (budget spent or tier filled) are surfaced as one aggregate `retention-tier` finding per cause — info when every hash-only body is byte-identical to the baseline, medium when any hash-only file was added or modified. Changed-but-uninspected bytes must be verified out of band. Path-based filtering (skipping vendored/test/doc trees) is deliberately NOT used to stay under the caps: those are exactly the trees real supply-chain payloads hide in (xz's backdoor lived in build scripts and test fixtures), so coverage degrades to hash-only, never to unseen. The root npm manifest is always retained (or the scan fails closed); other manifests draw on bounded extra retention headroom. An oversized baseline (previous-version) archive degrades to a no-baseline scan rather than failing the staged review. On the anonymous public diff, a PyPI artifact that exceeds a sandbox cap is dropped from both sides of the pair (never one) and disclosed as a response notice; transient download failures stay fatal.

**Reviews are bound to the bytes they reviewed.** A file diff's strongest claim — "the publisher removed this file" — is only true if the archive Drydock parsed is the archive the registry holds; a truncated or substituted download produces the same report. The sandbox therefore digests each archive's raw wire bytes (SHA-1, the digest npm publishes as `shasum`) and returns it alongside the parsed evidence, and the npm staged-publish path compares it against the digest npm recorded for the stage. A mismatch raises the critical `stage.tarball-digest-mismatch` finding, which says the whole report describes a different artifact. The verdict (`verified` / `mismatch` / `unverified`, with both digests) is persisted in the report's staged-publish block and exposed in both the scan workbench and downloadable report so a reviewer reading an old report can tell a proven artifact from an unproven one; a failed stage-detail request persists an explicit `unverified` verdict rather than hiding the section. Scope: this proves transport and parse integrity against the registry's own record. It is not publisher authentication — a registry serving tampered bytes reports the tampered digest with them — and SHA-1 is used because it is the digest npm publishes, not for collision resistance. Verification fails to `unverified`, never to `mismatch`: a missing digest on either side is absence of evidence, so it raises no finding. A mismatch is confirmed against a second read of the stage record before it becomes a finding, because the bytes and the digest they are checked against arrive from two independent requests — a stage rewritten between them would otherwise be reported as tampering. If that confirmation read is unavailable, the verdict remains `unverified`; if it succeeds, its stage metadata becomes canonical for manifest merging, baseline selection, and persistence so a verified digest is never paired with a stale record.

## Workflow-gate posture

Workflow gates never publish. GitHub Environment protection holds the publish job, Drydock reviews uploaded artifacts, and Drydock only posts an accept/reject callback to GitHub. Gate state must resolve to the original installation, repository, workflow run, environment, callback URL, and organization. Artifact identity/digests are recomputed from bytes, not trusted from file names alone.

## AI prompt-injection posture

Package contents are hostile instructions. AI prompts must frame package text as evidence, restrict outputs to schema-validated findings, and keep deterministic findings/risk independent. AI input should include only the minimum changed-file evidence needed for review, never credentials, sessions, raw headers, or operator secrets. Invalid, partial, or unsafe AI output is ignored/unavailable rather than treated as a clean review.

Cloudflare Agent Traces are sampled at 10% for reviewer debugging, with message
and tool payload persistence explicitly disabled at both the tracing wrapper
(`storeMessages`/`storeTools`) and the AI SDK call
(`recordInputs`/`recordOutputs`). Trace metadata is restricted to an explicit
allowlist of runtime-context keys — operation/timing, model/usage, tool names,
reviewer version, ecosystem, and a fresh invocation-scoped random id. The
reviewer exposes only `run` through a narrow Workers AI binding facade so the
tracing wrapper cannot copy the AI Gateway log id into the trace. It must not
include scan, stage, organization, package, file, prompt, evidence, or
tool-result content. Aggregate AI execution and decision events follow the same
no-package-content rule; a maintainer decision is feedback, never an automatic
truth label. See
[`ai-review-eval.md`](./ai-review-eval.md).

For npm registry tarballs, consumer install lifecycle hooks are `preinstall`, `install`, and `postinstall`. `prepare`, `prepack`, `postpack`, and publish/prepublish hooks are packaging-time hooks and should not be treated as consumer-install evidence unless other evidence shows they changed the shipped artifact.

## Authorization posture

Every non-auth `/api/*` endpoint requires a Better Auth session and organization resolution. Reads and writes for scans, reports, npm connections, Slack installs, release targets, workflow gates, and settings must check organization ownership. UI state is not an authority; server routes make all access-control decisions.

One deliberate exception: the `/api/public/v1/package-diff` endpoints are anonymous by design. They serve only public release data — the public npm registry for `ecosystem=npm` (plus public `pkg.pr.new` preview tarballs), for `ecosystem=pypi` the `pypi.org` JSON API with artifact bytes only from `files.pythonhosted.org`, and for `ecosystem=atpm` the publisher's own AT Protocol identity and PDS (see [`atpm-public-diff.md`](./atpm-public-diff.md)) — never organization resources. They attach no credentials to any fetch, return 404 when `NPM_REGISTRY` is configured to a custom origin (the PyPI mode included), persist no review data to D1, and never run AI review. With the Rate Limiting bindings configured they reach D1 on no request path at all — locked by a test that hands the routes a D1 binding which throws on use. Their abuse controls are per-IP rate limits enforced before any validation or fetch, a shared computation budget for cold diff and file requests, anonymous colo caching of published tarball bytes, versioned colo/KV caching of computed results, and the sandbox's archive caps. Any new public endpoint must document the same properties here or require a session. Which mounts are anonymous is not a per-route decision: Hono runs middleware in registration order, so anything mounted above the `/api/*` session guard in `server/index.ts` is served without a session, and `test/api-auth-boundary-invariants.test.mjs` fails when that set changes.

## Session posture

Sessions are Better Auth sessions in a cookie signed with `BETTER_AUTH_SECRET`. Two caches sit in front of the session store so a burst of authenticated requests does not turn into a burst of D1 reads and refresh writes (`server/lib/auth/index.ts`):

- **Cookie cache.** `session.cookieCache` puts a signed copy of the session and user in the `spr.session_data` cookie for `SESSION_COOKIE_CACHE_SECONDS` (5 minutes). While it is fresh, a request resolves its session with no storage read at all.
- **KV secondary storage.** When the `AUTH_SESSIONS` KV namespace is bound, the session read/write path moves to KV. `storeSessionInDatabase` stays on, so D1 remains the durable record: a direct token miss or read failure falls back to D1, cache-write failures do not fail session creation after the D1 write, and sign-out and account deletion still delete a row. D1 fallback values stay request-local rather than being written through to KV: otherwise a fallback racing a revocation could put the stale session back after the revoker deleted both stores. Better Auth's `active-sessions-*` index is rebuilt from D1 on read, and those hydrated records likewise stay request-local while Better Auth lists them, so sessions created before KV was enabled—or temporarily absent from an eventually-consistent KV view—remain visible to list and revoke operations even during a KV read outage.

**Only session records reach KV, and that is enforced in code.** Better Auth has no per-model opt-out for secondary storage: once it is configured, its writer also runs for _verification_ records — email-verification links, password-reset tokens, the two-factor challenge and its attempt counter — and it names the KV key after the identifier, so `verification:reset-password:<token>` would put a live single-use credential in a KV key _name_, readable by anything with list access to the namespace. Two settings close this:

- `verification.storeInDatabase` keeps D1 authoritative, so `consumeVerificationValue` stays a transaction and a reset token or 2FA challenge cannot be redeemed twice (in KV it degrades to a non-atomic get-then-delete).
- `isSessionStoreKeyAllowed` in `server/lib/auth/index.ts` refuses to read, write, or delete any namespaced (`<namespace>:<identifier>`) key. Session keys — the raw token and `active-sessions-<userId>` — carry no colon, so the guard passes sessions and blocks verification records and any namespace a future Better Auth version adds. It is fail-safe: because D1 stays authoritative for both record kinds, a suppressed write costs a cache miss, never correctness.

Better Auth's own request limiter also silently switches from in-isolate memory to secondary storage when one is configured. It is pinned back to `memory`, so enabling the session cache adds no KV round-trip to `/api/auth/*` and the limiter does not inherit KV's eventual consistency under the load it exists to shed. Drydock's per-IP limits below are the real control.

The security consequence is a bounded **revocation lag**. After a sign-out, a session revocation, or an account deletion, a request that still presents a fresh `spr.session_data` cookie can be served for up to the cookie-cache lifetime, plus KV's own eventual consistency across colos. Sign-out expires both cookies, so a cookie-following client loses access immediately; the lag matters for a replayed or stolen cookie. Keep `SESSION_COOKIE_CACHE_SECONDS` short. Better Auth normally catches a session-delete failure and still reports sign-out success, so Drydock preflights the authorizing KV-token eviction before the endpoint runs. If that eviction fails, sign-out returns an error without clearing either cookie or deleting the D1 row, leaving the caller able to retry instead of reporting that a still-replayable session was revoked. The non-authorizing active-session index is best-effort cleanup and is rebuilt from D1 when needed.

Account deletion evicts every known session key from KV before its destructive Drydock cleanup begins. If that eviction fails, the request fails while the user, organizations, artifacts, memberships, and two-factor data are still intact; Better Auth's duplicate cache deletes become request-local no-ops only after the preflight succeeds.

Nothing that authorizes a release decision is cached. Organization membership and role (`requireActiveOrganization*`), resource ownership, two-factor enrollment (`userHasTwoFactor`), the organization's two-factor policy, and the encrypted TOTP secret all read D1 on every request, so a member removed from an organization or a policy change takes effect immediately even while a session cookie is still cached.

A cached session can outlive its user by up to the cache lifetime, so `ensurePersonalOrganization` verifies the user row still exists before lazily creating an organization for it. Without that check the first organization-scoped request from a deleted account's second device would trip the `owner_user_id` foreign key and answer 500; it now raises `UnauthorizedError`, which `app.onError` renders as 401.

## Rate limiting

`enforceRateLimit` (`server/lib/platform/rate-limit.ts`) is the single entry point for abuse control. Its backend is Cloudflare's native Rate Limiting binding — a per-colo fixed-window counter that costs no D1 write — so anonymous `/diff` floods and credential-stuffing bursts never reach the D1 single writer.

The binding's `{limit, period}` pair is static per binding and `period` may only be 10 or 60 seconds. `wrangler.jsonc` therefore declares one `ratelimits` binding per per-minute limit the app enforces (`NATIVE_TIERS` in the module), and:

- **Per-minute budgets** (the anonymous `/diff` endpoints, `compare`/`compare-file`/`versions`, GitHub proxy lookups, gate decisions, Slack channel listing, GitHub webhooks) are enforced entirely by the binding.
- **Longer budgets** — the 15-minute and hourly limits on human-initiated actions such as sign-in, sign-up, password reset, organization creation, invitations, and connecting npm or Slack — cannot be expressed by the binding, so they keep the D1 `rate_limits` counter. Each one first passes a native per-minute burst guard whose limit is at or above the long-window limit, which can only reject traffic the long window would reject anyway while capping how many D1 writes one key can force per minute per colo.

Semantic differences from the previous D1-only scheme, accepted deliberately:

- Counters are **per-colo, not global**. A distributed client gets up to `limit` per colo per window. These are abuse controls, not quotas; the authorization checks above are what protect data.
- `Retry-After` is derived from the wall-clock window instead of read back from a counter row, because the binding reports only allowed/blocked.
- Expired D1 buckets are swept by the scheduled handler (`pruneExpiredRateLimitBuckets`) rather than by an unbounded `DELETE` piggybacked on a request that happened to cross a per-isolate timer.

GitHub webhook deliveries are the one place where a 429 destroys work rather than deferring it: GitHub does not retry a delivery we reject, so a dropped `deployment_protection_rule` leaves a workflow waiting on a gate nobody will review, and a dropped `installation` leaves a stale installation record. Those budgets are sized as a runaway-loop backstop rather than a queueing control (240/min for gate deliveries, far above any realistic monorepo fan-out), the two event kinds get separate buckets so gate traffic cannot starve lifecycle events, and a rejection is logged at error because it means work was lost.

A deployment that omits the `ratelimits` bindings still enforces every limit, through the D1 counter, and logs `rate_limit.tier_missing`. Adding a new per-minute limit at a call site requires a matching tier and binding; without one it silently degrades to D1.

The `/og/diff/**/card.png` share cards are part of the same anonymous surface and inherit its rules: no session, no credentials, the same custom-registry 404 killswitch, and a per-IP rate limit charged only on a cold render. A card never triggers analysis — it reads the public-diff result cache and, on a miss, renders the package name and version pair with no numbers, so an unauthenticated request can never make the Worker download or parse a tarball. Package names and versions reach the card as text: they are XML-escaped and stripped of control characters and bidi overrides before rasterization, and width-fitted so a long name cannot overflow the frame.

Document requests for the public surfaces (landing, docs, `/diff`) are not instrumented at all. There is no referrer classification, no campaign parameter handling, and no page-view event — the only analytics a visit can produce is the `public_diff.viewed` counter written when a diff is actually computed, which carries the package name and nothing about the visitor. See [`product-analytics.md`](./product-analytics.md).

`GET /api/auth/config` belongs to the anonymous `/api/auth/*` surface because the login and register pages must know which sign-in methods the deployment offers before any session can exist. It returns one boolean — whether the operator configured the GitHub sign-in credential pair — derived from environment configuration alone. It reads no bindings, touches neither D1 nor KV, reflects nothing about the caller, and cannot be made to do work, so it carries no rate limit of its own. Sign-in itself stays behind the existing per-IP `sign-in` bucket.

Three further anonymous endpoints exist, all under `/public`, all serving only data an organization owner/admin explicitly opted into publishing:

- `GET /public/reports/:token` and `GET /public/reports/:token/attestation` — capability URLs. The unguessable 256-bit share token _is_ the authorization; unknown, malformed, and revoked tokens are indistinguishable 404s. They serve the canonical report export (never file samples, events, or org/user identifiers), attach no credentials, persist nothing, are `no-store` so revocation is immediate, and are per-IP rate limited. `GET /public/attestation-key` returns public key material only.
- `GET /public/badge/:ecosystem/*` — a shields.io endpoint payload for a package's latest review. Reflects only scans whose org took the _second_ opt-in (feed listing) on top of sharing, so a private share link never makes a scan name-queryable. The response carries no package name, no org identity, and no share token; an unlisted-but-scanned package and a never-scanned package return byte-identical bodies, so there is no enumeration oracle. Separate per-IP rate-limit bucket (badge proxies multiplex unrelated packages through shared egress addresses), and a throttled response says `unavailable` rather than impersonating `not reviewed`.
- `GET /public/threat-feed.json` — the listed set, newest first, keyset-paginated. Entries carry package identity, risk, decision, counts, and the public report URL; no organization id, user id, or internal scan id.

Both derived surfaces are colo-cached for 300s and purged on revoke/unlist. That purge is **colo-local and best effort** — it clears the region that served the revoking request, and every other region serves the withdrawn body until the TTL expires (longer still behind a badge proxy's own cache). The report itself has no such window. Treat the badge and feed as eventually consistent; the report route is the authority.

The atpm egress is the one public-diff path whose hosts are named by the party under review: a handle resolves to a DID chosen by whoever controls that domain, and a DID document names a PDS chosen by whoever controls the DID. It is bounded rather than trusted. Every URL is rebuilt from validated parts — never followed as given, so a record's own `meta.dist.tarball` is ignored in favour of a blob URL built from the resolved PDS and the content address — and re-checked against one public-host policy before the parent Worker fetches it: https only, no embedded credentials, default port only (a DID document naming `https://<host>:9200` would otherwise make this a port prober), no IPv4/IPv6 literals, no loopback, no atproto-reserved or local-use suffixes (`.alt`, `.arpa`, `.example`, `.invalid`, `.local`, `.localhost`, `.onion`, `.test`, plus private-network suffixes), and no single-label hostnames. A DID document's PDS service endpoint must be an origin with no path, query, or fragment; Drydock rejects extra components instead of silently discarding them. The Worker enables `global_fetch_strictly_public`, so even same-zone global `fetch()` targets traverse Cloudflare's public front door rather than bypassing mapped Workers and security settings for the zone's origin. Automatic redirects are disabled for identity and record fetches; at most three hops are followed, and every resolved target is checked by the same policy before any request. Identity and DID documents are read under a hard 256 KiB ceiling and package records under 4 MiB, so a publisher-controlled endpoint cannot decide how much parent-Worker memory a lookup costs. A handle is only accepted when it is the DID document's first valid `at://` claim; a DID-addressed lookup instead resolves that same primary claimed handle back through DNS/well-known and keeps it only if it returns the same DID. Either way a displayed handle is one this resolution proved, never one asserted by the repository under review. The canonical DID form prevents ordinary handle reuse from redirecting a link, but `did:web` remains tied to domain control and is disclosed as such on the report. Tarball bytes reach the credentials-free sandbox with the blob URL pinned as the single allowed egress, exactly as the PyPI path does, and a pinned artifact may not be redirected off its origin: `NpmStageGateway` resolves 3xx responses for `public-artifact` requests itself, following same-origin hops (bounded at three) and refusing anything that leaves the vetted origin, so a redirect cannot route around the host policy. The sandbox also computes SHA-256 over the complete archive and the parent requires it to match the digest encoded by the blob's CID, so a PDS cannot substitute bytes at a requested address. Credentialed npm requests keep the runtime's own redirect handling. Nothing on this path ever holds npm credentials. Computed atpm pairs and their share cards expire after five minutes because the version-to-CID record, PDS location, and verified display handle remain mutable even though CID-addressed bytes do not.

The same policy, and the same absence of credentials, covers atpm's staged review: a release candidate is a public record in the publisher's repository read through the identity above, so it adds reachable hosts but no new trust and no new secret. The staged URL carries the record CID, and Drydock re-encodes the returned value as DAG-CBOR and recomputes that CID locally; an untrusted PDS cannot make one revision-pinned URL describe a different record merely by echoing the old CID. Build attestations read on either atpm path are verified against a _pinned_ Sigstore root using a bounded DER reader (`server/lib/platform/x509.ts`) that parses only the certificate fields a signature check needs; a bundle is attacker-supplied data, so every malformed input becomes a displayable "does not verify" verdict rather than an exception or a page failure. Verification work is capped at 64 bundles for each published record, while a staged review verifies its one requested candidate. The Rekor signed-entry timestamp is verified against a pinned log key before its integrated time may evaluate the short-lived Fulcio leaf's validity window; the Merkle inclusion proof itself is not independently reconstructed. `GET /api/public/v1/package-diff/atpm-stage?publisher=<publisher>&rkey=<rkey>` resolves a staged atpm candidate inside the existing public-diff surface: browser navigation redirects to the ordinary review, while API callers receive the same resolution as JSON. It reads only public records in the publisher's own AT Protocol repository, attaches no credentials, persists no staged record or link-resolution event, and creates no session; abuse control is the same per-IP rate limiting as the rest of `/diff`. Once redirected, the ordinary public-diff analytics posture described above applies: the public package name may be recorded, but no visitor identity. Like every public-diff route, it is disabled before any outbound fetch when the deployment configures a custom `NPM_REGISTRY`. Requiring a session there would gate a deterministic diff of public bytes behind an account, at the one moment it is worth reading — before the release is published.

Nothing on the atpm path holds a credential, and staged reviews are reached by link rather than by watching or persisting a publisher's repository. See [`atpm-trusted-publishing.md`](./atpm-trusted-publishing.md).

The `pkg.pr.new` egress (npm only) is bounded by a shared strict URL parser (`src/lib/pkg-pr-new.ts`): only `https://pkg.pr.new` (exact host, no port, no credentials, no query/fragment) with a canonical `owner/repo/name@ref`-shaped path is ever fetched, the fetch path is structurally anonymous (`fetchPkgPrNewTarballStream` accepts no token option), and preview bytes are never written to the shared colo tarball cache because preview refs are mutable. Diff results that involve a preview side are cached for at most 15 minutes.

## Browser response headers

Production responses should keep conservative security headers: no package-provided active content, no cross-origin credential leakage, and no relaxed CSP/CORS decisions for convenience.

## Known gaps / future work

- Public report sharing is an explicit owner/admin opt-in per completed scan; the badge and threat feed are a second opt-in on top of it. See `public-reports.md` and the authorization posture section above.
- Raw-artifact retention, if ever added, must be explicit, short-TTL, organization-scoped, and documented.
- Additional ecosystems need adapter-specific credential, baseline, artifact, and failure-mode review before enablement.
- Keep dependency and parser updates covered by regression/fuzz tests because archive handling is a trust boundary.
