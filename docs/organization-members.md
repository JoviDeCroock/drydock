# Organization members & invitations

Drydock organizations are multi-user. This document describes the membership
model, the role-based access guards, and the email-token invitation flow.

## Roles

`server/lib/roles.ts` is the single source of truth:

- `owner` — the `organizations.ownerUserId`. Exactly one per org. Cannot be
  removed or demoted through the API. Created implicitly when an org is created
  (`createOrganization` / `ensurePersonalOrganization` insert the owner's
  `organization_members` row with role `owner`).
- `admin` — full management of members, invitations, npm connections, and GitHub
  release targets.
- `member` — read access to org-scoped resources; can act on releases (record
  scan decisions, decide workflow gates). Cannot manage membership or
  integrations.

Helpers:

- `roleCanManageMembers(role)` — `owner` or `admin`. Gates invite/revoke/remove.
- `roleCanManageIntegrations(role)` — `owner` or `admin`. Gates npm-connection
  mutations and GitHub App install / release-target CRUD.
- `isInvitableRole(value)` — only `admin` or `member` may be invited; you cannot
  invite a second `owner`.
- `normalizeRole(value)` — coerces an unknown/stored string to a valid role,
  defaulting to `member`.

`getOrganizationRole(db, orgId, userId)` returns the effective role: `owner` when
the user is the org's `ownerUserId`, otherwise the stored membership role, or
`null` when the user is not a member.

## Where roles are enforced

Reads (`GET`) stay open to any member and use `requireActiveOrganization`.
Sensitive mutations resolve the caller's role with
`requireActiveOrganizationContext(c, db)` (returns `{ organizationId, role }`)
and return `403 { error: "forbidden" }` when the guard fails:

- member management — `server/routes/organization-members.ts`
- npm connections — `server/routes/npm-connection.ts` (POST, POST `/validate`,
  DELETE)
- GitHub App install + release targets — `server/routes/github-app.ts`
- notification recipients — `server/routes/organizations.ts` lets any member
  list recipients for an org path they belong to, while owner/admin are required
  for add/remove. Each organization can configure up to five recipient emails.

Org rename and delete stay owner-only (`isOrganizationOwner`). Gate approvals and
scan decisions stay open to any member by design.

Deleting an org (`DELETE /api/v1/organizations/:id`, owner-only, rate-limited at
10/hour) rejects the personal workspace (`400`) and otherwise removes every
org-scoped row explicitly in dependency order — members, invitations,
notification recipients, npm and GitHub connections/release targets/workflow
gates, and the org's scans plus their files, findings, and events — via a single
`deleteOrganization` batch. The deletes are explicit (not `ON DELETE CASCADE`)
because D1 does not enforce foreign keys by default, so a silent orphan would
otherwise leak one org's scans/credentials past its deletion. No audit event is
recorded: the org's `scan_events` are removed in the same batch.

## Invitation flow

Schema: `organization_invitations` (`server/db/schema.ts`). One **live** invite
per `(organization_id, email)`: re-inviting an address rotates the token and
extends the expiry on the existing pending row (`upsertInvitation`) instead of
stacking rows. Status is `pending` → `accepted` | `revoked`. Invites expire after
7 days (`INVITE_TTL_MS`).

### Token handling

Invitation links carry a 32-byte high-entropy bearer token. Only its SHA-256
hash (`token_hash`) is persisted — mirroring the password-reset pattern — so a
database read never yields a usable link and revocation is a single row update.
The raw token exists only in the invite email and the accept request; it is
**never** returned by any API response (`publicInvitation` omits it). See
`server/lib/invitation-token.ts`.

### Create → email → accept

1. **Create** (`POST /invitations`, owner/admin): validates the email
   (`sanitizeAddress`) and role (`isInvitableRole`, default `member`),
   rate-limits at 30/hour per org, rejects an address that is already a member
   (409), then `upsertInvitation` + `notifyOrganizationInvite`. Returns the
   public invitation (no token).
2. **Email**: `notifyOrganizationInvite` sends a link to
   `${BETTER_AUTH_URL}/dashboard/invite?token=…` and records an
   `organization.member_invited` (or `…_invite_failed`) audit event. Email
   delivery is best-effort and never blocks the invite.
3. **Accept** (`POST /invitations/accept`, authenticated invitee): this route is
   deliberately **not** scoped by the `x-organization-id` header — an invitee is
   not a member yet, so the org is determined solely by the token (matched by
   hash). The caller's account email must equal the invited address **and** the
   account's `emailVerified` flag must be true, so a leaked link cannot be
   redeemed by registering an unverified account with the invitee's address. The
   transition out of `pending` is a compare-and-swap (`markInvitationAccepted`),
   so concurrent accepts race and only one wins. On success it adds the member, records
   `organization.member_joined`, and returns `{ organizationId, role }`.

Accept failure codes: `404` unknown token, `409` already used/revoked (or lost
the CAS race), `410` expired, `403` the caller's email does not match the invite
or has not been verified.

### Front end

- `src/models/organization-members.ts` (`MembersModel`) — load/invite/revoke/
  remove, used by the settings page.
- `src/pages/Dashboard/Settings/OrganizationMembersSection.tsx` — member roster,
  invite form, and pending-invite list. The invite form and management controls
  only render for owners/admins.
- `src/pages/Dashboard/Invite/index.tsx` (`/dashboard/invite`) — reads `?token`,
  redirects unauthenticated visitors to `/login?returnTo=…` (the login and
  register pages forward `returnTo` so a brand-new invitee can create an account
  and land back on the invite), then POSTs the token, sets the joined org active,
  and routes to the dashboard.

## Audit events

All recorded via `recordScanEvent` into `scan_events`:

- `organization.member_invited` / `organization.member_invite_failed`
- `organization.member_invitation_revoked`
- `organization.member_joined`
- `organization.member_removed`

## Tests

`test/workers/organization-members-routes.test.ts` covers invite creation,
token-never-leaked, role enforcement (member 403, admin allowed), accept →
membership, leaked-link rejection, unverified-email rejection, expiry,
revoke-then-accept, owner-removal guard, and roster ordering.
