# Organization members and invitations

Roles, role-guarded routes, and the email-token invitation flow for multi-user organizations. **Authority:** enforced. **Owner:** `server/lib/auth/roles.ts` (roles), `server/routes/organization-members.ts` (members and invitations).

## At a glance

| Thing | Owner file | Who may call | Pinned by |
| --- | --- | --- | --- |
| Role definitions | `server/lib/auth/roles.ts` | — | `test/workers/organization-members-routes.test.ts` |
| Active org + role guard | `server/lib/auth/active-organization.ts` | Every org-scoped route | `test/workers/organization-members-routes.test.ts` |
| Members / invitations | `server/routes/organization-members.ts` | See matrix | `test/workers/organization-members-routes.test.ts` |
| Invitation token | `server/lib/auth/invitation-token.ts` | — | `test/workers/organization-members-routes.test.ts` |
| Invite email | `notifyOrganizationInvite` in `server/lib/notify/organization-invite.ts` | Create invitation | `test/workers/organization-members-routes.test.ts`, `test/notify.test.mjs` |
| Account names | `server/lib/auth/user-name.ts` | Sign-up, `update-user`, GitHub sign-in | `test/workers/user-names.test.ts` |
| Org rename/delete/policy | `server/routes/organizations.ts` | Owner | `test/workers/organizations-routes.test.ts` |

## Contract

### Roles

| Role | Who | Can |
| --- | --- | --- |
| `owner` | `organizations.ownerUserId`; exactly one; created with the org (`createOrganization` / `ensurePersonalOrganization` insert its `organization_members` row) | Everything below, plus rename, delete, release two-factor policy. Cannot be removed or demoted through the API |
| `admin` | Invited or stored role | Manage members, invitations, integrations, public shares, audit log |
| `member` | Invited or stored role | Read org-scoped resources; record scan decisions; decide workflow gates |

| Helper | Rule |
| --- | --- |
| `roleCanManageMembers` | `owner` or `admin`; members, invitations, audit log |
| `roleCanManageIntegrations` | `owner` or `admin`; npm connection, GitHub App, release targets, publisher setup, Slack, notification recipients, stopping publication watches |
| `roleCanManagePublicShares` | `owner` or `admin`; public share links (a governance action, not a review action) |
| `isInvitableRole` | Only `admin` or `member`; ownership is never granted by invite |
| `normalizeRole` | Unknown stored value → `member` |
| `getOrganizationRole` (`server/db/invitations.ts`) | `owner` when the user is `ownerUserId`, else stored role, else `null` for non-members |

### Guards

| Guard | Use | On failure |
| --- | --- | --- |
| `requireActiveOrganization` | Reads open to any member | Non-member selector falls back to the caller's personal org |
| `requireActiveOrganizationContext` | Returns `{ organizationId, role }` | With `x-organization-strict: 1`: `403 { error: "forbidden", code: "not_organization_member" }` |
| `requireOrganizationRole(c, db, roleCan…)` | Sensitive mutations | `403 { error: "forbidden" }` |
| `isOrganizationOwner` | Rename, delete, release two-factor policy | `404` (`not found`) |

### Route matrix

| Route | Member | Admin | Owner | Notes |
| --- | --- | --- | --- | --- |
| `GET /api/v1/organizations/members` | yes | yes | yes |  |
| `DELETE /api/v1/organizations/members/:userId` | 403 | yes | yes | Removing the owner → `400`; unknown → `404` |
| `GET /api/v1/organizations/invitations` | 403 | yes | yes | Pending invitations only |
| `POST /api/v1/organizations/invitations` | 403 | yes | yes | Verified email; 30/hour per org |
| `DELETE /api/v1/organizations/invitations/:invitationId` | 403 | yes | yes | Unknown → `404` |
| `POST /api/v1/organizations/invitations/accept` | invitee | invitee | invitee | Not scoped by `x-organization-id`; see below |
| npm connection `POST /`, `POST /validate`, `DELETE` | 403 | yes | yes | `server/routes/npm-connection.ts` |
| GitHub App install, release targets, publisher setup | 403 | yes | yes | `server/routes/github-app/` |
| Slack connect, channel, pause/resume, disconnect, test | 403 | yes | yes | Status `GET` open to members; one workspace and one public channel per org ([Slack](./slack-notifications.md)) |
| Notification recipients add/remove | 403 | yes | yes | List open to members; add needs a verified email; at most 5 (`MAX_NOTIFICATION_RECIPIENTS`); delivery rules in [Slack](./slack-notifications.md) |
| `POST /api/v1/scans/:id/share` | 403 | yes | yes | `roleCanManagePublicShares` |
| `GET /api/v1/audit-events` | 403 | yes | yes | [Audit log](./audit-log.md) |
| Scan decisions, workflow gate decisions | yes | yes | yes | Open to any member by design |
| `PATCH /api/v1/organizations/:id` (rename) | 404 | 404 | yes |  |
| `PUT /api/v1/organizations/:id/release-two-factor` | 404 | 404 | yes | [Two-factor](./two-factor-auth.md#organization-policy) |
| `DELETE /api/v1/organizations/:id` | 404 | 404 | yes | See below |

### Organization deletion

`DELETE /api/v1/organizations/:id`: owner-only, rate-limited 10/hour per user, personal workspace → `400`. `deleteOrganization` (`server/db/organizations.ts`) removes every org-scoped row explicitly in one batch: publisher setup jobs, scan events, scans, workflow gates, release targets, GitHub installations, npm connection, notification recipients, Slack connection, invitations, members, the org row; then its R2 artifacts. npm package claims become ownerless reservations. No audit event is recorded because the org's `scan_events` go in the same batch.

### Invitations

Schema `organization_invitations` (`server/db/schema.ts`). One live invite per `(organization_id, email)`: re-inviting rotates the token and extends expiry on the pending row (`upsertInvitation`). Status `pending` → `accepted` | `revoked`. Invites expire after 7 days (`INVITE_TTL_MS` in `server/routes/organization-members.ts`).

1. **Create** (`POST /invitations`, owner/admin): inviter's address must be verified (`403 { code: "email_verification_required" }`, [email verification](./security-model.md#email-verification)) because the invite mails a third party in the org's name; `sanitizeAddress` validates the email, `isInvitableRole` the role (default `member`); 30/hour per org; existing member → `409`; then `upsertInvitation` + `notifyOrganizationInvite`. Returns the public invitation, no token.
2. **Email**: names the inviter as `<account email> ("<name>")`, the verified address first and the name quoted and flattened again (see account names below); link to `${BETTER_AUTH_URL}/dashboard/invite?token=…`; records `organization.member_invited` or `organization.member_invite_failed`. Delivery is best-effort and never blocks the invite.
3. **Accept** (`POST /invitations/accept`, authenticated invitee): org comes only from the token (matched by hash). The account email must equal the invited address and `emailVerified` must be true, so a leaked link cannot be redeemed by registering an unverified account with that address. `markInvitationAccepted` is a compare-and-swap, so only one concurrent accept wins. Success adds the member, records `organization.member_joined`, returns `{ organizationId, role }`.

**Account names** (`server/lib/auth/user-name.ts`) reach invitees, so they are one plain line of at most 64 graphemes and 256 UTF-16 code units (subdivision flags kept, other invisible characters dropped): `/sign-up/email` and `/update-user` refuse line breaks, control or bidi characters, and longer names (`400 INVALID_NAME`); `databaseHooks.user` normalize every write, GitHub profiles included. Personal workspace names and `getOrganizationName` (notification copy) are flattened the same way.

| Accept failure | Status |
| --- | --- |
| Missing token | `400` |
| Unknown token | `404` |
| Already used or revoked, or lost the CAS race | `409` |
| Expired | `410` |
| Email does not match the invite, or not verified | `403` |

### Front end

| File | Role |
| --- | --- |
| `src/models/organization-members.ts` (`MembersModel`) | Load, invite, revoke, remove |
| `src/pages/Dashboard/Settings/OrganizationMembersSection.tsx` | Roster, invite form, pending invites; management controls render only for owner/admin |
| `src/pages/Dashboard/Invite/index.tsx` (`/dashboard/invite`) | Reads `?token`; unauthenticated → `/login?returnTo=…` (login/register forward `returnTo`); POSTs the token, activates the joined org, routes to the dashboard |

### Audit events

All via `recordScanEvent` into `scan_events`: `organization.member_invited`, `organization.member_invite_failed`, `organization.member_invitation_revoked`, `organization.member_joined`, `organization.member_removed`.

## Invariants

1. Invitation links carry a 32-byte bearer token (`TOKEN_BYTES`); only its SHA-256 (`token_hash`) is persisted, so a database read never yields a usable link and revocation is one row update.
2. The raw token exists only in the invite email and the accept request; `publicInvitation` omits it from every API response.
3. Org deletion and member cleanup delete children explicitly, not via `ON DELETE CASCADE`, because D1 does not enforce foreign keys by default; a silent orphan would leak one org's scans or credentials past deletion.
4. Membership and role are read from D1 on every request, so removal takes effect immediately even with a cached session cookie.

## Tests

`test/workers/organization-members-routes.test.ts` covers invite creation, token never leaked, role enforcement (member `403`, admin allowed), accept → membership, leaked-link rejection, unverified-email rejection, expiry, revoke-then-accept, owner-removal guard, and roster ordering.

## Change checklist

- New org-scoped mutation → pick a `roleCan…` helper, use `requireOrganizationRole`, add a row to the route matrix, cover member `403` in a Worker test.
- New org-scoped table → add it to `deleteOrganization` and [account deletion](./account-deletion.md).
