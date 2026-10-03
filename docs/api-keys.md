# Organization API keys

Read-only bearer credentials that let scripts, CI jobs, and the Drydock CLI read one organization's reviews without a browser session. Owners and admins manage them in **Organization settings → Integrations → API keys** (`GET/POST /api/v1/api-keys`, `DELETE /api/v1/api-keys/:keyId`).

A key is the one authenticated exception to "every non-auth `/api/*` endpoint requires a Better Auth session". It never widens what a member can see, and it cannot change anything.

## Using a key

```sh
curl -H "Authorization: Bearer $DRYDOCK_API_KEY" https://drydock.org/api/v1/scans?filter=all
```

`GET /api/v1/api-keys/current` returns the key's own name, prefix, expiry, and organization, so a script can check a key before relying on it.

A key belongs to exactly one organization. It ignores the dashboard's active-organization selector; a request whose `x-organization-id` (or report-export `?organizationId=`) names a different organization is refused (`403 api_key_organization_mismatch` or `404`), never answered from the key's own organization.

## What a key can reach

Only these routes, all reads a plain member can already make (`API_KEY_ROUTES` in `server/lib/auth/api-keys.ts`):

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

Every other `/api/*` route answers a key with `403 { code: "api_key_endpoint_not_allowed" }`, including every write: a key cannot record a scan or gate decision, start a review, share a report, manage members or credentials, or read the audit log. Release decisions stay with signed-in maintainers, behind the organization's two-factor policy.

The check matches the route that will answer the request, not the URL: `server/middleware/api-key-auth.ts` reads Hono's matched routes and compares the first method-bound route's registered path. `/api/v1/scans/batch-approval` therefore cannot pass as `/api/v1/scans/:id`. Adding a route to the allowlist is a security decision: it must be a read a member can make, its handler must resolve the organization through `requireActiveOrganization*` rather than reading `authSession` (an API-key request has none), and `test/workers/api-keys.test.ts` must exercise it.

## OpenAPI document

[`openapi.json`](./openapi.json) describes every route above plus the anonymous package-diff endpoints as OpenAPI 3.1, and `GET /api/v1/openapi.json` serves the same document. Its response schemas are the zod contracts in `server/lib/openapi/schemas.ts`. They pin the fields scripts may rely on and leave other fields open; a field missing from a schema is not part of the contract.

- `test/openapi-document.test.ts` fails when the documented operations stop matching `API_KEY_ROUTES`, or when the checked-in file is stale. To regenerate after a deliberate change, run `WRITE_OPENAPI=1 pnpm exec vitest run --project node test/openapi-document.test.ts`.
- `test/workers/openapi-conformance.test.ts` parses a real response from every operation, except the version listing that reaches the live registry. A schema therefore cannot promise a field the Worker does not send.
- `OPENAPI_API_VERSION` follows semver. Bump the minor version for additive changes and the major version for removals or type changes.

## Authentication rules

- Only `Authorization: Bearer ddk_…` selects key authentication. Any other `Authorization` value (for example HTTP basic auth in front of a self-hosted staging deployment) is ignored and the request keeps the cookie path.
- A request that presents a key is never authenticated by its cookie. An unknown, malformed, revoked, or expired key is `401 { code: "invalid_api_key" }` with a `WWW-Authenticate: Bearer` header.
- Every request that presents a key is first charged to a per-IP budget of 240 per minute (`api-key-ip:<ip>`), before the key is looked up, so a flood of random keys cannot turn into anonymous D1 reads beyond that budget.
- Each key has its own budget of 120 requests per minute (`api-key:<keyId>`, served by the native 120-per-minute tier).
- Keys are only used on `GET`, so the CSRF origin check is unchanged.
- `test/api-auth-boundary-invariants.test.mjs` pins that the session guard's only sessionless exit follows `authenticateApiKeyRequest`.

## Storage and lifecycle

- **Format.** `ddk_` followed by 32 random bytes in base64url (47 characters). The prefix lets humans and secret scanners recognize a leaked key.
- **Storage.** `organization_api_keys` stores the SHA-256 (base64url) of the key, the non-secret display prefix (`ddk_` plus eight characters), name, creator, creation and expiry times, and `last_used_at`. The secret appears in exactly one response, the `201` that creates it (`cache-control: no-store`), and is never logged, persisted, or written to the audit log.
- **Expiry.** Every key expires after 30, 90 (default), or 365 days. There is no non-expiring key.
- **Limits.** At most 10 keys per organization; creation is rate limited to 20 per hour per user and requires a verified email where verification is enforced.
- **Revocation.** Revoking deletes the row and takes effect on the next request; nothing caches a key.
- **Membership.** A key lives no longer than its creator's membership. Removing a member deletes the keys they created in that organization in the same batch (`removeOrganizationMember`), deleting an account deletes every key it created, and deleting an organization deletes its keys.
- **Last used.** `last_used_at` is a settings hint, debounced to one write per five minutes per key, not an access log.

## Audit events

`organization.api_key_created` and `organization.api_key_revoked` appear in the organization audit log with the key's name and display prefix (see [`audit-log.md`](./audit-log.md)). Individual key requests are not recorded.
