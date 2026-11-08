# Prevention flow

Drydock separates installation admission, dependency merge review, and release publication into explicit decisions. **Authority:** each control applies only where the caller or GitHub requires it. **Owners:** the [CLI](../cli/README.md), [dependency review](./dependency-review.md), [workflow gates](./workflow-gates.md), and [protection health](./protection-health.md).

## At a glance

| Boundary | Control | What stays stopped |
| --- | --- | --- |
| Before installation | Run CLI admission before the installer in a trusted job or shell sequence | Installation after a failed or incomplete assessment |
| Before merge | Require the Drydock App's dependency review check | Dependency changes held by the organization's policy |
| Before publication | Target a GitHub Environment with the Drydock protection rule | The configured publish job until a maintainer decides |
| Ongoing configuration | Scheduled protection health and manual rechecks | Nothing directly; health exposes missing, changed, stale, or unreadable protection |

## Contract

For example, a coding agent upgrades a dependency of `acme-ui`:

1. Resolve the proposed dependency graph without executing dependency or project lifecycle code. Keep the existing lockfile from a trusted revision as the baseline.
2. Run admission on the proposed lockfile and its sibling project manifest before installing. Admission validates their resolver declarations, compares public package changes, and binds the review to archive bytes using both lockfile integrity and reviewed archive digests. Unsupported or incomplete input stops the command.
3. Only after admission succeeds, run the installer with lifecycle execution disabled. An existing install-time control such as Safe Chain can independently block known malware. Running package scripts, tests, or application code is a separate execution decision.
4. Open the dependency PR. The required Drydock check evaluates the lockfile changes under the saved organization policy. A held change waits for repository-writer approval; unapproved changes cannot satisfy that required check.
5. After merge, CI builds `acme-ui`, uploads the completed release artifact, and targets the protected publish Environment.
6. Drydock reviews the finished artifact. The maintainer approves or rejects the protected job. An approved job publishes the same downloaded artifact, with the workflow's checksum check detecting byte drift.
7. Protection health periodically reads the configured GitHub controls again. The settings page shows the observation time and gaps; an old observation or an unavailable GitHub read does not establish current protection.

### Installation order

Provision a pinned Drydock CLI outside the project before this sequence. If using Safe Chain,
provision its pinned CI shims beforehand too; its normal package-manager commands remain the
installer. Do not bootstrap the reviewer through an unreviewed project dependency.

With a supported proposed `package-lock.json` and a separately supplied trusted baseline:

```sh
drydock admit package-lock.json --baseline trusted-package-lock.json --output admission.json &&
  npm --prefix "$PWD" --workspaces=false ci --ignore-scripts --registry=https://registry.npmjs.org
```

The shell starts the installer only after a zero exit. The receipt output must use a new path.
Supply the baseline from a trusted revision, not the PR's proposed replacement. In CI, keep the
admission and installation sequence in trusted workflow code and pin the checked-out revision.
Run from the admitted lockfile's directory and keep both the lockfile and `package.json` unchanged
between commands. The explicit prefix prevents npm from selecting an ancestor workspace instead.
npm verifies downloaded packages against the same integrity pins; this does not authorize
lifecycle or application execution.

Admission currently supports public npm registry graphs in package-lock v2/v3. Other lockfile
formats and registries remain outside this install boundary; dependency PR review has its own
broader supported formats. See the [CLI contract](../cli/README.md) for limits and refusal cases.

### Policy and exceptions

The dependency settings offer the existing capability policy and an explicit Prevention profile. Prevention also holds new packages, unread updates, and uninspected changed files. Selecting a profile changes a draft; saving applies it to future reviews. Existing organizations retain their saved settings.

PR approval is scoped to the exact dependency change and repository. Installation admission has its own trusted-baseline and supported-input contract; a GitHub approval does not automatically authorize local installation. Changing a trusted baseline is an explicit trust decision, not evidence that the package was fully inspected.

## Invariants

1. Review commands and server scanners never install, import, build, or execute the packages they inspect. The caller controls the subsequent installer and execution order.
2. A clean diff concerns a change relative to its baseline. It does not establish that the baseline or the full package is harmless.
3. Artifact hashes establish byte identity; they do not authenticate a publisher or prove benign behavior.
4. Health describes the mapped Environment and inspected branch configuration at an observation time. It cannot prevent an administrator from changing GitHub settings or protect alternate publishing paths.
5. The install gate, merge check, and publish gate are separate boundaries. A later hold cannot undo code already executed at an earlier boundary.

## Failure modes

| Condition | Result | Next action |
| --- | --- | --- |
| Admission fails or cannot assess a change | Nonzero exit; the trusted calling sequence must not run its installer | Read the result and resolve the unsupported input, coverage gap, or held change |
| New dependency has no trusted comparison | Manual review required | Establish a reviewed trust decision before changing the baseline |
| PR policy holds a change | Required check remains unsatisfied | Inspect the evidence and approve the exact change or revise the PR |
| Maintainer rejects a release | Protected publish job stays blocked | Build and review a revised candidate |
| Protection is missing or unreadable | Health reports the failing or unknown check | Repair GitHub configuration or access, then recheck |
| Health observation is stale | Current protection is unverified | Recheck; do not infer a current result from an old passing observation |

## Change checklist

Keep each boundary's authority, supported inputs, coverage limits, and failure behavior aligned with its owner documentation. Verify the CLI's refusal paths, the required check's holds, and the protected publish job separately; a scanner finding alone is not an end-to-end prevention result.
