# Account deletion

A signed-in user can permanently delete their own account from **Account settings**
(`/dashboard/account` → Danger zone). It is built on Better Auth's first-party
[`deleteUser`](https://www.better-auth.com/docs/concepts/users-accounts#delete-user) feature,
enabled in `server/lib/auth.ts`:

```ts
user: {
  deleteUser: {
    enabled: true,
    beforeDelete: async (deletedUser) => { /* tear down Drydock-owned data */ },
  },
}
```

## Reauth

Deletion is irreversible, so it is gated on the account password. The client
(`sessionModel.deleteAccount` in `src/models/auth.ts`) posts `{ password }` to
`POST /api/auth/delete-user`; Better Auth verifies it against the credential account before
running `beforeDelete`. A wrong password returns `400 INVALID_PASSWORD` and nothing is touched.
The UI (`src/pages/Dashboard/Account/DeleteAccountSection.tsx`) additionally requires the user to
type their own email, so the action can't fire from a stray click or an autofilled password.

## What gets deleted

Better Auth removes the `user`, `session`, and `account` rows itself **after** `beforeDelete`
returns. Everything else is Drydock-owned, and because **D1 does not enforce foreign keys** none
of it cascades on its own (the same reason `deleteOrganization` deletes children by hand). So
`deleteUserAccount(db, userId)` in `server/db/organizations.ts` does, in order:

1. **Owned organizations** — deletes every org the user owns outright via `deleteOrganization`:
   the personal workspace (always sole-owned), plus any non-personal org where they are the only
   member. That clears the org's scans, findings, npm connection, GitHub install/targets/gates,
   Slack connection, invitations, notification recipients, and membership rows.
2. **References in surviving orgs** — in organizations owned by _other_ people, the departing user
   may have created or decided on rows (`scans.owner_user_id` / `decided_by_user_id`,
   `scan_events.actor_user_id`, `npm_connections.created_by_user_id`, the GitHub/Slack/notification
   `created_by_user_id` columns, and `organization_invitations.invited_by_user_id` /
   `accepted_by_user_id`). These are all `ON DELETE SET NULL`, so we null them by hand — otherwise a
   join to the now-deleted user would dangle.
3. **Remaining memberships + 2FA** — deletes the user's `organization_members` rows in surviving
   orgs and their `two_factor` secret.

## The co-owned-organization block

If the user still **owns a non-personal organization that has other members**, the deletion is
**refused** rather than executed: silently removing the owner would orphan the org, or — if we
cascaded — destroy other members' scans, npm token, and GitHub gates. `findCoOwnedOrganizations`
detects these before any cleanup runs, and `beforeDelete` throws
`400 { code: "OWNS_SHARED_ORGANIZATIONS" }` naming the blocking orgs. The owner must delete each
shared org (Settings → General → Danger zone) or hand it off first, then retry. The personal
workspace is always sole-owned, so it never blocks.

> Ownership transfer (promoting another member to owner) is not implemented; today the path out of
> a co-owned org is to delete it. If transfer is added later, it slots in ahead of this block.

## On success

The session cookie is cleared server-side; the client drops its local session and redirects to the
landing page (`/`). All of the user's other sessions are revoked as part of the Better Auth delete.

## Tests

- `test/workers/account-deletion.test.ts` — drives the real Better Auth handler via `worker.fetch`
  and asserts against D1: full deletion (user + personal workspace + sessions/accounts gone), the
  shared-org block (account and org untouched, error names the org), membership removal + reference
  nulling in an org owned by someone else, and wrong-password rejection.
