# npm trusted publishing

Pins a package's automated publish path to one repository, workflow file, and GitHub Environment whose deployment-protection rule is Drydock, and disallows tokens, so the configured workflow gets its OIDC publish credential only after the review passes. **Authority:** enforced for the configured workflow job (GitHub holds it; npm refuses OIDC outside the pinned environment); npm's interactive password + 2FA + OTP publish path is not stopped. **Owner:** npm and GitHub settings; Drydock side is the [workflow gate](./workflow-gates.md).

Prerequisite: a working npm workflow gate ([workflow-gates.md](./workflow-gates.md)): Drydock GitHub App installed, release target configured, publish workflow uploading packed tarballs plus `SHA256SUMS`.

Alternative for npm only: a stage-only trusted publisher where npm holds the candidate instead of GitHub holding the job, **Stage Watchtower — advisory** ([npm-staged-publishing.md](./npm-staged-publishing.md), which also compares it with **Workflow Gate — enforced**). The two compose: a stage-only publisher pinned to the gate environment gives an enforced review before npm holds the bytes and a staged review bound back to the gate ([gated staging](./npm-staged-publishing.md#gated-staging-compose-both)).

## Settings checklist

| # | Where | Setting | Value |
| --- | --- | --- | --- |
| 1 | npmjs.com package settings | Trusted publisher | GitHub Actions; owning organization/user; repository; workflow filename (e.g. `publish.yml`); **environment** = the gated environment (`production`) |
| 2 | npmjs.com package settings | Publishing access | "Require two-factor authentication and disallow tokens" |
| 3 | GitHub repository → Environments → `production` | Deployment protection | Drydock as custom deployment-protection rule |
| 4 | same | "Allow administrators to bypass configured protection rules" | **unchecked** (on by default) |
| 5 | same | Deployment branches/tags | restricted to the release branch or tag pattern |
| 6 | GitHub repository rulesets / branch protection | Workflow file | protect the publishing branch; `CODEOWNERS` review on `.github/workflows/` |

- Step 1 is load-bearing: with the environment pinned, npm refuses the OIDC exchange for any job outside it, and a job inside it cannot start until the environment's protection rules pass.
- Step 2 removes every token path: legacy, automation, and granular access tokens all stop working for publish.
- Step 6: the trusted publisher pins the workflow _path_, not its contents, so changes to it need the same review bar as a release.

## Workflow

The canonical [npm-workflow-gate.yml](./examples/npm-workflow-gate.yml) already is the trusted-publishing shape. The lines these settings depend on:

| Workflow line | Why it matters |
| --- | --- |
| `environment: production` on the `publish` job | must equal the trusted publisher's pinned environment; GitHub holds the job for Drydock |
| `permissions: { id-token: write, contents: read }` | OIDC credential; no `NODE_AUTH_TOKEN` or token secret anywhere in the workflow |
| `npm install -g npm@^11.5.1` | trusted publishing needs npm CLI ≥ 11.5.1 |
| `sha256sum --check --strict SHA256SUMS` | fails closed if downloaded bytes drifted from what was reviewed |
| `npm publish dist/*.tgz --access public --provenance` | publishes exactly the reviewed tarballs |

## Why each pin matters

| Publish attempt | Stopped by |
| --- | --- |
| `npm publish` with any token (laptop, CI secret, stolen token) | Publishing access disallows tokens |
| OIDC publish from another repository, workflow file, or fork | Trusted publisher claim mismatch; npm refuses the exchange |
| Editing the workflow to drop `environment: production` | Environment pinned in the trusted publisher; the OIDC exchange fails |
| Running the publish job without (or against) a gate decision | GitHub's deployment-protection rule holds the job; GitHub fails the run on a Drydock rejection |
| Rebuilding or swapping the tarball after approval | `sha256sum --check --strict` rejects changed bytes, assuming the publish job and its check remain trusted |
| A repo admin approving the deployment past the rule in the UI | Admin bypass unchecked on the environment |

## Invariants

1. Pinning controls which job can obtain the publish credential; Drydock reviews the uploaded bytes. The registry does not bind the credential to Drydock's reviewed digest, so a job later allowed to publish different bytes or skip its checksum check defeats the binding.
2. OIDC publishes from public repositories get npm provenance binding the version to the repository and workflow run, so a version shipped around this path can carry different provenance. Provenance is not proof of Drydock approval, and missing provenance alone does not prove a bypass.
3. Gate scans arriving through this path carry the `attested` source-binding tier ([intent-envelope.md](./intent-envelope.md)): the signed `deployment_protection_rule` webhook binds repository, run, and environment, and the reviewed bytes were downloaded from that exact run.
4. The [publication monitor](./publication-monitor.md) compares actual public npm bytes with prior reviews after publication, including releases that bypass this path; that observation happens after the package is public.

## What this does not stop

| Gap | Detail |
| --- | --- |
| Interactive publish by the npm account | "Disallow tokens" still permits password + 2FA + OTP `npm publish` from a laptop; npm has no trusted-publisher-only enforcement. Only the registry can close this. |
| npm account takeover, including 2FA | The account can edit or remove the trusted publisher and re-enable tokens. Every registry-side control roots in account security. |
| GitHub administrators | Repo admins can edit protection rules; org admins can uninstall the App. Keep the admin set small; both actions land in GitHub's audit log. |
| Drydock unavailability | The gate stays blocked and GitHub fails the waiting run at its own timeout. The configured workflow cannot continue unreviewed; npm's interactive 2FA path still exists. |
