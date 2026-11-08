# Workflow Gate

Workflow Gate pauses a configured GitHub Environment publish job while Drydock reviews its uploaded release bytes. **Authority:** enforced. **Owner:** `server/lib/workflow-gate-job.ts`.

## At a glance

| Thing | Owner file | Who may call / trigger | Pinned by (test) |
| --- | --- | --- | --- |
| Signed delivery | `server/routes/github-webhooks.ts` | GitHub App | `test/workers/github-webhook.test.ts` |
| Candidate derivation | `server/lib/workflow-gates/prepare.ts` | Gate worker | `test/workers/workflow-gate-prepare.test.ts` |
| Deterministic/AI scan | `server/lib/scan/pipeline.ts` | Gate job | `test/workers/workflow-gate-job.test.ts` |
| Package decisions | `server/routes/github-app/workflow-gates.ts` | Authenticated member of owning organization | `test/workers/workflow-gate-job.test.ts` |
| Ecosystem registry | `server/lib/ecosystems/index.ts` | Internal adapters | `test/workers/workflow-gate-registry.test.ts` |
| Workbench lookup | `src/models/scan-detail-model.ts` | Review page | `test/scan-detail-gate-polling-model.test.ts` |

## Contract

### Release flow

| Step | Required action | Owner / reference |
| --- | --- | --- |
| 1 | Install GitHub App; map repository, Environment, ecosystem to release target | [Publisher setup](./publisher-setup.md) |
| 2 | Enable Drydock as Environment custom deployment-protection rule | [Self-hosting](./self-hosting.md) |
| 3 | Build and upload release artifacts before protected publish job starts | Ecosystem workflows below |
| 4 | Send `deployment_protection_rule` to `/webhooks/github` | `server/routes/github-webhooks.ts` |
| 5 | Resolve installation, repository, run, Environment, target, callback, and artifacts | `server/lib/workflow-gates/resolve.ts` |
| 6 | Derive one candidate per package; queue shared scan pipeline | `server/lib/workflow-gates/prepare.ts` |
| 7 | Accept or reject each package in workbench | Decision route below |
| 8 | Deliver durable aggregate decision to GitHub | `server/lib/workflow-gates/decision-delivery.ts` |

All gate API paths below have prefix `/api/v1/github-app`; their owner is `server/routes/github-app/workflow-gates.ts`.

| Method | Path | Auth / role |
| --- | --- | --- |
| GET | `/workflow-gates/by-scan/:scanId` | Session and owning active organization |
| POST | `/workflow-gates/:gateId/decision` | Verified email, owning active organization, applicable TOTP step-up |
| POST | `/workflow-gates/:gateId/retry` | Session and owning active organization |

`POST /webhooks/github` requires the `GITHUB_APP_WEBHOOK_SECRET` signature outside Better Auth's session guard; see [anonymous surfaces](./security-model.md). Decision body: `{"scanId":"scan-id","decision":"approved","comment":"Reviewed uploaded bytes","totpCode":"123456"}`. Use `rejected` to block; [2FA policy](./two-factor-auth.md) governs step-up.

| Condition | Gate outcome | Enforcement |
| --- | --- | --- |
| Any package undecided | Pending; GitHub job held | Aggregate every package |
| All packages approved; batch review ready | Approved; callback releases job | Attached batch `scanId` required |
| Any package rejected | Rejected; callback blocks job | Single rejection resolves aggregate |
| Failed package scan | Human may reject or retry | No approval before batch readiness |
| Pending failed batch without package decisions | Schedule retry (queue or inline); `202` | Retry route |
| Already decided, wrong package, partial-batch approval, non-retryable batch | `409` | Decision/retry routes |

### Release set

| Evidence | Contract | Owner |
| --- | --- | --- |
| Identity/version | Read artifact metadata, never names or GitHub paths alone | Ecosystem `workflow-gate.ts` adapters |
| Grouping | Separate package names produce separate reviews; same identity must share version | `server/lib/workflow-gates/group-candidates.ts` |
| Digest | Recompute from downloaded immutable artifact bytes | `server/lib/github-app/artifacts.ts` |
| Adapter input | Supply ecosystem/kind, normalized file list/hashes, candidate bytes, baseline when available, deterministic findings, display metadata | `server/lib/workflow-gates/types.ts` |
| Manifest | Synthesized server-side; maintainer declaration is never authority over bytes | Ecosystem manifest builders |
| Byte continuity | Upload once; publish exact reviewed bytes without rebuilding | Checksum workflows |
| Provenance | Persist `{ ecosystem, mode, artifacts: [{ path, kind, sha256 }] }` in `summary.stagedPublish` | Adapter `summarizeDetails` |
| Report | Workbench Provenance and `report.json` top-level `provenance.artifacts[]` expose revalidated digests | `server/lib/scan/report-export.ts` |

### PyPI workflow-gate notes

| Property | Contract / reference |
| --- | --- |
| Artifacts | Wheels `.whl`, sdists `.tar.gz` / `.tgz`; no uploaded `drydock-manifest.json` |
| Identity | Wheel `METADATA` or sdist `PKG-INFO`; PEP 503 normalization `[-_.]+ -> -` |
| Parsing | Wheel `METADATA`, `WHEEL`, `RECORD`; strip common sdist root |
| Discovery | `pypi-release-candidate`; `pypi-release-candidate-*` shards for pinned targets only |
| Memory/digests | Parse one bounded Actions artifact at a time; retain every distribution digest |
| Baseline | PyPI `info.version`, then newest non-yanked upload; sequential credential-free downloads restricted to `https://files.pythonhosted.org` |
| Findings | Metadata mismatches, missing `RECORD`, `.pth` startup hooks, custom `setup.py` install commands, `.pyd` native extensions |
| Workflow and bounds | [PyPI workflow gate](./pypi-workflow-gate.md) |

### npm workflow-gate notes

| Property | Contract / reference |
| --- | --- |
| Use | Built CI tarballs, GitHub-enforced pause, or gate before `npm stage publish` |
| Candidate | Uploaded npm pack tarball; detect archive `package.json`, validate identity/version |
| Grouping | One tarball per package release; baseline/findings/diff/risk reuse staged adapter projection |
| Dependency readiness | While the gate is pending, completed npm reviews check runtime dependencies are installable; matching packages in the same gated release satisfy each other's dependencies because the gate releases them together. [Dependency readiness](./npm-staged-publishing.md#dependency-readiness) is advisory. |
| Workflow | [Canonical npm workflow](./examples/npm-workflow-gate.yml): `npm-release-candidates` upload; `production` Environment |
| Integrity | Build writes `SHA256SUMS`; publish runs `sha256sum --check --strict SHA256SUMS` before `npm publish *.tgz` |
| Checksum file | Adapter ignores bundle `SHA256SUMS` because it is not a tarball |
| Automated publishing | [npm trusted publishing](./npm-trusted-publishing.md): pin OIDC to gate Environment, disallow tokens |
| Interactive publishing | npm still permits account password, 2FA, and OTP publication |
| Digest fallback | `summary.stagedPublish` has `sha1` beside SHA-256 `digest`; SHA-1 is absent from manifest and `provenance` |
| Publication comparison | Monitor may compare npm `dist.shasum` when published bytes are too large/slow to hash; absent `sha1` means SHA-256 only |

#### Gated staging

| Property | Contract / owner |
| --- | --- |
| Protected command | `npm stage publish *.tgz`; stage-only trusted publisher pinned to gate Environment |
| Authority | GitHub holds enforced gate; npm then holds reviewed bytes until maintainer 2FA approval |
| Stage review | Drydock still discovers/scans stage; computes SHA-256 alongside npm SHA-1 |
| Record | `summary.gateContinuity`: `matched`, `gate-not-approved`, `digest-mismatch`, `unverified`, `ungated`, `unknown` |
| Evaluation / UI | `server/lib/scan/gate-continuity.ts`; `server/lib/scan/gate-continuity-record.ts` |
| History | `loadGateReviewHistory`: organization-scoped `workflow_gate` scans for npm stage's package, constrained to staged adapter ecosystem |
| Ecosystem proof | Gate provenance, or stage-id ecosystem segment for incomplete scans; same-name PyPI gate is never npm evidence |
| `ungated` | Requires still-live target or any live target for same repository; npm/auto-detect on active installation |
| Retirement | Deleted target or uninstalled App retires target evidence |
| Recipe / status meanings | [Gated staging](./npm-staged-publishing.md#gated-staging-compose-both) |

### VS Code workflow-gate notes

| Property | Contract / reference |
| --- | --- |
| Artifact | Uploaded `.vsix`, parsed through shared ZIP sandbox |
| Identity | `extension/package.json`: `publisher.name` + `version`; safe identity fields, constrained `engines.vscode` required |
| Review tree | Strip `extension/` prefix |
| Grouping | One VSIX per extension release; case-only duplicates fail closed |
| Baseline | Best-effort public Marketplace; credential-free downloads restricted to allowed Marketplace / `*.gallerycdn.vsassets.io` assets |
| Findings | Metadata mismatches, broad startup activation, startup remote-command/WebAssembly loaders, undeclared configuration reads, transitive extension installs |

```yaml
jobs:
  package:
    steps:
      - run: npm ci
      - run: npx @vscode/vsce package --out dist/extension.vsix
      - uses: actions/upload-artifact@v4
        with:
          name: vscode-release-candidate
          path: dist/*.vsix
  publish:
    needs: package
    environment: production
    steps:
      - uses: actions/download-artifact@v4
        with:
          name: vscode-release-candidate
          path: dist
      - run: npx @vscode/vsce publish --packagePath dist/*.vsix
```

### Workbench

| Surface / limit | Contract | Owner |
| --- | --- | --- |
| Review | Target, package/version, artifacts, status, findings, changed files, accept/reject | `src/models/scan-detail-model.ts` |
| Lookup start | After gate scan completes or fails | Same model |
| Retry cap | Six attempts; exponential delays capped at 30 seconds | `GATE_LOOKUP_MAX_ATTEMPTS`, `GATE_LOOKUP_MAX_DELAY_MS` in same model |
| Lifecycle | One request at a time; pause hidden tab; stop on load/page close | `test/scan-detail-gate-polling-model.test.ts` |
| Exhaustion | Explain lookup stopped; **Retry lookup** starts fresh bounded attempt | Same test |

## Invariants

1. **Enforced** covers only jobs targeting the configured Environment while its rule remains installed; repository admins may remove it (`server/lib/github-app/setup-status.ts`).
2. Uncheck GitHub's default-on **Allow administrators to bypass configured protection rules** to prevent administrator bypass; see [publisher setup](./publisher-setup.md).
3. Drydock never publishes; it only posts GitHub's deployment-protection decision (`server/lib/workflow-gates/decision-delivery.ts`).
4. Gate state and decisions remain organization-scoped (`server/routes/github-app/workflow-gates.ts`).
5. Callback resolves to original installation, repository, run, Environment, and callback URL (`server/lib/github-app/webhook.ts`, `server/lib/workflow-gates/resolve.ts`).
6. Accepting one package never approves another (`server/routes/github-app/workflow-gates.ts`).
7. Missing/invalid candidate evidence fails closed (`test/workers/workflow-gate-prepare.test.ts`).
8. Rebuilding/repacking after approval breaks the review boundary; GitHub artifact immutability plus trusted publish job carry continuity (`server/lib/github-app/artifacts.ts`).
9. Checksum enforcement holds only while the repository job keeps the check and publishes that file; registries consume no Drydock digest constraint ([canonical npm workflow](./examples/npm-workflow-gate.yml)).
10. AI review is advisory; AI cannot downgrade deterministic findings (`server/lib/scan/pipeline.ts`).
11. atpm has no Drydock gate, approval, or release watch; use its anonymous review link ([atpm](./atpm.md)).
12. [Publication monitoring](./publication-monitor.md) supplies post-publication evidence only for explicitly enrolled public npm packages; it expands neither gate authority nor PyPI/VS Code outcome coverage.

13. Validation errors remain actionable without exposing credentials or private package bytes (`server/lib/workflow-gates/prepare.ts`, `server/lib/platform/observability.ts`).
14. Linking an installation requires the authorizing GitHub user to own its account: an active organization owner (`GET /user/memberships/orgs/{org}`, `role: admin`) or the user account itself (`GET /user`, by id). Repository access is not enough, and any other GitHub answer fails closed (`server/lib/github-app/oauth.ts`).
15. A verified owner may move an installation linked to another organization. One batch removes that organization's release targets, workflow gates, dependency reviews, and setup jobs for the installation and audits both organizations (`transferInstallation`). Its past workflow-gate scans and reports stay, with `gate_id` cleared. Links made before this check were not re-verified.

## Failure modes

| Symptom / condition | Cause | What happens | Fix |
| --- | --- | --- | --- |
| Invalid candidate evidence | Missing bundle, bad identity/version, duplicate package artifact | Reject; `github_workflow_gate.rejected_artifact_error` | Fix uploads, rerun workflow |
| Processing/scan failure | Sandbox/parser or scan error | Held/rejected, never fail open; `github_workflow_gate.review_failed` | Inspect safe error; retry eligible batch |
| npm baseline missing | Missing/invalid connection or registry error | Full-tree review; `baseline-unavailable` | Restore access or review whole artifact |
| VS Code baseline missing | Metadata/download/parse/identity failure | No-baseline review; unreadable version list is `metadata-unavailable`, never first-publish evidence | Restore access or review whole artifact |
| PyPI baseline over budget | Bounded download | `comparisonSkipped: "baseline-too-large"`; findings `unknown` package context; `manual_review` recommendation | Review with missing comparison disclosed |
| PyPI baseline metadata absent / no comparable release | Supported empty comparison | No-baseline review | Inspect disclosed baseline reason |
| PyPI acquisition throws | Unhandled download/parse failure | Review fails; no automatic approval | Inspect error, retry |
| Callback fails | GitHub delivery error | Durable decision retained; `github_workflow_gate.redelivery_failed`; queue retries when bound; otherwise next human/cron touch; job held until delivery | Restore callback access; redeliver |
| PR exists, gate inactive | Missing rule or matching target | Setup checker reports separate unmet conditions | Complete setup; verify first real review |
| Installation moved to another organization | A GitHub owner of the account linked it elsewhere | Previous organization loses its targets, gates, reviews, and setup jobs for it; its past gate scans stay, unlinked; pending deployments wait for the new owner or GitHub's timeout | New owner maps targets and re-runs the workflow |

## Change checklist

New ecosystem capabilities follow the [adapter skill](../.claude/skills/add-ecosystem/SKILL.md): derive candidates from bytes, acquire namespace-matched baselines, register adapters, add deterministic rules and Worker/adapter tests, and cover changed publish/review flows with fake-registry e2e tests.

| If you change… | Also update… | Run… |
| --- | --- | --- |
| Delivery/decision/callback | [Security](./security-model.md), [publisher setup](./publisher-setup.md) | `pnpm test -- test/workers/github-webhook.test.ts test/workers/workflow-gate-job.test.ts --project workers` |
| Identity/grouping/adapter | Ecosystem guide and [repository map](./repository-map.md) | `pnpm test -- test/workers/workflow-gate-prepare.test.ts --project workers` |
| npm example | [Canonical YAML](./examples/npm-workflow-gate.yml), [trusted publishing](./npm-trusted-publishing.md), [staging](./npm-staged-publishing.md) | `pnpm test -- test/workers/workflow-gate-npm.test.ts --project workers` |
| Lookup | Retry lifecycle/exhaustion UI | `pnpm test -- test/scan-detail-gate-polling-model.test.ts --project node` |
| Deployment bindings | GitHub App credentials, webhook secret, installation access, queues, D1, R2, scan bindings in [self-hosting](./self-hosting.md) | Follow [release safety](./release-safety.md) |
