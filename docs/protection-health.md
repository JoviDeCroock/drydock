# Protection health

Protection health continuously reads the configured GitHub controls for each mapped release target. **Authority:** advisory observation; GitHub enforces the underlying controls. **Owner:** `server/lib/github-app/protection-health-job.ts`.

## At a glance

| Surface | Scope | Owner |
| --- | --- | --- |
| Saved health | Each organization's mapped repository and Environment; repository default branch | `server/db/protection-health.ts` |
| Scheduled refresh | At most 20 due targets per 15-minute invocation, concurrency 3; suspended/uninstalled installations remain visible | `server/scheduled.ts` |
| Manual refresh | Organization owner/admin, 10 per minute per organization | `server/routes/github-app/protection-health.ts` |
| Setup parity | The same live Environment collector also backs publisher setup checks | `server/lib/github-app/setup-status.ts` |

## Contract

All routes require a session and active-organization membership, return `Cache-Control: private, no-store`, and are mounted under `/api/v1/github-app`.

| Method | Path | Result |
| --- | --- | --- |
| GET | `/protection-health` | `{ targets, canRefresh }`; saved observations only, no GitHub requests |
| POST | `/protection-health/:targetId/refresh` | Owner/admin only; `{ target }`, or `404` for an absent/foreign target |

Each target carries `releaseTargetId`, repository, Environment, `defaultBranch`, `checkedAt`, `stale`, checks, and `scope: mapped_environment_and_default_branch`. Each check has `id`, `label`, `status` (`passed`, `failed`, `unknown`), and an explanation.

- `protected`: every collected check passed and the snapshot is fresh. The UI calls this **Configured controls verified**.
- `at_risk`: a control is known absent, disabled, bypassable, or changed. A currently inactive installation or disabled dependency review remains at risk even when the saved observation is stale.
- `unknown`: evidence is missing, inaccessible, incomplete, or older than one hour. A target, installation or dependency-settings change also invalidates older evidence.

Checks cover an active installation with access to the mapped repository; Environment existence; this Drydock App's enabled deployment-protection rule; disabled Environment administrator bypass; workflow-file continuity; enabled and available dependency review; and a required dependency check pinned to this Drydock App on the repository's current default branch.

### Dependency requirement

Active branch rulesets are read through `/rules/branches/:branch`. A matching status check must name **Drydock dependency review** and this deployment's App id. The referenced ruleset must be active and expose an empty `bypass_actors` array. A capped, malformed, or inaccessible result remains unknown.

Classic branch protection can independently establish the requirement when its status check has the exact App source and `enforce_admins.enabled` is true. At most ten matching ruleset details are read per collection. GitHub collection has a two-minute deadline; unavailable evidence remains unknown. The health reader requests Administration read **only when the installation already grants Administration read or write**. It changes no App or repository permissions. Without that grant, an absent ruleset requirement does not prove the classic requirement is missing: it remains unknown.

### Workflow continuity

The latest approved gate with a completed workflow-gated scan for this exact organization, target and repository identifies a GitHub run. The reader validates that run's repository id, workflow path and commit, then compares the workflow's regular-file blob id and mode at the reviewed commit with its current default-branch file. Unrelated source commits may change without breaking continuity. A changed or removed workflow needs review; this is not a malware verdict.

Before the first approved gated release, or if either workflow version cannot be read, continuity is unknown. The bounded regular-file reader refuses symlinks, case twins, incomplete trees and oversized/non-UTF-8 files. Repository code is never executed.

## Invariants

1. Health does not hold releases or merges, approve packages, or alter GitHub configuration. Workflow Gate and required checks retain their own authority.
2. These observations cover the mapped Environment and current default branch, not every branch, tag, alternate workflow, reusable workflow, supporting script, registry setting, or interactive publish/install path.
3. Claims and writes remain organization scoped. Target deletion cascades saved health; a late refresh cannot recreate the target or its snapshot.
4. A three-minute compare-and-set lease serializes refreshes. Beginning a refresh clears the old passing snapshot, so a failed refresh cannot preserve a green status. An expired attempt cannot overwrite its replacement. Saving also compares the target, installation and dependency-settings versions read at collection start; configuration changes during GitHub reads discard the old-scope observation.
5. Cron catches each target's failure independently. The oldest due targets go first; a bounded batch cannot make later targets disappear from the authenticated list.
6. Installation tokens contain read permissions only, remain repository scoped, never follow redirects, and are revoked best effort after collection.
7. Health transitions emit `github_app.protection_health.changed` and appear in the organization audit log. Unknown GitHub reads emit redacted operational events. No alerts are sent by this feature.

## Failure modes

| Condition | Result |
| --- | --- |
| App suspended/uninstalled | At risk; mapped target remains listed and scheduled |
| GitHub unavailable, permission missing, incomplete response | Current evidence unknown; previous passing evidence is cleared |
| Administrator or ruleset bypass allowed | At risk when sources establish the bypass; incomplete alternative protection remains unknown |
| No prior approved gated release | Workflow continuity unknown |
| Workflow file changed | Needs review; supporting scripts and other publish paths remain outside this comparison |
| Target deleted during refresh | Late snapshot discarded |
| Refresh already running | Current saved state returned without a competing GitHub collection |
| Cron backlog | Every saved row remains visible; observations expire after one hour |

## Change checklist

Run `test/protection-health.test.ts` for collector evidence and `test/workers/protection-health.test.ts` for routes, tenancy, leases, persistence and the bounded sweep. Environment collector changes also require `test/workers/publisher-setup.test.ts`. UI copy must retain the boundary and freshness disclosures.
