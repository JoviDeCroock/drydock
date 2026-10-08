# Organization API keys

Bearer credentials that let scripts, CI jobs, and the Drydock CLI read one organization's reviews, and optionally start them, without a browser session. Owners and admins manage them in **Organization settings → Integrations → API keys** (`GET/POST /api/v1/api-keys`, `DELETE /api/v1/api-keys/:keyId`).

A key is the one authenticated exception to "every non-auth `/api/*` endpoint requires a Better Auth session". It never widens what a member can do, and no key records a release decision.

## Access levels

Each key is created with one access level, fixed for its lifetime (`access` on `POST /api/v1/api-keys`; widening a key means issuing a new one):

- **`read`** (the default) reaches only the reads below.
- **`scan`** also starts reviews: `POST /api/v1/scans` for one staged npm publish or one published release, and `POST /api/v1/staged-publishes/scan`, the dashboard's "Check npm". This lets a release job stage, start the review, and wait for its risk without waiting for the 15-minute discovery cron.

A `read` key that calls a review-starting route gets `403 { code: "api_key_access_insufficient" }`.

## Using a key

```sh
curl -H "Authorization: Bearer $DRYDOCK_API_KEY" https://drydock.org/api/v1/scans?filter=all
```

`GET /api/v1/api-keys/current` returns the key's own name, prefix, expiry, and organization, so a script can check a key before relying on it. The [`drydock` CLI](../cli/README.md) is built on the routes below.

A key belongs to exactly one organization. It ignores the dashboard's active-organization selector; a request whose `x-organization-id` (or report-export `?organizationId=`) names a different organization is refused (`403 api_key_organization_mismatch` or `404`), never answered from the key's own organization.

## What a key can reach

Every key reaches these routes, all reads a plain member can already make (`API_KEY_ROUTES` in `server/lib/auth/api-keys.ts`):

| Route                                                   | Returns                                       |
| ------------------------------------------------------- | --------------------------------------------- |
| `GET /api/v1/api-keys/current`                          | the calling key and its organization          |
| `GET /api/v1/openapi.json`                              | the OpenAPI document for this surface         |
| `GET /api/v1/scans`                                     | the review list (`filter`, `cursor`, `limit`) |
| `GET /api/v1/scans/overview`                            | dashboard counts                              |
| `GET /api/v1/scans/:id`                                 | one review                                    |
| `GET /api/v1/scans/:id/status`                          | a review's lifecycle status, for polling      |
| `GET /api/v1/scans/:id/report.json`                     | the canonical report export                   |
| `GET /api/v1/scans/:id/release-receipt.json`            | the Release Receipt                           |
| `GET /api/v1/packages/:name/releases`                   | one package's reviews (`ecosystem`, `cursor`) |
| `GET /api/v1/github-app/workflow-gates/by-scan/:scanId` | the workflow gate a review belongs to         |

A `scan` key also reaches these (`API_KEY_SCAN_ROUTES`):

| Route                                | Does                                                                       |
| ------------------------------------ | -------------------------------------------------------------------------- |
| `POST /api/v1/scans`                 | starts one review: `{ stageId }`, or `{ ecosystem, packageName, version }` |
| `POST /api/v1/staged-publishes/scan` | checks npm with the organization's npm token and starts any new reviews    |

Both are actions any member can take from the dashboard, and both run the same handlers with the same checks: the npm token must be connected and valid, package claims apply, and the per-organization scan and discovery rate limits are shared with the dashboard. The review is created as the key's creator (`requestActorUserId`), the way a cron-discovered review belongs to whoever connected npm, so notifications and ownership behave as if that member had clicked the button.

Every other `/api/*` route answers a key with `403 { code: "api_key_endpoint_not_allowed" }`: a key cannot record a scan or gate decision, approve a batch, share a report, manage members or credentials, or read the audit log. Release decisions stay with signed-in maintainers, behind the organization's two-factor policy.

The check matches the route that will answer the request, not the URL: `server/middleware/api-key-auth.ts` reads Hono's matched routes and compares the first method-bound route's registered path. `/api/v1/scans/batch-approval` therefore cannot pass as `/api/v1/scans/:id`. Adding a route to either allowlist is a security decision: it must be something a member can do and must not record a release decision, its handler must resolve the organization through `requireActiveOrganization*` and the actor through `requestActorUserId` rather than reading `authSession` (an API-key request has none), and `test/workers/api-keys.test.ts` must exercise it.

## OpenAPI document

[`openapi.json`](./openapi.json) describes every route above plus the anonymous package-diff endpoints as OpenAPI 3.1, and `GET /api/v1/openapi.json` serves the same document. Its response schemas are the zod contracts in `server/lib/openapi/schemas.ts`. They pin the fields scripts may rely on and leave other fields open; a field missing from a schema is not part of the contract.

- `test/openapi-document.test.ts` fails when the documented operations stop matching `API_KEY_ROUTES` and `API_KEY_SCAN_ROUTES` (review-starting operations carry `x-drydock-api-key-access: scan`), or when the checked-in file is stale. To regenerate after a deliberate change, run `WRITE_OPENAPI=1 pnpm exec vitest run --project node test/openapi-document.test.ts`.
- `test/workers/openapi-conformance.test.ts` parses a real response from every operation (the review-starting ones against a stubbed npm), except the version listing that reaches the live registry. A schema therefore cannot promise a field the Worker does not send.
- `OPENAPI_API_VERSION` follows semver. Bump the minor version for additive changes and the major version for removals or type changes.

## Authentication rules

- An `Authorization` value that mentions a `ddk_` key selects key authentication, and anything but exactly `Bearer ddk_…` then fails as a malformed key. Any other `Authorization` value (for example HTTP basic auth in front of a self-hosted staging deployment) is ignored and the request keeps the cookie path.
- A request that presents a key is never authenticated by its cookie. An unknown, malformed, revoked, or expired key is `401 { code: "invalid_api_key" }` with a `WWW-Authenticate: Bearer` header.
- Every request that presents a key is first charged to a per-IP budget of 240 per minute (`api-key-ip:<ip>`), before the key is looked up, so a flood of random keys cannot turn into anonymous D1 reads beyond that budget.
- Each key has its own budget of 120 requests per minute (`api-key:<keyId>`, served by the native 120-per-minute tier).
- A request that presents a key to an `/api/v1/` route skips the CSRF origin check (`server/middleware/csrf-origin.ts`), since scripts send no `Origin`. Below the session guard such a request never reads a cookie (any `ddk_` value selects key authentication, and an unknown one is a 401), and a cross-site page cannot add an `Authorization` header without a CORS preflight the app never grants. Better Auth's `/api/auth/*` routes are answered from cookies ahead of the guard, so they keep the origin check whatever the request presents. Cookie requests are checked exactly as before.
- `test/api-auth-boundary-invariants.test.mjs` pins that the session guard's only sessionless exit follows `authenticateApiKeyRequest`, and that no path-specific `.all()` handler is registered below the guard (one would answer ahead of the route the key check judges).

## Storage and lifecycle

- **Format.** `ddk_` followed by 32 random bytes in base64url (47 characters). The prefix lets humans and secret scanners recognize a leaked key.
- **Storage.** `organization_api_keys` stores the SHA-256 (base64url) of the key, the non-secret display prefix (`ddk_` plus eight characters), name, access level, creator, creation and expiry times, and `last_used_at`. The secret appears in exactly one response, the `201` that creates it (`cache-control: no-store`), and is never logged, persisted, or written to the audit log.
- **Expiry.** Every key expires after 30, 90 (default), or 365 days. There is no non-expiring key.
- **Limits.** At most 10 unexpired keys per organization (an expired key stays listed until revoked but holds no slot); creation is rate limited to 20 per hour per user and requires a verified email where verification is enforced.
- **Revocation.** Revoking deletes the row and takes effect on the next request; nothing caches a key.
- **Membership.** A key lives no longer than its creator's membership. The lookup that authenticates a key joins the creator's membership, so a key stops working the moment its creator is no longer a member, however the membership ended. Removing a member also deletes the keys they created in that organization in the same batch (`removeOrganizationMember`), deleting an account deletes every key it created, and deleting an organization deletes its keys.
- **Last used.** `last_used_at` is a settings hint, debounced to one write per five minutes per key, not an access log.

## Audit events

`organization.api_key_created` and `organization.api_key_revoked` appear in the organization audit log with the key's name, display prefix, and access (see [`audit-log.md`](./audit-log.md)). Individual key reads are not recorded. Every review a key starts is: `organization.api_key_review_started` (package, version, and review id) and `organization.api_key_discovery_ran` (how many stages it found and reviews it started), each attributed to the key's creator and naming the key.
