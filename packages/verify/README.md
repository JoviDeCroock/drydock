# drydock-verify

`drydock verify` turns dependency changes in `package-lock.json` or
`pnpm-lock.yaml` into a policy check backed by Drydock's public, deterministic
package-diff verdicts.

The CLI reads lockfiles as data and calls HTTPS endpoints. It never installs
dependencies, runs lifecycle scripts, imports changed packages, or executes
package-provided code.

```sh
npx drydock-verify verify --base origin/main
```

Commit a `drydock.policy.json` at the repository root:

```json
{
  "$schema": "https://unpkg.com/drydock-verify/drydock.policy.schema.json",
  "minReleaseAgeHours": 72,
  "maxGrade": "notable",
  "denyCapabilityEscalation": ["network", "process", "credentials"],
  "requireListedReview": ["@company/critical-*"],
  "onUnavailable": "fail"
}
```

`requireListedReview` accepts `*` wildcards. When capability coverage is
incomplete, a capability-denial rule cannot prove that no escalation occurred;
the CLI therefore handles that row through `onUnavailable`.

The command prints a Markdown table, appends the same table to
`GITHUB_STEP_SUMMARY` when that variable is present, and exits nonzero for policy
violations. `--endpoint` (or `DRYDOCK_URL`) selects a self-hosted Drydock origin.
