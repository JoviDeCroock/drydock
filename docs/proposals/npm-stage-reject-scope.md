# RFC draft: deny-only stage review permissions for npm

> **Status: draft, not filed.** This is a proposal written for the npm RFC
> audience (npm/rfcs, npm/cli). It has not been submitted to npm, and nothing
> in Drydock depends on it. The "Verification status" section at the end lists
> which facts were checked against what, and which were not.

## Summary

Let a package's maintainers grant a third-party reviewer a permission that can
only stop a staged release, never ship one. The permission, `stage:hold`, puts
a hold on a staged version that blocks `npm stage approve` until a maintainer
lifts it with 2FA. A hold needs no OTP and works from a granular access token
or a trusted-publishing (OIDC) identity. An optional companion, `stage:reject`,
discards a stage outright. A signed `stage.created` webhook lets reviewers
start work when a stage appears, without polling.

The case for doing this rests on one asymmetry. If an approve credential leaks,
the attacker ships malware to everyone who installs the package. If a hold
credential leaks, the worst outcome is that a release is late, and the
maintainer can lift the hold, revoke the grant, and approve. A credential with
that bounded failure mode can safely sit in a third party's systems. An approve
credential cannot.

## Motivation

### Staged publishing created a review window that only npm can act in

`npm stage publish` holds a tarball privately until a maintainer approves it
with 2FA. Since the September 2026 trusted-publishing update, every
trusted-publishing configuration can stage, and direct `npm publish` is a
per-configuration opt-in. npm documents up to 10 trusted publishers per
package and disables the approve button until npm's malware scan has finished.
For packages that follow npm's best-practice guidance (stage-only trusted
publishers, tokens disallowed from publishing), every release now waits in a
private queue before anyone can install it.

That queue is the only point where someone other than the maintainer can look
at the exact bytes that will ship, before anyone installs them. Today, though,
only one party other than the maintainer can act on what it sees there: npm's
own scanner, which can keep the approve button disabled. Everyone else can read
the stage (`npm stage list`, `view`, `download` work without 2FA) and can tell
the maintainer what they found, but cannot stop the approval.

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
CI, a second maintainer's tooling) can read every stage, but they have no way
to make their verdict binding.

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

| If this leaks or turns hostile                        | Worst case                                                                | Recovery                                                                                         |
| ----------------------------------------------------- | ------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| An approve-capable credential (what #196948 asks for) | Attacker stages and approves malware; it installs everywhere              | None before install; unpublish and incident response after                                       |
| `stage:hold`                                          | Every stage in the granted packages is held                               | Maintainer lifts holds with 2FA, revokes the grant; release is late by the time to notice        |
| `stage:reject`                                        | Every stage in the granted packages is discarded                          | Maintainer restages the same version (the version slot is freed on reject) and revokes the grant |
| Stage read access (exists today)                      | Unreleased staged bytes are disclosed, including embargoed security fixes | None; this risk exists today with read-only tokens and is not added by this RFC                  |
| Webhook signing secret                                | Forged "stage created" events cause wasted reviewer work                  | Rotate the secret; reviewers verify every event against `GET /-/stage`                           |

The proposal holds only if a deny-only permission cannot be combined with or
escalated into the ability to publish. The rules below exist to keep that
true.

### Permissions

Two new permissions, grantable on a granular access token or on a trust
relationship:

- **`stage:hold`**: place a hold on a staged version. Reversible.
- **`stage:reject`** (optional, separately granted): discard a staged version,
  with the same effect as `npm stage reject` today, except that the registry
  keeps the rejected tarball privately for maintainers for a retention period
  (see below).

Rules:

1. **Deny-only tokens are deny-only.** A granular token that carries
   `stage:hold` or `stage:reject` may also carry read access to stages (list,
   view, download) and nothing else. It cannot carry write, publish, dist-tag,
   owner, or access permissions. This is what makes the token safe to hand to
   someone else: it cannot be the same token that also publishes.
2. **No OTP.** Placing a hold or a reject does not prompt for 2FA. A reviewer
   is a service; requiring proof-of-presence would make the permission
   unusable, and proof-of-presence protects against shipping, which these
   permissions cannot do.
3. **Scoped per package or per scope.** Granted on named packages, or on all
   packages in a scope by an org owner. Packages the grantor does not maintain
   cannot be included.
4. **Only maintainers create grants, with 2FA.** Creating, widening, or
   revoking a grant is a 2FA action by a maintainer (or org owner, for scope
   grants). The reviewer never mints its own.
5. **OIDC form.** A trust relationship may carry a `holdStagedPackage` (and
   optionally `rejectStagedPackage`) permission alongside or instead of
   `createStagedPackage`. This covers a review job in the maintainer's own CI:
   a workflow that downloads the stage, checks it, and holds it on failure.
   This is a carve-out from today's rule that trust-relationship tokens cannot
   run `npm stage` subcommands; approve stays blocked for OIDC.

### Hold semantics

- A hold is attached to one stage by one grant. A grant can hold a given stage
  once; repeating the call is idempotent.
- While any hold is active, `npm stage approve` fails with a distinct error
  that names the holder, so CLIs and bulk-approval UIs can explain why.
- **Only a maintainer with 2FA can lift a hold.** The reviewer cannot withdraw
  its own hold. A withdraw capability would let a stolen reviewer token clear
  the legitimate reviewer's hold on a malicious stage, which turns a deny-only
  permission into an enabling one. A reviewer that changes its mind tells the
  maintainer through its own channel.
- Lifting and approving can be one action ("approve over hold"), still behind
  2FA and an explicit confirmation that names each active hold.
- Holds do not expire on their own. An expiring hold on a stage that really is
  malicious would quietly turn back into an approvable stage.
- A hold carries a reason code from a small fixed set (for example
  `malicious`, `suspicious`, `policy`, `needs-review`) and an optional HTTPS
  link to the reviewer's report. There is no free-text field; see abuse
  cases.

### Reject semantics

`stage:reject` exists because some reviewers and organizations want a
confirmed-malicious stage gone, not parked. It behaves like today's reject
with two differences:

- The registry keeps the rejected tarball privately, visible only to
  maintainers, for a retention period (for example 30 days), so a reject by a
  third party cannot destroy the evidence a maintainer needs to investigate.
- The version slot is freed as it is today, so the maintainer can restage.

Because reject is destructive and a hold already blocks the release,
`stage:hold` should be the default grant and `stage:reject` an explicit
opt-in. If npm prefers to ship only one permission, ship `stage:hold`.

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
- Payload is minimal: stage id, package name, version, dist-tag, tarball
  integrity, actor type (user, automation, trusted automation), created time.
  No tarball, no token.
- Signed with a per-hook secret (HMAC over the body plus a timestamp, to bound
  replay). Reviewers must still fetch the stage with their own read access and
  treat the event as a hint, never as the content.
- At-least-once delivery with retries. Optional follow-up events
  (`stage.approved`, `stage.rejected`, `stage.hold.placed`,
  `stage.hold.lifted`) let reviewers close their own records.

The webhook is useful on its own, but without the hold it only shortens the
time to an email the maintainer may not read before approving.

### Visibility on npmjs.com

- The staged-versions view shows each active hold with the grant's name as the
  maintainer set it, the reviewer's npm account, the reason code, and the
  report link. It is styled as a third-party hold and is visually distinct
  from npm's own scan status, so a hold cannot pass for npm's verdict.
- Every maintainer of the package is notified when a hold is placed and when
  one is lifted. Lifting a hold notifies all maintainers, not only the one who
  lifted it, so a single compromised maintainer account approving over a hold
  is visible to the others.
- Whether "approved over a reviewer hold" should ever be public on the
  published version is an open question (below).

### Audit trail

Every grant change, hold, lift, reject, and approve-over-hold is recorded with
actor, actor type, grant id, stage id, reason code, and time, and is visible
to maintainers in the package's version history, alongside the
staged/approved/rejected history npm already shows. Org owners can export it.

### Rate limits

- Per-grant limits on holds and rejects per hour, with a ceiling well above
  any honest release cadence (a monorepo staging 100 packages at once is
  normal).
- Exceeding the limit fails the call and notifies maintainers; it does not
  suspend the grant automatically, since a reviewer reacting to a mass
  compromise legitimately holds many stages at once.

### Abuse cases

- **A reviewer holds releases forever, or for leverage.** Maintainers lift
  holds with 2FA at any time, can lift every hold from one grant in a single
  action, and can revoke the grant. The reviewer gains delay, not control.
- **A stolen hold token is used for denial of release.** Same recovery. The
  real cost is delay, which matters most for a security fix shipping during
  active exploitation; "approve over hold" keeps that delay to one 2FA prompt
  once the maintainer notices.
- **A hold used as a phishing lure.** A hostile holder could try a message
  like "npm found malware, restage from this branch". There is no free text,
  holds are labelled as third-party, and the report link is shown as a link
  to the reviewer's site, not as npm content.
- **Approval racing the reviewer.** A maintainer can approve before the
  reviewer has finished. npm's scan already closes part of this window. A
  maintainer-configured minimum stage age (see unresolved questions) would
  close the rest without giving reviewers any power to unblock.
- **Reviewer outage reads as "clean".** The absence of a hold is not a
  verdict. Tools that show reviewer status should say "no hold" rather than
  "passed". This RFC does not add a positive signal, on purpose.
- **Escalation through combination.** Rule 1 prevents a deny-only grant from
  sharing a token with publish rights. A reviewer that also holds publish
  rights from the maintainer is a separate decision the maintainer made, and
  it is not made safer or less safe by this RFC.
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
staged publishing docs ask maintainers to delete. A reviewer that wants to
approve should do it by asking the maintainer to approve.

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
every release. Holds give most of the value with none of that risk. A minimum
stage age is a gentler way to reach the same goal.

### Do nothing; put the review before the stage

A maintainer can already run review in a protected CI environment before
`npm stage publish`, so the stage only receives reviewed bytes. That works and
is a good pattern, but it covers only that CI path. It does not cover stages
from other trusted publishers, from humans running `npm stage publish`, or
from a compromised workflow that skips the review job. A hold on the stage
itself covers every way a stage can arrive.

## Implementation

Sketch only; npm owns the real design.

- Granular token permissions `stage:hold` / `stage:reject`, plus trust
  permissions `holdStagedPackage` / `rejectStagedPackage`.
- `POST /-/stage/{id}/hold` with `{ reason, reportUrl? }`, and
  `GET /-/stage/{id}/holds`. `DELETE /-/stage/{id}/hold/{holdId}` requires a
  maintainer and 2FA.
- `POST /-/stage/{id}/approve` fails while holds are active unless the request
  explicitly overrides them, with 2FA.
- CLI: `npm stage hold <stage-id> --reason <code>`,
  `npm stage holds <stage-id>`,
  `npm stage release-hold <stage-id> <hold-id>`, and an `--override-holds`
  flag on `npm stage approve`.
- Webhook configuration through the npmjs.com package settings and an API.

## Prior art

- **GitHub required status checks**: third-party apps report a failing check
  that blocks merge; repository admins can bypass.
- **GitHub deployment protection rules**: a third-party app can reject a
  deployment to a protected environment. These also allow the app to approve,
  which is the part this RFC deliberately leaves out.
- **npm's own scan**: already holds stages from approval. This RFC opens the
  same deny-only hold to reviewers the maintainer chooses.
- **npm registry hooks**: npm previously offered registry webhooks (the
  `npm hook` command, no longer in the current CLI).

## Unresolved questions

- Should "approved over a reviewer hold" be visible on the public version
  page? It is a useful signal to consumers, and also a way for a hostile
  reviewer to stigmatize a release.
- Retention period for rejected tarballs, and whether npm wants to keep them
  at all.
- Should maintainers be able to set a minimum stage age (approval blocked for
  N minutes after staging, regardless of holds) so reviewers have time to
  act?
- Should a hold be able to target every stage of a version range or a whole
  package for a period (for example during an active compromise), or only one
  stage at a time?
- How should holds appear in bulk-approval UIs, which are where maintainers
  most often approve without reading?

## Example consumer

Drydock, which reviews npm stages and posts findings to maintainers, would use
`stage:hold` to make a high-risk finding block approval rather than only
notify. Any reviewer reading stages today, including a maintainer's own CI job,
would use it the same way. The permission is useful only if it is generic.

## Verification status

Checked on 2026-10-18:

- **npm CLI 11.15.0 source and bundled docs** (`npm stage` command docs and
  its approve/reject implementations): approve and reject both require 2FA;
  list, view, and download do not; reject permanently deletes the stage record
  and tarball; rejecting and restaging the same version is the documented way
  to change a stage's tag; trust-relationship tokens cannot run `npm stage`
  subcommands. The CLI sends the request and retries with an OTP when the
  registry challenges, so enforcement is the registry's; the docs are the
  evidence, not the CLI code.
- **docs.npmjs.com, trusted publishers page**: up to 10 trusted publishers per
  package; `npm stage publish` always allowed; approve and reject cannot use
  OIDC tokens; no mention of stage webhooks.
- **GitHub changelog, 2026-09-03 multiple trusted-publishing
  configurations**: configurations stage by default, direct publish is opt-in,
  and approval is disabled until malware scanning completes. The changelog
  itself does not state the 10-publisher limit (the docs page does).
- **Discussion #196948**: content as described; two replies, an automated bot
  acknowledgment and one community member, no staff reply.
- **The maintainer's ChainDrop postmortem** (jaredwray.com): malicious commits
  pushed with an old full-access token; published through the legitimate
  workflow via trusted publishing with valid provenance; the move to
  stage-only publishing with 2FA approval, described there as in progress.
- **npm CLI trust command**: trust permission names `createPackage` and
  `createStagedPackage`, which the proposed `holdStagedPackage` /
  `rejectStagedPackage` names mirror.

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
