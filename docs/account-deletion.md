# Account deletion

A signed-in user can permanently delete their own account from **Account settings**
(`/dashboard/account` → Danger zone). It is built on Better Auth's first-party
[`deleteUser`](https://www.better-auth.com/docs/concepts/users-accounts#delete-user) feature,
enabled in `server/lib/auth/index.ts`:

```ts
user: {
  deleteUser: {
    enabled: true,
    beforeDelete: async (deletedUser) => { /* tear down Drydock-owned data */ },
  },
}
```

## Reauth

Deletion is irreversible, so it is reauthenticated according to the account's
sign-in method. A credential account posts `{ password }` to
`POST /api/auth/delete-user`; Better Auth verifies it before running
`beforeDelete`, and a wrong password returns `400 INVALID_PASSWORD` with nothing
touched. A GitHub-only account has no password, so the client posts `{}` and
Better Auth requires the OAuth-created session to still be fresh. If it has aged
out, the user signs out, signs back in with GitHub, and retries.

The UI (`src/pages/Dashboard/Account/DeleteAccountSection.tsx`) always requires
the user to type their own email, so the action cannot fire from a stray click.
It asks for a password only when `GET /api/auth/list-accounts` reports a
`credential` row.

## What gets deleted

Better Auth removes the `user`, `session`, and `account` rows itself **after** `beforeDelete`
returns. Everything else is Drydock-owned, and because **D1 does not enforce foreign keys** none
of it cascades on its own (the same reason `deleteOrganization` deletes children by hand). So
`deleteUserAccount(db, userId)` in `server/db/organizations.ts` does, in order:

1. **Owned organizations** — deletes every org the user owns outright via `deleteOrganization`:
   the personal workspace (always sole-owned), plus any non-personal org where they are the only
   member. That clears the org's scans, findings, npm connection, GitHub install/targets/gates,
   Slack connection, invitations, notification recipients, and membership rows.
2. **Remaining memberships + live approvals** — in organizations owned by _other_ people,
   membership deletion, pending `scan_approvals` cleanup, and pending-gate projection repair commit
   in one D1 batch. An in-flight approval therefore lands either before the batch and is removed by
   it, or after the batch and fails the vote insert's membership proof. Approvals on already decided
   releases remain as historical rows for the next step.
3. **References + 2FA** — the departing user may have created, decided on, or publicly shared rows
   (`scans.owner_user_id` /
   `decided_by_user_id` / `public_shared_by_user_id`,
   `scan_events.actor_user_id`, `npm_connections.created_by_user_id`, the GitHub/Slack/notification
   `created_by_user_id` columns, and `organization_invitations.invited_by_user_id` /
   `accepted_by_user_id`). These are all `ON DELETE SET NULL`, so we null them by hand — otherwise a
   join to the now-deleted user would dangle. Historical approvals are nulled too, preserving the
   count while removing identity, and the user's `two_factor` secret is deleted. See
   [`release-approvals.md`](./release-approvals.md).

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
  and asserts against D1: password and GitHub-only deletion (user + personal workspace +
  sessions/accounts gone), the shared-org block (account and org untouched, error names the org),
  membership removal + reference nulling in an org owned by someone else, and wrong-password
  rejection.
