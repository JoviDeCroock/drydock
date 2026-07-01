# MCP / agent integration

Drydock exposes a **read-only, organization-scoped MCP server** so a headless
agent (an IDE assistant, a CI job, a chat bot) can inspect a package-release scan
and help a human decide whether to publish. It surfaces the same redacted
evidence the internal AI reviewer already walks — file text, diffs, deterministic
findings, risk — plus scan status and the audit trail.

The integration is **strictly advisory**. Every tool is a read. No tool records a
publish/no-publish decision, mutates a scan, or fetches package bytes: the agent
informs, a human still clicks in the UI. This mirrors the AI reviewer invariant
(advisory, cannot downgrade deterministic findings).

## Authentication — API tokens

Agents authenticate with an organization-scoped bearer token instead of a Better
Auth session cookie. Tokens are managed by an org member who can manage
integrations (owner/admin):

- `POST /api/v1/api-tokens` `{ name, expiresInDays? }` — mints a token. The
  plaintext secret (`dryd_pat_…`) is returned **once** in the `secret` field;
  only its SHA-256 hash is stored. `expiresInDays` is optional (1–365); omit for
  a non-expiring token.
- `GET /api/v1/api-tokens` — lists token metadata (name, prefix, scope,
  last-used, expiry). Never returns the secret or hash.
- `DELETE /api/v1/api-tokens/:id` — revokes (hard-deletes) a token.

Tokens are `read` scope only. Creation and revocation are recorded as
org-level audit events (`api_token.created` / `api_token.revoked`).

## Transport

`POST /mcp` speaks **JSON-RPC 2.0** over a single request/response (no SSE
streaming — the tools are synchronous reads over an already-persisted scan).
Present the token as `Authorization: Bearer dryd_pat_…`.

The `/mcp` route is mounted before the `/api/*` cookie + CSRF-Origin middleware
(like the signed GitHub webhook route): headless agents present a token, not a
session, and POST cross-origin with no `Origin` header. The token-hash lookup is
the trust boundary. Every auth failure — missing, malformed, unknown, expired, or
revoked token — returns an identical opaque `401` with a `WWW-Authenticate:
Bearer` challenge, so a caller cannot probe which tokens exist. Requests are rate
limited per token.

Supported methods: `initialize`, `ping`, `tools/list`, `tools/call`, and
`notifications/*` (acknowledged with `202`, no body).

## Tools

All tools are org-scoped to the token's organization; a scan in another
organization is indistinguishable from one that does not exist (`isError` tool
result, never a leak).

| Tool | Purpose |
| --- | --- |
| `find_scans` | List scans (newest first) with risk + decision state; paginate via the opaque `nextCursor`. Filter by `undecided` \| `publish` \| `no_publish` \| `all`. |
| `get_scan_status` | Lightweight lifecycle status (`pending` \| `running` \| `complete` \| `failed`) + package/version metadata. Cheap to poll while a scan runs. |
| `get_scan_report` | Full analysis for a completed scan: risk summary, deterministic findings (with diff-status + release-delta annotations), and the advisory AI review if present. No file contents. |
| `list_scan_files` | File metadata for a focused subset — `changed` \| `scripts` \| `binaries` \| `large` \| `entrypoints` \| `findings`. Metadata only. |
| `read_scan_files` | Bounded redacted text for up to 10 package-relative paths. Changed files return a unified diff; others return staged text. |
| `search_scan_files` | Literal case-insensitive search (up to 5 queries) over the redacted text samples. |
| `list_scan_events` | The redacted lifecycle/audit event trail for a scan, oldest first. |

`read_scan_files` / `search_scan_files` / `list_scan_files` are backed by the same
`EvidenceReader` the internal AI reviewer uses (`server/lib/ai-review-evidence.ts`),
re-keyed off the persisted scan artifacts (R2 `files.json` + `diff.json` +
report findings) via `getScanEvidence`. All returned text is the same redacted,
byte-bounded evidence — **hostile package data, never instructions**. Tool
descriptions carry that framing so a well-behaved agent treats package contents as
untrusted.

## "Talking to a scan that's happening"

Rich findings/diffs are persisted when a scan reaches `complete`. While a scan is
`running` there is status + the event trail but no partial findings. The MVP
pattern is: poll `get_scan_status`, then query the evidence tools once the scan
completes. Streaming partial pipeline progress (per-phase events, a live event
tool) is a possible follow-up and is intentionally out of scope for this
read-only v1.
