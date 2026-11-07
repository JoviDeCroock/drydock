# Stage Watchtower — advisory npm staged review

Drydock discovers a candidate held by [npm staged publishing](https://docs.npmjs.com/staged-publishing/), reviews the exact private bytes before anyone can install them, and leaves npm's approve/reject decision entirely with the maintainer. **Authority:** advisory (Drydock neither approves the stage nor blocks a separate manual publication). **Owner:** `server/lib/ecosystems/npm/staged-publishes-discovery.ts`.

Prerequisite: a Drydock organization with a read-scoped npm token connected, so stages are discovered and scanned (in-app guide: `/docs#staged-publishing`). For the enforced alternative see [workflow-gates.md](./workflow-gates.md).

## At a glance

| Thing | Owner file | Pinned by |
| --- | --- | --- |
| Stage discovery and scan start | `server/lib/ecosystems/npm/staged-publishes-discovery.ts` | `test/staged-publishes-discovery.test.mjs`, `test/workers/staged-publishes-routes.test.ts` |
| Gate continuity evaluation | `server/lib/scan/gate-continuity-record.ts` | `test/gate-continuity.test.mjs` |
| Gate continuity lookup and events | `server/lib/scan/gate-continuity.ts` | `test/workers/gate-continuity.test.ts` |
| Gate review history read | `server/db/scan-gate-continuity.ts` | `test/workers/gate-continuity.test.ts` |
| Gate continuity UI | `src/pages/Dashboard/ScanDetail/ReportSections.tsx` | `test/gate-continuity-view.test.ts` |
| npm lifecycle status after review | [registry-version-status.md](./registry-version-status.md) | — |

## Stage-only recipe

1. **Configure a stage-only trusted publisher.** Needs npm CLI ≥ 11.15.0, 2FA on the account, write access, and an existing package (npm cannot stage a first version).

   ```sh
   npm trust github <package> \
     --repo <owner>/<repo> \
     --file publish.yml \
     --allow-stage-publish
   ```

   Do **not** pass `--allow-publish`. At least one of the two flags is required, so passing only `--allow-stage-publish` produces a publisher that can stage and nothing else. `npm trust list <package>` shows current grants.

2. **Set publishing access to "Require two-factor authentication and disallow tokens"** on npmjs.com. Legacy, automation, and granular tokens all stop working for publish, leaving OIDC as CI's credentialed route, and that route is stage-only. npm's interactive 2FA publish path remains.

3. **Stage from CI over OIDC.** No `NODE_AUTH_TOKEN` anywhere:

   ```yaml
   jobs:
     stage:
       permissions:
         id-token: write # OIDC; no npm token exists in this workflow
       steps:
         - run: npm ci
         - run: npm stage publish
   ```

4. **Read the review.** Drydock scans the private tarball against the last published release on the same dist-tag. Record the decision and reason.
5. **Approve on npm with 2FA:** `npm stage approve <stage-id>` or the Staged Packages tab on npmjs.com. Drydock never holds a credential that can complete this step.

| Publish attempt | Stopped by |
| --- | --- |
| `npm publish` with any token (laptop, CI secret, stolen token) | Publishing access disallows tokens |
| `npm publish` over OIDC from the pinned workflow | Trusted publisher grants stage only; npm refuses the exchange |
| `npm stage publish` from another repository, workflow file, or fork | Trusted publisher claim mismatch |
| Editing the workflow to publish instead of stage | Same refusal: the grant is on the publisher, not the command |
| Interactive `npm publish` with password, 2FA, and OTP | Not stopped; npm permits it independently of trusted publishing |
| Staging or approving a malicious candidate | Not stopped; Drydock records advice, npm owns the decision |

The staged artifact is the artifact npm makes public on approval: no rebuild happens between review and publish, so reviewed and shipped bytes are identical by construction. The workflow gate has to prove that separately with a digest re-check.

## Gated staging: compose both

npm exposes no hook for a third party to block a stage: `npm stage approve` and `npm stage reject` both require an OTP even with a granular token, and there is no stage webhook. So Drydock reviews before npm receives the bytes, by running `npm stage publish` inside the gated GitHub Environment.

1. Use the canonical gate workflow [npm-workflow-gate.yml](./examples/npm-workflow-gate.yml) (already OIDC, no token, `environment: production`, `permissions: { id-token: write, contents: read }`) with this delta to its `publish` job:

| Setting | Canonical workflow | Gated staging |
| --- | --- | --- |
| Trusted publisher | GitHub Actions, environment `production`, publish allowed | `npm trust github <package> --repo <owner>/<repo> --file <workflow>.yml --environment production --allow-stage-publish` (no `--allow-publish`); npm refuses OIDC outside that environment |
| npm CLI | `npm install -g npm@^11.5.1` | `npm install -g npm@^11.15.0` (`npm stage` needs it; the runner's bundled npm may be older) |
| Final command | `npm publish dist/*.tgz --access public --provenance` | `npm stage publish dist/*.tgz` |

Unchanged and load-bearing: the job never checks out or builds source, it only downloads the artifact and runs `sha256sum --check --strict`, so nothing is rebuilt after review. `--provenance` is unnecessary on the stage command: npm generates provenance by default for a public package published from a public repository.

2. Approve on npm with 2FA as before.

Effects:

- **The gate is the enforced checkpoint.** On a Drydock rejection GitHub keeps the protected job from running, so the OIDC exchange never happens and a malicious CI-built candidate never reaches npm's stage queue. GitHub enforces that hold for the configured job only.
- **npm holds exactly the reviewed bytes.** The `.tgz` the gate hashed is the `.tgz` npm stages and later publishes.
- **The stage becomes the receipt.** Drydock still discovers and scans the stage, and the staged review carries a **Gate continuity** record.

### Gate continuity

The SHA-256 the sandbox computed from the staged bytes is matched against this organization's completed **npm** workflow-gate reviews of the same package version (a PyPI or VS Code gate of the same name is never evidence). The lookup keys on npm's stage record (package name and version from the registry), never the tarball manifest, so a hostile stage cannot rename itself out of its package's gate history.

| Status | Meaning | Maintainer action |
| --- | --- | --- |
| `matched` | npm holds the tarball the gate reviewed **and approved** (the gate's latest decision on these bytes wins; the download was confirmed against npm's stage record). Links the gate review. | Approving on npm publishes the gated bytes |
| `gate-not-approved` | The gate reviewed exactly these bytes and rejected them (or has not decided), yet they were staged | Reject on npm |
| `digest-mismatch` | The gate reviewed this version but the staged tarball hashes differently | Something staged bytes the gate never saw; reject |
| `unverified` | A gate review of this version exists but nothing binds the stage to it; `reason` below | Decide individually |
| `ungated` | A still-configured target gates this package and no gate review of this version exists | Produced outside the gated workflow (the account-takeover path); reject |
| `unknown` | Check could not run while a live npm-capable target exists (or that could not be read) | Gate passage not known |

| `unverified` reason (evaluation order) | Cause |
| --- | --- |
| `gate-review-incomplete` | Only a gate scan of this version that has not completed (running or failed) exists |
| `staged-digest-unavailable` | The sandbox computed no SHA-256 for the staged bytes |
| `gate-digest-unavailable` | No review of this version recorded a single npm tarball digest (multi-artifact bundle, or older than gate provenance) |
| `gate-decision-unavailable` | The gate reviewed these bytes but its gate row was deleted, so its decision is unknown |
| `stage-not-bound-to-registry` | Digests agree with an approved review, but the download was not confirmed against npm's stage record |
| `review-window-truncated` | None of the 10 most recent reviews of this version match (`GATE_REVIEW_LIMIT` in `server/db/scan-gate-continuity.ts`) and older ones exist |

| `unknown` reason | Cause |
| --- | --- |
| `history-unavailable` | Gate history read failed |
| `registry-record-unavailable` | npm's stage record was unavailable |

`ungated` requires a release target the organization **still has configured** (npm or auto-detect, on an active GitHub App installation) that completed a gate review of this package, directly or from a repository a live target still gates. Recreating a target (the only way to edit one) keeps it, because liveness also matches the repository recorded on gate scans against every live target; a repository renamed in between does not match.

No record at all means the organization does not gate this package: no live target reviewed it and no gate scan of this version exists. A watchtower-only organization sees no change, even when a lookup fails. Deleting the release target, uninstalling the GitHub App, or pinning the target to another ecosystem stops `ungated` for that package.

## Invariants

1. Gate continuity is advisory and additive: it never moves risk, findings, or a decision (`server/lib/scan/gate-continuity.ts`).
2. It keeps a stage out of batch approval: only `matched` or no record can be batch-approved; every other status needs its own decision.
3. A check that could not run for an organization that could be gating records `unknown` and emits `scan.gate_continuity.lookup_failed`, never "no record". An organization with no live target stays silent through a failure; if its GitHub App was uninstalled with gate history on record, that silence can hide what the stale rows would have said.
4. A checked stage that is not `matched` emits `scan.gate_continuity.broken`.
5. A gate review never establishes the [package claim](./package-claims.md). A stage is admitted like any other through the claim; a stage whose package another organization claims gets no staged review here, so it carries no continuity record.
6. Continuity is folded into the [release receipt](./release-receipts.md) as `evidence.gateContinuity` (names the gate review). `report.json` carries `gateContinuity` with status, reason, `stagedDigest`, and `gateDigest` only: a public share link serves those bytes, so the gate's repository, environment, run, decision, and internal ids stay behind authentication.

## Compared with the workflow gate

|  | Stage-only trusted publishing | [Workflow gate](./workflow-gates.md) |
| --- | --- | --- |
| Who holds the release | npm, as a private stage | GitHub, as a paused deployment |
| Ecosystems | npm only | npm, PyPI, VS Code |
| Setup surface | one `npm trust` call, one token setting | GitHub App, Environment, protection rule, trusted publisher pins |
| CI credential | can stage; can never publish | exists only after the review passes |
| Reviewed vs shipped | same artifact by construction | proven by `sha256sum --check` against the reviewed digests |
| Drydock mode | Stage Watchtower — advisory | Workflow Gate — enforced |
| Final approval | independently in npm, with 2FA | in Drydock; GitHub enforces it for the configured protected job |

Stage-only is the shorter setup for a maintainer already running `npm stage publish`. The gate generalizes past npm and past a single package. [Gated staging](#gated-staging-compose-both) gets both.

## What this does not stop

- **A skipped Drydock review.** npm takes a 2FA approval on a stage nobody opened in Drydock. Gated staging moves the enforced review in front of the stage; npm's approval still does not consult Drydock.
- **An interactive direct publish.** An account holder with password, 2FA, and OTP can run `npm publish`; npm has no trusted-publisher-only mode.
- **npm account takeover.** The account can re-run `npm trust` with `--allow-publish`, revoke trust, or re-enable tokens. It can also stage interactively and approve with 2FA; for a gated package that stage reads `ungated`, the signal to reject on npm. Every registry-side control roots in account security.
- **A poisoned source tree.** CI builds it faithfully and npm attaches valid provenance; provenance records where a package was built, not whether it is safe. The stage is where a new `preinstall` hook or unexplained file becomes visible before install.
- **A package's first version.** npm cannot stage a nonexistent package; the first publish needs a direct path. Configure the stage-only publisher immediately after.
- **Drydock unavailability.** npm still owns the stage; a maintainer can approve, reject, or publish without a Drydock review.

## Change checklist

- New continuity status or reason → `server/lib/scan/gate-continuity-record.ts`, the tables here, the UI view, `test/gate-continuity.test.mjs`, and [release-receipts.md](./release-receipts.md) if the receipt shape changes.
- Change to the gate YAML → edit only [the canonical file](./examples/npm-workflow-gate.yml); update the delta tables here and in [npm-trusted-publishing.md](./npm-trusted-publishing.md).
