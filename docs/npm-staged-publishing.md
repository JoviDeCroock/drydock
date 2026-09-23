# Stage Watchtower — advisory npm staged review

[npm staged publishing](https://docs.npmjs.com/staged-publishing/) holds a
candidate tarball privately so Drydock can review the exact bytes before anyone
can install them. Drydock's **Stage Watchtower — advisory** discovers that
candidate, records a review, and leaves npm's approve/reject decision entirely
with the maintainer. Drydock neither approves the stage nor blocks a separate
manual publication.

Stage-only trusted publishing can narrow the automated path. A trusted publisher can be configured to
allow `npm stage publish` and **not** `npm publish`. The CI identity can then
put a release candidate into npm's staging area but cannot make it public, and
disallowing tokens removes token-based publication. This does **not** make the
Drydock review mandatory: npm still permits an account holder to publish
interactively with password, 2FA, and an OTP, and npm approval does not require
the maintainer to open or accept the Drydock report.

This page is the recipe, followed by an honest accounting of what it does and
does not stop. Prerequisite: a working staged-publish review — a Drydock organization with a
read-scoped npm token connected, so stages are discovered and scanned. The
in-app guide at `/docs#staged-publishing` covers that setup.

## The recipe

1. **Configure a stage-only trusted publisher.** npm CLI ≥ 11.15.0, 2FA on the
   account, write access to the package, and the package must already exist on
   the registry (npm cannot stage a first version).

   ```sh
   npm trust github <package> \
     --repo <owner>/<repo> \
     --file publish.yml \
     --allow-stage-publish
   ```

   The load-bearing detail is the omission: `--allow-publish` is **not** passed.
   At least one of the two flags is required, so passing only
   `--allow-stage-publish` is what produces a publisher that can stage and
   nothing else. `npm trust list <package>` shows what the package currently
   grants.

2. **Set publishing access to "Require two-factor authentication and disallow
   tokens"** in the package settings on npmjs.com. This removes every token
   path — legacy, automation, and granular access tokens all stop working for
   publish — leaving the OIDC exchange as CI's credentialed route, and that
   route is stage-only. npm's interactive 2FA publication path remains available.

3. **Stage from CI over OIDC, not a token.** The job requests an id-token and
   runs `npm stage publish`; no `NODE_AUTH_TOKEN` appears anywhere.

   ```yaml
   jobs:
     stage:
       permissions:
         id-token: write # OIDC; no npm token exists in this workflow
       steps:
         - run: npm ci
         - run: npm stage publish
   ```

4. **Read the review.** Drydock discovers the stage and scans the private
   tarball, comparing it with the last published release on the same dist-tag.
   Record the decision and reason.

5. **Approve on npm with 2FA.** Either `npm stage approve <stage-id>` from the
   CLI or the Staged Packages tab on npmjs.com. Drydock never holds a credential
   that can complete this step.

## Why each pin matters

| Publish attempt                                                     | Stopped by                                                                           |
| ------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| `npm publish` with any token — laptop, CI secret, stolen token      | Publishing access disallows tokens                                                   |
| `npm publish` over OIDC from the pinned workflow                    | The trusted publisher grants `stage` only; npm refuses the publish exchange          |
| `npm stage publish` from another repository, workflow file, or fork | Trusted publisher claim mismatch; npm refuses the exchange                           |
| Editing the workflow to publish directly instead of staging         | Same claim, same refusal — the grant is on the publisher, not on the command CI runs |
| Interactive `npm publish` with account password, 2FA, and OTP       | Not stopped; npm permits this path independently of trusted publishing               |
| Staging or approving a malicious candidate                          | Not stopped; Drydock records advice and npm owns the decision                        |

One property compounds on top of the table. The artifact npm holds while it is
staged is the artifact that becomes public on approval — there is no rebuild
between the review and the publish, so the reviewed bytes and the shipped bytes
are the same bytes by construction. The workflow gate has to prove that
separately with a digest re-check.

## Gated staging: compose both

The two modes are not alternatives. npm exposes no hook for a third party to
block a stage — `npm stage approve` and `npm stage reject` both require an OTP,
even with a granular token, and there is no stage webhook — so Drydock cannot
tell npm that a stage is bad. It does not need to: put `npm stage publish`
inside the gated GitHub Environment and the gate reviews the tarball before
npm ever receives it.

1. Keep the stage-only trusted publisher from the recipe above, but pin it to
   the gate environment (`--environment production` in `npm trust`, or the
   environment field on npmjs.com). npm then refuses the OIDC exchange for any
   job outside that environment, and the job inside it cannot start until the
   gate has passed.
2. Split the workflow into a `pack` job that uploads the `.tgz` plus
   `SHA256SUMS`, and a `stage` job in the protected environment that verifies
   the download and runs `npm stage publish` on the reviewed tarball. Nothing
   is rebuilt after the review: the stage job never checks out or builds the
   source.

   ```yaml
   jobs:
     pack:
       runs-on: ubuntu-latest
       permissions:
         contents: read
       steps:
         - uses: actions/checkout@v4
         - uses: actions/setup-node@v4
           with:
             node-version: 24
         - run: npm ci
         - run: npm pack --pack-destination dist
         - run: cd dist && sha256sum *.tgz > SHA256SUMS
         - uses: actions/upload-artifact@v4
           with:
             name: npm-release-candidates
             path: dist/
     stage:
       needs: pack
       runs-on: ubuntu-latest
       environment: production # Drydock is this environment's protection rule
       permissions:
         id-token: write # OIDC; the trusted publisher can stage and nothing else
         contents: read
       steps:
         - uses: actions/setup-node@v4
           with:
             node-version: 24
             registry-url: https://registry.npmjs.org
         # `npm stage` needs npm >= 11.15.0 (trusted publishing needs >= 11.5.1);
         # the npm bundled with the runner's Node may be older.
         - run: npm install -g npm@^11.15.0
         - uses: actions/download-artifact@v4
           with:
             name: npm-release-candidates
             path: dist
         - run: cd dist && sha256sum --check --strict SHA256SUMS
         - run: npm stage publish dist/*.tgz
   ```

   `--provenance` is not passed: npm's trusted-publishing documentation says
   provenance is generated by default when a public package is published from a
   public repository, so the flag adds nothing there.

3. Approve on npm with 2FA as before. Nothing about npm's decision changes.

What this buys:

- **The gate is the enforced checkpoint.** A malicious candidate built by CI
  never reaches npm's stage queue; Drydock rejects the job and the OIDC
  exchange never happens.
- **The stage is npm holding exactly the reviewed bytes.** The `.tgz` the gate
  hashed is the `.tgz` npm stages, and npm publishes what it staged.
- **The stage becomes the receipt.** Drydock still discovers and scans the
  stage, and the staged review carries a **Gate continuity** section: the
  SHA-256 the sandbox computed from the staged bytes is matched against the
  organization's completed **npm** workflow-gate reviews of the same package
  version (a PyPI or VS Code gate of the same name is never evidence). The
  lookup is keyed on npm's own stage record (package name and version from the
  registry), never on the tarball's manifest, so a hostile stage cannot rename
  itself out of its package's gate history.

| Gate continuity     | Meaning                                                                                                                                                                                                                                                                                                                        |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `matched`           | npm holds the tarball the gate reviewed **and approved** (the gate's latest decision on these bytes wins, and the download was confirmed against npm's stage record); approving on npm publishes the gated bytes. Links the gate review.                                                                                       |
| `gate-not-approved` | The gate reviewed exactly these bytes and rejected them (or has not decided), yet they were staged anyway. Reject on npm.                                                                                                                                                                                                      |
| `digest-mismatch`   | The gate reviewed this version, but the staged tarball hashes differently. Something staged bytes the gate never saw.                                                                                                                                                                                                          |
| `unverified`        | A gate review of this version exists, but nothing binds the stage to it. The `reason` says why: `gate-review-incomplete`, `staged-digest-unavailable`, `gate-digest-unavailable`, `gate-decision-unavailable`, `stage-not-bound-to-registry`, or `review-window-truncated`.                                                    |
| `ungated`           | A release target the organization **still has configured** (npm or auto-detect, on an active GitHub App installation) has completed a gate review of this package — directly, or as a target recreated for the same repository — and no gate review of this version exists. The stage was produced outside the gated workflow. |
| `unknown`           | The check could not run while the organization has a live npm-capable release target (or that too could not be read): the gate history read failed (`history-unavailable`), or npm's stage record was unavailable (`registry-record-unavailable`). Whether the stage went through the gate is not known.                       |

`unverified` reasons, in the order the evaluator reaches them: only a gate scan
of this version that has not completed (still running, or failed) exists; the
sandbox computed no SHA-256 for the staged bytes; no review of this version
recorded a single npm tarball digest (a multi-artifact bundle, or a review
older than gate provenance); the gate reviewed these exact bytes but its gate
row has since been deleted, so its decision is unknown; the digests agree with
an approved review but the download was not confirmed against npm's stage
record, so nothing shows npm holds those bytes; or none of the ten most recent
reviews of this version match and older ones exist.

No record at all means the organization does not gate this package: no live
release target has reviewed it, and no gate scan of this version exists. An
organization that only uses the watchtower sees no change, even when a lookup
fails; one that deleted its release target, uninstalled the GitHub App, or
pinned the target to another ecosystem stops seeing `ungated` for that package.
Recreating a target for the same repository (the only way to edit one) keeps
it: liveness also matches the repository the gate attested on its scans.

The record is advisory and additive: it never moves risk, findings, or a
decision, and a check that could not run for an organization that could be
gating is recorded as `unknown` (and emits `scan.gate_continuity.lookup_failed`)
rather than as no record, so a transient failure never reads as "not gated". A stage that
was checked and is not `matched` emits `scan.gate_continuity.broken`. It is folded into the
[release receipt](./release-receipts.md) as `evidence.gateContinuity`, which
names the gate review. `report.json` carries it as `gateContinuity` with the
status, reason, and both digests only (`stagedDigest`, `gateDigest`): a public
share link serves those same bytes, so the gate's repository, environment, run,
decision, and internal ids stay behind authentication.

What it still does not stop is the account-takeover path: whoever holds the npm
account can stage interactively (password, 2FA, OTP) and approve with 2FA. That
stage is discovered like any other, and for a package a live release target
gates it reads as `ungated` — the signal a maintainer needs to reject it on npm
rather than approve it.

## Compared with the workflow gate

They put the candidate in different places and give Drydock different authority.

|                       | Stage-only trusted publishing           | [Workflow gate](./npm-trusted-publishing.md)                     |
| --------------------- | --------------------------------------- | ---------------------------------------------------------------- |
| Who holds the release | npm, as a private stage                 | GitHub, as a paused deployment                                   |
| Ecosystems            | npm only                                | npm, PyPI, VS Code                                               |
| Setup surface         | One `npm trust` call, one token setting | GitHub App, Environment, protection rule, trusted publisher pins |
| CI credential         | Can stage; can never publish            | Exists only after the review passes                              |
| Reviewed vs shipped   | Same artifact by construction           | Proven by `sha256sum --check` against the reviewed digests       |
| Drydock mode          | Stage Watchtower — advisory             | Workflow Gate — enforced                                         |
| Final approval        | Independently in npm, with 2FA          | In Drydock for the configured protected job                      |

Stage-only is the shorter setup for a maintainer already running
`npm stage publish`. The gate is the one that generalizes past npm and past a
single package. [Gated staging](#gated-staging-compose-both) runs the stage
command inside the gate and gets both.

## What this does not stop

- **A skipped Drydock review.** npm will take a 2FA approval on a stage the
  maintainer never opened in Drydock. The recorded review is advisory. Gated
  staging moves the enforced review in front of the stage; npm's approval
  itself still does not consult Drydock.
- **An interactive direct publish.** An account holder with password, 2FA, and
  an OTP can still run `npm publish`; npm has no trusted-publisher-only mode.
- **npm account takeover.** Whoever controls the account can re-run `npm trust`
  with `--allow-publish`, revoke the trust configuration, or re-enable tokens.
  Every registry-side control roots in account security.
- **A poisoned source tree.** If the repository's own source is malicious, CI
  will build it faithfully, npm will attach valid provenance to it, and the
  stage will contain it. Provenance records where a package was built, not
  whether its contents are safe. This is the case artifact review exists for:
  the stage is where a newly added `preinstall` hook or an unexplained new file
  is visible, and it is visible before anyone can install it.
- **A package's first version.** npm cannot stage a package that does not exist
  yet, so the initial publish needs a direct path. Configure the stage-only
  publisher immediately afterwards.
- **Drydock unavailability.** npm still owns the stage and its decision. A
  maintainer can approve, reject, or publish manually without a Drydock review.
