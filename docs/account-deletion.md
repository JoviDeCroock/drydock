# Account deletion

A signed-in user permanently deletes their own account from Account settings (`/dashboard/account` → Danger zone). **Authority:** enforced. **Owner:** `beforeDelete` in `server/lib/auth/index.ts` (Better Auth [`deleteUser`](https://www.better-auth.com/docs/concepts/users-accounts#delete-user)) and `deleteUserAccount` in `server/db/organizations.ts`.

## At a glance

| Thing | Owner file | Who may trigger | Pinned by |
| --- | --- | --- | --- |
| Delete request + reauth | Better Auth `POST /api/auth/delete-user` | The account's own session | `test/workers/account-deletion.test.ts` |
| Co-owned organization block | `findCoOwnedOrganizations` in `server/db/organizations.ts` | — | `test/workers/account-deletion.test.ts` |
| Drydock data teardown | `deleteUserAccount` in `server/db/organizations.ts` | `beforeDelete` only | `test/workers/account-deletion.test.ts` |
| UI | `src/pages/Dashboard/Account/DeleteAccountSection.tsx` | Signed-in user | `test/auth-account-deletion-model.test.ts` |

## Contract

### Request

| Account type | Body | Reauthentication | Failure |
| --- | --- | --- | --- |
| Has `credential` | `{ password }` | Better Auth verifies the password before `beforeDelete` runs | `400 INVALID_PASSWORD`, nothing touched |
| GitHub-only | `{}` | The OAuth-created session must still be fresh | User signs out, signs in with GitHub, retries |

The UI always requires typing the account's own email, so a stray click cannot fire it, and asks for a password only when `GET /api/auth/list-accounts` reports a `credential` row.

### Order of operations

| Step | Action | Owner |
| --- | --- | --- |
| 1 | Refuse if the user owns a non-personal organization with other members: `400 { code: "OWNS_SHARED_ORGANIZATIONS" }` naming them | `findCoOwnedOrganizations` |
| 2 | Evict every known session key from KV; on failure the request fails with all data intact | `sessionCache.prepareUserDeletion` |
| 3 | Delete the user's publisher setup jobs and their private R2 state | `deletePublisherSetupJobsForUser` |
| 4 | Delete every sole-owned organization (personal workspace plus owned orgs with no other members) | `deleteOrganization` |
| 5 | Null the user's references in surviving organizations | `deleteUserAccount` batch |
| 6 | Delete remaining `organization_members` rows and the `two_factor` row | `deleteUserAccount` batch |
| 7 | Better Auth deletes `user`, `session`, `account` rows after `beforeDelete` returns | Better Auth |

### What `deleteOrganization` removes (step 4)

One D1 batch removes publisher setup jobs, scan events, scans, workflow gates, release targets, GitHub App installations, npm connection, notification recipients, Slack connection, invitations, memberships, and the organization row. The organization's R2 artifacts are deleted afterwards, separately (`deleteOrganizationArtifacts` in `server/db/organizations.ts`). npm package claims keep their registry/package identity with a null organization as a reservation; deleting an account never makes its packages available for automatic reassignment, and an operator must explicitly resolve any later ownership transfer ([package claims](./package-claims.md)).

### References nulled in surviving organizations (step 5)

| Table | Columns |
| --- | --- |
| `scans` | `owner_user_id`, `decided_by_user_id`, `public_shared_by_user_id` |
| `scan_events` | `actor_user_id` |
| `npm_connections` | `created_by_user_id` |
| `organization_slack_connections` | `created_by_user_id` |
| `github_app_installations` | `created_by_user_id` |
| `github_release_targets` | `created_by_user_id` |
| `organization_notification_recipients` | `created_by_user_id` |
| `organization_invitations` | `invited_by_user_id`, `accepted_by_user_id` |

### On success

The session cookie is cleared server-side and all other sessions are revoked by the Better Auth delete; the client drops its local session and redirects to `/`.

## Invariants

1. Drydock-owned rows are deleted or nulled by hand: D1 does not enforce foreign keys, so nothing cascades on its own (same reason as `deleteOrganization`). The nulled columns are `ON DELETE SET NULL`; nulling them prevents dangling joins.
2. A co-owned organization is never wiped: `findCoOwnedOrganizations` rejects before any cleanup, and `deleteUserAccount` also skips one if it is reached. Removing the owner would orphan the org or destroy other members' scans, npm token, and GitHub gates.
3. The personal workspace is always sole-owned, so it never blocks deletion.
4. A cached session can outlive the user by the cookie-cache lifetime; such a request gets `401`, not a lazily recreated organization ([session posture](./security-model.md#session-posture)).

## Failure modes

| Condition | Response | Fix |
| --- | --- | --- |
| Wrong password | `400 INVALID_PASSWORD` | Retry with the right password |
| Stale GitHub-only session | Better Auth freshness error | Sign out, sign in with GitHub, retry |
| Owns a shared organization | `400 { code: "OWNS_SHARED_ORGANIZATIONS" }` | Delete each shared org (Settings → General → Danger zone), then retry. Ownership transfer is not implemented; if added, it slots in ahead of this block |
| KV session eviction fails | Request fails; no data deleted | Retry |

## Tests

`test/workers/account-deletion.test.ts` drives the real Better Auth handler and asserts against D1: password and GitHub-only deletion (user, personal workspace, sessions, accounts gone), the shared-org block (account and org untouched, error names the org), membership removal and reference nulling in an org owned by someone else, and wrong-password rejection.

## Change checklist

- New table with a user-id column → add it to step 5 (null) or step 4 (org-scoped delete) and extend `test/workers/account-deletion.test.ts`.
- New org-scoped table → add it to `deleteOrganization` and to [organization members](./organization-members.md#organization-deletion).
