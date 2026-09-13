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
   the download and runs `npm stage publish` on the reviewed tarball.

   ```yaml
   jobs:
     pack:
       steps:
         - run: npm ci
         - run: npm pack --json > pack.json
         - run: sha256sum *.tgz > SHA256SUMS
         - uses: actions/upload-artifact@v4
           with:
             name: npm-release-candidates
             path: |
               *.tgz
               SHA256SUMS
     stage:
       needs: pack
       environment: production # Drydock is this environment's protection rule
       permissions:
         id-token: write # OIDC; the trusted publisher can stage and nothing else
       steps:
         - uses: actions/download-artifact@v4
           with:
             name: npm-release-candidates
         - run: sha256sum --check --strict SHA256SUMS
         - run: npm stage publish *.tgz
   ```

3. Approve on npm with 2FA as before. Nothing about npm's decision changes.

What this buys:

- **The gate is the enforced checkpoint.** A malicious candidate built by CI
  never reaches npm's stage queue; Drydock rejects the job and the OIDC
  exchange never happens.
- **The stage is npm holding exactly the reviewed bytes.** The `.tgz` the gate
  hashed is the `.tgz` npm stages, and npm publishes what it staged.
- **The stage becomes the receipt.** Drydock still discovers and scans the
  stage. For a package the organization gates, the staged review carries a
  **Gate continuity** section: the SHA-256 the sandbox computed from the staged
  bytes is matched against the organization's workflow-gate reviews of the
  same package version.

| Gate continuity   | Meaning                                                                                                               |
| ----------------- | --------------------------------------------------------------------------------------------------------------------- |
| `matched`         | npm holds the tarball the gate reviewed; approving on npm publishes the gated bytes. Links the gate review.           |
| `digest-mismatch` | The gate reviewed this version, but the staged tarball hashes differently. Something staged bytes the gate never saw. |
| `unverified`      | The gate reviewed this version; the staged digest could not be computed, so nothing is bound.                         |
| `ungated`         | The organization gates this package and no gate review exists for this version. The stage was produced out of band.   |

The record is advisory and additive: it never moves risk, findings, or a
decision, and a lookup failure degrades to "no record" (`scan.gate_continuity.lookup_failed`).
A broken link emits `scan.gate_continuity.broken`. It is exported in
`report.json` as `gateContinuity` and folded into the
[release receipt](./release-receipts.md) as `evidence.gateContinuity`. Packages
the organization has never gated show nothing, so an org that only uses the
watchtower sees no change.

What it still does not stop is the account-takeover path: whoever holds the npm
account can stage from a laptop with a token and approve with 2FA. That stage
is discovered like any other, and for a gated package it reads as `ungated` —
the signal a maintainer needs to reject it on npm rather than approve it.

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
