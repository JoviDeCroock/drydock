# RFC draft: deny-only stage review permissions for npm

> **Status: draft, not filed.** This is a proposal written for the npm RFC
> audience (npm/rfcs, npm/cli). It has not been submitted to npm, and nothing
> in Drydock depends on it. If it is filed, the author should disclose that
> they build Drydock, a stage reviewer that would use the permission. The
> "Verification status" section at the end lists which facts were checked
> against what, and which were not.

## Summary

Let a package's maintainers grant a third-party reviewer a permission that can
only stop a staged release, never ship one. The permission, `stage:hold`, puts
a hold on a staged version that blocks `npm stage approve` until a maintainer
lifts it with 2FA. A hold needs no OTP and works from a granular access token
or a dedicated trusted-publishing (OIDC) relationship. An optional companion,
`stage:reject`, marks a stage as rejected so it can never be approved, while
leaving the version slot occupied until a maintainer discards it. A signed
`stage.created` webhook lets reviewers start work when a stage appears, without
polling.

The case for doing this rests on one asymmetry. If an approve credential leaks,
the attacker ships malware to everyone who installs the package. If a hold
credential leaks, the intended worst outcome is that a release is late: the
maintainer lifts the hold, revokes the grant, and approves. Most of this
document is about keeping that worst case true, because several obvious
designs (a reject that frees the version slot, a hold that carries a link in
an npm-sent email, a reviewer that can withdraw holds) quietly break it.

## Motivation

### Staged publishing created a review window that only npm can act in

`npm stage publish` holds a tarball privately until a maintainer approves it
with 2FA. npm's September 2026 trusted-publishing update made staging the
default for trusted-publishing configurations, with direct `npm publish` as a
per-configuration opt-in. npm documents up to 10 trusted publishers per
package and disables the approve button until npm's malware scan has finished.
For packages that follow npm's best-practice guidance (stage-only trusted
publishers, tokens disallowed from publishing), every automated release now
waits in a private queue before anyone can install it.

That queue is the one point before install where someone other than the
maintainer can look at the exact bytes that will ship. Today, though, only one
party other than the maintainer can act on what it sees there: npm's own
scanner, which can keep the approve button disabled. Other reviewers can read
the stage and tell the maintainer what they found, but cannot stop the
approval.

- `POST /-/stage/{id}/approve` and `DELETE /-/stage/{id}`
  (`npm stage approve` / `npm stage reject`) both require 2FA.
- Short-lived tokens from trust relationships "cannot run `npm stage`
  subcommands", so a review job running under OIDC cannot hold or reject
  either.
- There is no event for stage creation. A reviewer has to poll `GET /-/stage`.

### Provenance does not answer "is this safe"

In August 2026 an attacker pushed a malicious lifecycle hook and payload files
to the default branch of a popular caching library family (keyv / cacheable)
using a stale personal access token. The project's legitimate GitHub Actions
workflow then built and published the poisoned tree through trusted publishing.
The resulting versions carried valid provenance, because provenance attests
where and how a package was built, not whether the source was authorized or
safe. The maintainer's published postmortem describes moving, repository by
repository, to stage-only trusted publishing with manual 2FA approval.

Staged publishing helps here only if someone reads the stage before the
approval. Maintainers approving many packages, often in bulk, are the weakest
reader of their own diffs. Independent reviewers (security vendors, an
organization's internal security team, a review job in the maintainer's own
CI, a co-maintainer's tooling) can read every stage, but their verdict is only
advice.

### People have asked for this

GitHub community discussion
[#196948](https://github.com/orgs/community/discussions/196948) ("staged
approval customization / api", May 2026) asks for package- or scope-scoped
credentials for staged publishing, stage webhooks, and policy over who may
approve. As of this draft it has no staff reply. That request centres on an
approve-capable credential. This RFC deliberately asks for the narrower,
deny-only half, which can be granted without weakening proof-of-presence.

## Detailed explanation

### Threat model

| If this leaks or turns hostile                        | Worst case                                                                                                 | Recovery                                                                                    |
| ----------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| An approve-capable credential (what #196948 asks for) | Attacker stages and approves malware; it installs everywhere                                               | None before install; unpublish and incident response after                                  |
| `stage:hold`                                          | Every stage in the granted packages is held                                                                | Maintainer lifts holds with 2FA and revokes the grant; the release is late                  |
| `stage:reject`                                        | Every stage in the granted packages is marked rejected                                                     | Maintainer discards the rejected stages with 2FA, restages, and revokes the grant           |
| Stage read access                                     | Unreleased staged bytes are disclosed, including embargoed security fixes                                  | None; see "Stage read" below for whether this RFC adds the risk                             |
| `stage.created` webhook endpoint or secret            | Private package names, unreleased version numbers, and dist-tags leak; forged events waste reviewer effort | Rotate the secret or remove the hook; use the id-only payload; reviewers verify every event |

The asymmetry only holds if a deny-only permission cannot be combined with, or
turned into, the ability to get chosen bytes approved. The rules below exist
to keep that true. Holds bind the staged path only. A maintainer, or a trusted
publisher opted into direct publish, can still run `npm publish` while stages
are pending, and holds do not stop that. This RFC narrows the staged path; it
does not close the others.

### Reviewer identity and grants

1. **A reviewer is its own npm account.** A maintainer (or, for a scope grant,
   an org owner) creates a review grant naming a reviewer account, with 2FA.
   The reviewer account accepts it. A reviewer is never a maintainer: it does
   not appear in `maintainers`, cannot receive ownership, and gets no package
   rights beyond the grant.
2. **Grants are deny-only.** A grant carries `stage:hold`, optionally
   `stage:reject`, and stage read (list, view, download) for the granted
   packages. Tokens the reviewer account mints under the grant carry those
   permissions and nothing else: no write, publish, stage-publish, dist-tag,
   owner, or access rights for those packages.
3. **No OTP.** Placing a hold or a reject does not prompt for 2FA. A reviewer
   is usually a service. Proof-of-presence protects against shipping, which
   these permissions cannot do.
4. **Scope.** A package grant covers named packages. A scope grant by an org
   owner covers every package the org owns in that scope, including future
   ones, and every maintainer of each covered package is notified when it is
   created.
5. **Display name is the maintainer's.** The grant carries a display name and a
   report-link origin (for example `https://reviewer.example`), both set by the
   grantor at creation. npm shows the grant's display name, not a name the
   reviewer chooses.
6. **OIDC form, on a dedicated relationship.** A trust relationship may carry
   `holdStagedPackage` (and optionally `rejectStagedPackage`) plus stage read,
   so a review job in the maintainer's own CI can download a stage, check it,
   and hold it. Such a relationship cannot also carry `createPackage` or
   `createStagedPackage`, and should point at a different workflow file or
   environment from the publishing one. This is a carve-out from today's rule
   that trust-relationship tokens cannot run `npm stage` subcommands; approve,
   lift, and discard stay blocked for OIDC. The limit is the same as for any
   in-repository review: a compromised repository can skip the review job, so
   the OIDC form helps against a bad release, not against a hostile workflow.

### Hold semantics

- A hold is attached to one stage by one grant. Repeating the call is
  idempotent. Once a maintainer lifts that grant's hold on a stage, the grant
  cannot hold the same stage again, so a stolen token cannot re-hold the
  moment a maintainer lifts.
- Holds and approval are serialized by the registry. A hold placed after
  approval fails with a distinct `already-published` error, so the reviewer
  knows it lost the race.
- While any hold is active, `npm stage approve` fails with a distinct error
  that names the grant, so CLIs and bulk-approval UIs can explain why.
- **Only a maintainer with 2FA can lift a hold.** The reviewer cannot withdraw
  its own hold. A withdraw capability would let a stolen reviewer token clear
  the legitimate reviewer's hold on a malicious stage, which turns a deny-only
  permission into an enabling one. A reviewer that changes its mind tells the
  maintainer through its own channel.
- Lifting and approving can be one atomic action ("approve over hold"), behind
  2FA and a confirmation that names each active hold. It applies to one stage
  at a time. **Bulk approval never overrides holds**: held stages are left out
  of a bulk approval and listed separately.
- Holds do not expire, and they survive revocation of the grant that placed
  them. An expiring or revocation-cleared hold on a stage that really is
  malicious would quietly turn back into an approvable stage. Maintainers can
  lift every hold from one grant in a single 2FA action.
- A hold carries a reason code from a small fixed set (for example
  `malicious`, `suspicious`, `policy`, `needs-review`) and an optional report
  URL, which must be on the grant's report-link origin. There is no free-text
  field.

### Reject semantics

`stage:reject` exists because some reviewers and organizations want a
confirmed-malicious stage visibly marked as such, not just parked. A
reviewer's reject is a terminal hold:

- The stage can never be approved, even over a hold. It stays visible to
  maintainers with its bytes intact, which preserves the evidence.
- The version slot stays occupied. A reviewer's reject never frees the
  version. If it did, an attacker holding both reject and any staging path (a
  leaked reject token plus a compromised workflow, for example) could reject
  the clean, reviewed `1.2.3` stage and restage a malicious `1.2.3` with the
  same version and tag, which a maintainer would then approve as "the same
  release". Keeping the slot occupied removes that substitution.
- A maintainer discards the rejected stage with 2FA, which frees the slot as
  today's `npm stage reject` does, and can then restage.
- npm may keep discarded stages privately for a retention period for its own
  security team. Retained bytes are never restorable or approvable.

Because a hold already blocks the release, `stage:hold` should be the default
grant and `stage:reject` an explicit opt-in. If npm prefers to ship only one
permission, ship `stage:hold`.

### Stage read

A reviewer has to read the stage to review it. In practice a reviewer can do
this today with a read-only granular token (one existing reviewer's production
use; see verification status), but npm's CLI docs list write permission on the
package as a prerequisite for `npm stage` commands. If read-only stage access
is not something npm intends to support, the grant's stage read is new
exposure this RFC adds: a leaked reviewer token would disclose unreleased
bytes, including embargoed security fixes. Maintainers holding embargoed
releases should be able to exclude a package from a scope grant, or pause a
grant, for the duration of the embargo.

### Minimum stage age (optional)

Without a delay, a maintainer who approves seconds after staging makes any
hold moot. A maintainer-configured minimum stage age (approval blocked for N
minutes after a stage is created, regardless of holds) gives reviewers time to
act. It is a timeout, not a reviewer signal: reviewers gain no way to end it
early, because an "I'm done" signal is an enabling capability. npm's scan
already enforces a similar wait. Holds are only guaranteed to be seen before
approval when a minimum age is set and reviewers finish within it.

### Interaction with npm's own scan

- npm's scan and reviewer holds are independent. Approval needs the scan to
  have completed without a block **and** no active holds.
- A reviewer hold cannot lift, shorten, or override npm's scan state. A
  maintainer lifting reviewer holds does not affect npm's state either.
- A stage npm has blocked stays blocked regardless of holds.
- The version status endpoint
  (`GET /-/package/{name}/version/{version}/status`) could report `held` as a
  distinct non-terminal state, so tools that already read `staged` /
  `validating` / `blocked` can tell "waiting on a reviewer" from "waiting on
  npm".

### Webhook: `stage.created`

- Configured per package or per scope by a maintainer or org owner, with 2FA.
  The endpoint must be HTTPS.
- Two payload modes. The id-only mode carries just the stage id and a
  timestamp, and the reviewer fetches everything else through its
  authenticated read. The full mode adds package name, version, dist-tag,
  tarball integrity, actor type (user, automation, trusted automation), and
  created time, and is opt-in because names and versions of unreleased
  packages are themselves sensitive.
- Signed with a per-hook secret (HMAC over the body plus a timestamp, to bound
  replay). Reviewers treat every event as a hint and confirm it against
  `GET /-/stage`.
- At-least-once delivery with retries. Optional follow-up events
  (`stage.approved`, `stage.rejected`, `stage.hold.placed`,
  `stage.hold.lifted`) let reviewers close their own records.

The webhook is useful on its own, but without the hold it only shortens the
time to an email the maintainer may not read before approving.

### Visibility on npmjs.com and notifications

- The staged-versions view shows each active hold with the grant's display
  name, the reason code, and the report link. It is styled as a third-party
  hold and is visually distinct from npm's own scan status, so a hold cannot
  pass for npm's verdict.
- Notifications are where a hold could become a phishing channel: a leaked
  token placing `malicious` holds would make npm itself send every maintainer
  an alarming message. So notification emails say only that a third-party
  hold was placed, name the grant, and point to the package's page on
  npmjs.com. They carry no reviewer link and no reason code, and are
  rate-limited per grant.
- Lifting a hold notifies every maintainer of the package, not only the one who
  lifted it, so a single compromised maintainer account approving over a hold
  is visible to the others.
- Whether "approved over a reviewer hold" should ever be public on the
  published version is an open question (below).

### Audit trail

Every grant change, hold, lift, reject, discard, and approve-over-hold is
recorded with actor, actor type, grant id, stage id, reason code, and time,
and is visible to maintainers in the package's version history, alongside the
staged/approved/rejected history npm already shows. Org owners can export it.

### Rate limits

- Per-grant limits on holds and rejects per hour, with a ceiling well above
  any honest release cadence (a monorepo staging 100 packages at once is
  normal).
- Exceeding the limit fails the call and sends one throttled notice to
  maintainers. It does not suspend the grant automatically, since a reviewer
  reacting to a mass compromise legitimately holds many stages at once.

### Abuse cases

- **A reviewer holds releases forever, or for leverage.** Maintainers lift
  holds with 2FA at any time, can lift every hold from one grant in a single
  action, and can revoke the grant. The reviewer gains delay, not control.
- **A stolen hold token is used for denial of release.** Same recovery. The
  real cost is delay, which matters most for a security fix shipping during
  active exploitation; "approve over hold" keeps that delay to one 2FA prompt
  per stage once the maintainer notices.
- **Override fatigue.** A noisy or hostile grant can train maintainers to
  approve over holds without reading, which weakens the legitimate holds from
  other reviewers. Per-stage overrides, bulk approval that skips held stages,
  throttled notifications, and quick revocation limit this, but do not remove
  it. A maintainer should revoke a noisy grant rather than override it
  repeatedly.
- **A hold used as a phishing lure.** No free text, a report link fixed to the
  origin the maintainer chose, a display name the maintainer chose, and
  notification emails without links leave a hostile holder very little to
  write with.
- **Substitution through reject.** Covered under reject semantics: a
  reviewer's reject never frees the version slot.
- **Approval racing the reviewer.** Covered by the minimum stage age and by
  serialized holds and approvals.
- **Reviewer outage reads as "clean".** The absence of a hold is not a
  verdict. Tools that show reviewer status should say "no hold" rather than
  "passed". This RFC does not add a positive signal, on purpose.
- **Escalation through combination.** Grants and dedicated trust
  relationships carry no publish or stage-publish rights for the packages
  they cover. A reviewer that the maintainer separately makes a maintainer is
  a different decision, outside this RFC.
- **Compromised maintainer.** An attacker with maintainer 2FA can lift holds
  and approve. This RFC does not claim to stop that; it makes the override
  visible to the other maintainers and to the reviewer.

## Rationale and alternatives

### Webhooks only

Cheapest to build, and worth shipping regardless. On its own it lets reviewers
start sooner, but their finding is still advice. The maintainer is the
bottleneck the review was meant to cover, so advice that arrives after a bulk
approval does nothing.

### Approval delegation (a scoped approve credential)

This is what #196948 mostly asks for, and it is the wrong default. An
approve-capable credential held by a service is a long-lived publish
credential that skips proof-of-presence. That is the bypass-2FA token npm's
staged publishing docs ask maintainers to delete. A reviewer that wants a
release approved should ask the maintainer to approve it.

### Registry-side policy

npm could run declarative policies itself (for example, hold any stage that
adds an install script or a new binary). That is complementary and probably
worth doing, but it makes npm the only reviewer. Independent reviewers bring
detection npm does not have, can be chosen per organization, and can review
against context npm lacks (the organization's own approved history, its source
repository). A hold permission lets that review count without npm having to
host it.

### A required-review gate

npm could block approval until a registered reviewer posts a positive "done".
That is stronger, but the positive signal is an enabling capability: a stolen
"done" credential lowers a barrier. It also makes reviewer uptime part of
every release. Holds plus a minimum stage age get most of the value without
giving reviewers any way to unblock.

### Do nothing; put the review before the stage

A maintainer can already run review in a protected CI environment before
`npm stage publish`, so the stage only receives reviewed bytes. That works and
is a good pattern, but it covers only that CI path. It does not cover stages
from other trusted publishers, from humans running `npm stage publish`, or
from a compromised workflow that skips the review job. A hold on the stage
covers every way a stage can arrive, though not direct `npm publish`.

## Implementation

Sketch only; npm owns the real design.

- Review grants (create, accept, list, pause, revoke) with `stage:hold`,
  `stage:reject`, and stage read; trust permissions `holdStagedPackage` /
  `rejectStagedPackage`.
- `POST /-/stage/{id}/hold` with `{ reason, reportUrl? }` and
  `GET /-/stage/{id}/holds`. `DELETE /-/stage/{id}/hold/{holdId}` requires a
  maintainer and 2FA.
- `POST /-/stage/{id}/approve` fails while holds are active unless the request
  explicitly overrides them, with 2FA, for that one stage.
- CLI: `npm stage hold <stage-id> --reason <code>`,
  `npm stage holds <stage-id>`,
  `npm stage release-hold <stage-id> <hold-id>`, and an `--override-holds`
  flag on `npm stage approve`.
- Webhook configuration through the npmjs.com package settings and an API.

## Prior art

- **GitHub deployment protection rules**: a third-party app can reject a
  deployment to a protected environment. These also allow the app to approve,
  which is the part this RFC deliberately leaves out.
- **GitHub status checks**: a third-party app can report a failing check on a
  pull request. Required checks are also a positive gate (a missing check
  blocks merge), which this RFC does not copy.
- **npm's own scan**: already holds stages from approval. This RFC opens the
  same deny-only hold to reviewers the maintainer chooses.
- **npm registry hooks**: npm previously offered registry webhooks (the
  `npm hook` command, no longer in the current CLI).

## Unresolved questions

- Should "approved over a reviewer hold" be visible on the public version
  page? It is a useful signal to consumers, and also a way for a hostile
  reviewer to stigmatize a release.
- Should minimum stage age be part of the core proposal rather than optional?
- Should a hold be able to target every stage of a package for a period (for
  example during an active compromise), or only one stage at a time?
- Retention period for discarded stages, and whether npm wants to keep them
  at all.
- Is read-only stage access a supported contract, or should stage read be
  added explicitly as part of the grant?

## Example consumer

Drydock, which reviews npm stages and posts findings to maintainers, would use
`stage:hold` to make a high-risk finding block approval rather than only
notify. Any reviewer reading stages today, including a maintainer's own CI job,
would use it the same way. The permission is useful only if it is generic.

## Verification status

Checked on 2026-10-18:

- **npm CLI 11.15.0 source and bundled docs** (`npm stage` and `npm trust`
  command docs, the stage approve/reject implementations, and the trust
  command): approve and reject both require 2FA; list, view, and download do
  not; reject permanently deletes the stage record and tarball; rejecting and
  restaging the same version is the documented way to change a stage's tag;
  trust-relationship tokens cannot run `npm stage` subcommands; trust
  permission names are `createPackage` and `createStagedPackage`; the
  `npm hook` command is absent. The CLI sends the request and retries with an
  OTP when the registry challenges, so enforcement is the registry's; the
  docs are the evidence, not the CLI code. The bundled `npm trust` docs still
  require `--allow-stage-publish` or `--allow-publish` when creating a
  configuration, while npm's website now says staging is always allowed; the
  website is the newer source.
- **docs.npmjs.com, trusted publishers page**: up to 10 trusted publishers per
  package; `npm stage publish` always allowed; approve and reject cannot use
  OIDC tokens; no mention of stage webhooks.
- **GitHub changelog, 2026-09-03 multiple trusted-publishing
  configurations**: configurations stage by default, direct publish is opt-in,
  and approval is disabled until malware scanning completes. The changelog
  itself does not state the 10-publisher limit (the docs page does).
- **Discussion #196948**: content as described; two replies, an automated bot
  acknowledgment and one community member, no staff reply.
- **The maintainer's postmortem of the keyv / cacheable compromise**
  (jaredwray.com): malicious commits pushed with an old full-access token;
  published through the legitimate workflow via trusted publishing with valid
  provenance; the move to stage-only publishing with 2FA approval, described
  there as in progress.
- **Read-only stage access**: Drydock's production reviewer lists and
  downloads stages with read-only granular tokens (recorded in its security
  model). This is one reviewer's observation, not an npm contract, and the
  CLI docs list write permission as a prerequisite.

Not verified:

- That a granular token with "bypass 2FA" still gets an OTP challenge on
  approve and reject. The docs say both require 2FA without a token-type
  exception; this was not tested against the live registry for this draft.
- That there is no stage webhook anywhere in npm's API. Neither the CLI nor
  the docs mention one; absence is inferred.
- That only npm's scan can disable approval. That is what the docs and
  changelog describe; there may be internal mechanisms they do not mention.
- That reject frees the version slot in every case, beyond the documented
  tag-change flow.
- Whether npm stages expire on their own if never approved.
