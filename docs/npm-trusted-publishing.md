# npm trusted publishing: making the gate the only publish path

The [npm workflow gate](./workflow-gates.md#npm-workflow-gate-notes) pauses a
publish while Drydock reviews the exact bytes. On its own it is a checkpoint on
one path: nothing stops a maintainer — or an attacker holding a token — from
publishing around it. npm's **trusted publishing** (OIDC) closes that. Pin the
package's publish path to one repository, one workflow file, and one GitHub
Environment, make Drydock that environment's deployment-protection rule, and
disallow tokens. The only way to obtain publish credentials is then to pass the
review.

This page is the recipe, followed by an honest accounting of what it does and
does not stop. Prerequisite: a working npm workflow gate as described in
[`workflow-gates.md`](./workflow-gates.md#npm-workflow-gate-notes) — Drydock
GitHub App installed, release target configured, publish workflow uploading the
packed tarballs plus `SHA256SUMS`.

## The recipe

On npmjs.com, in the package's settings:

1. **Configure a trusted publisher**: GitHub Actions, with the owning
   organization/user, the repository, the workflow filename (for example
   `publish.yml`), and — the load-bearing step — the **environment** set to the
   gated environment (`production` below). With the environment pinned, npm
   refuses the OIDC exchange for any job outside that environment, and a job
   inside it cannot start until the environment's protection rules have passed.
2. **Set publishing access to "Require two-factor authentication and disallow
   tokens"**. This removes every token path: legacy tokens, automation tokens,
   and granular access tokens all stop working for publish.

On GitHub, in the repository:

3. **Harden the `production` environment**: Drydock is its custom
   deployment-protection rule; **uncheck "Allow administrators to bypass
   configured protection rules"** (it is on by default); restrict deployment
   branches/tags to the release branch or tag pattern.
4. **Protect the workflow file**: a ruleset or branch protection on the branch
   the workflow publishes from, with `CODEOWNERS` review on
   `.github/workflows/`. The trusted publisher pins the workflow _path_, not
   its contents — review on changes to it belongs to the same bar as a release.
5. **Publish via OIDC, not a token**. The publish job runs in the environment,
   requests an id-token, verifies the reviewed digests, and publishes with npm
   CLI ≥ 11.5.1 and no `NODE_AUTH_TOKEN` anywhere in the workflow:

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
  publish:
    needs: pack
    environment: production # must match the trusted publisher's pinned environment
    permissions:
      id-token: write # OIDC; no npm token exists in this workflow
    steps:
      - uses: actions/download-artifact@v4
        with:
          name: npm-release-candidates
      # Fail closed if the downloaded bytes drifted from what was reviewed.
      - run: sha256sum --check --strict SHA256SUMS
      - run: npm publish *.tgz
```

This is the same shape as the recommended gate workflow in
[`workflow-gates.md`](./workflow-gates.md#npm-workflow-gate-notes); the deltas
are the `id-token: write` permission and the absence of any token secret.

## Why each pin matters

| Publish attempt                                                | Stopped by                                                                               |
| -------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| `npm publish` with any token — laptop, CI secret, stolen token | Publishing access disallows tokens                                                       |
| OIDC publish from another repository, workflow file, or a fork | Trusted publisher claim mismatch; npm refuses the exchange                               |
| Editing the workflow to drop `environment: production`         | Environment is pinned in the trusted publisher config; the OIDC exchange fails           |
| Running the publish job without (or against) a gate decision   | The deployment-protection rule holds the job; a Drydock rejection fails the run closed   |
| Rebuilding or swapping the tarball after approval              | `sha256sum --check --strict` fails closed; the same digests are in the report Provenance |
| A repo admin approving the deployment past the rule in the UI  | Admin bypass unchecked on the environment                                                |

Two properties compound on top of the table. Because the publish is OIDC-based,
npm attaches provenance attestations (for public repositories) binding the
published version to the repository and workflow run — so a version that _did_
ship around this path is publicly distinguishable from one that went through
it. And the review boundary
stays intact under workflow tampering: pinning controls _which_ path can
publish, while Drydock's review of the uploaded bytes judges _what_ that path
is about to publish — a malicious workflow edit that produces malicious bytes
still lands in front of the reviewer.

Gate scans arriving through this path carry the `attested` source-binding tier
(see [`intent-envelope.md`](./intent-envelope.md)): the signed
`deployment_protection_rule` webhook binds repository, run, and environment,
and the reviewed bytes were downloaded from that exact run.

## What this does not stop

- **Interactive publish by the npm account itself.** "Disallow tokens" still
  permits a human with the account password, 2FA, and an OTP to `npm publish`
  from a laptop. npm has no "trusted publisher only" enforcement today; this is
  the residual gap only the registry can close. Such a publish is _detectable_
  — no provenance attestation, no gate review, no report — but not preventable.
- **npm account takeover, including 2FA.** Whoever controls the account can
  edit or remove the trusted publisher configuration and re-enable tokens.
  Every registry-side control roots in account security.
- **GitHub administrators.** Repo admins can edit the environment's protection
  rules and org admins can uninstall the App. Keep the admin set small; both
  actions land in GitHub's audit log.
- **Drydock unavailability.** The gate stays blocked and GitHub eventually
  fails the waiting run at its own timeout. The failure mode is a delayed
  release, never an unreviewed one.
