# npm stage-only trusted publishing: making the review unskippable

[npm staged publishing](https://docs.npmjs.com/staged-publishing/) holds a
candidate tarball privately so Drydock can review the exact bytes before anyone
can install them. On its own that is a review a maintainer _chooses_ to run:
nothing stops the same CI job — or anyone holding a token — from calling
`npm publish` and skipping the stage entirely.

npm's trusted publishing closes that. A trusted publisher can be configured to
allow `npm stage publish` and **not** `npm publish`. The CI identity can then
put a release candidate into npm's staging area but cannot make it public, and
with tokens disallowed there is no other credential that can. The only route to
a public version is a human approving a stage with 2FA — after reading the diff.

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
   publish — leaving the OIDC exchange as the only credentialed route, and that
   route is stage-only.

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

| Publish attempt                                                     | Stopped by                                                                                |
| ------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| `npm publish` with any token — laptop, CI secret, stolen token      | Publishing access disallows tokens                                                        |
| `npm publish` over OIDC from the pinned workflow                    | The trusted publisher grants `stage` only; npm refuses the publish exchange               |
| `npm stage publish` from another repository, workflow file, or fork | Trusted publisher claim mismatch; npm refuses the exchange                                |
| Editing the workflow to publish directly instead of staging         | Same claim, same refusal — the grant is on the publisher, not on the command CI runs      |
| Staging a malicious candidate                                       | Nothing, and deliberately so: a stage is inert until approved, which is where review sits |

One property compounds on top of the table. The artifact npm holds while it is
staged is the artifact that becomes public on approval — there is no rebuild
between the review and the publish, so the reviewed bytes and the shipped bytes
are the same bytes by construction. The workflow gate has to prove that
separately with a digest re-check.

## Compared with the workflow gate

Both make a review unskippable; they put the hold in different places.

|                       | Stage-only trusted publishing           | [Workflow gate](./npm-trusted-publishing.md)                     |
| --------------------- | --------------------------------------- | ---------------------------------------------------------------- |
| Who holds the release | npm, as a private stage                 | GitHub, as a paused deployment                                   |
| Ecosystems            | npm only                                | npm, PyPI, VS Code                                               |
| Setup surface         | One `npm trust` call, one token setting | GitHub App, Environment, protection rule, trusted publisher pins |
| CI credential         | Can stage; can never publish            | Exists only after the review passes                              |
| Reviewed vs shipped   | Same artifact by construction           | Proven by `sha256sum --check` against the reviewed digests       |
| Final approval        | A human on npm, with 2FA                | A human in Drydock; the workflow resumes                         |

Stage-only is the shorter setup for a maintainer already running
`npm stage publish`. The gate is the one that generalizes past npm and past a
single package.

## What this does not stop

- **An approval nobody read.** Enforcement makes the review unskippable, not
  thorough. npm will happily take a 2FA approval on a stage the maintainer never
  opened.
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
- **Drydock unavailability.** The stage simply waits; npm holds it either way.
  The failure mode is a delayed release, never an unreviewed one.
