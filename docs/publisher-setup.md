# Guided publisher setup

Publisher setup inspects an installed repository and prepares an independently reviewed draft workflow PR. **Authority:** advisory. **Owner:** `server/lib/github-app/setup-jobs.ts`.

## At a glance

| Thing | Owner file | Who may call / trigger | Pinned by (test) |
| --- | --- | --- | --- |
| Settings → Integrations → GitHub App → Prepare a release workflow | `src/features/publisher-setup/PublisherSetup.tsx` | Organization owner/admin | `test/workers/publisher-setup-jobs.test.ts` |
| Setup checks for coding agents | `src/features/publisher-setup/agent-summary.ts` | Maintainer copies session-bound checks | `test/publisher-setup-agent-summary.test.ts` |
| Model: GLM 5.3 Flash (`AI_MODEL`) | `server/lib/ai-review/index.ts` | Setup agents | `test/publisher-setup-agent.test.ts` |
| Inspection and PR writes | `server/lib/github-app/setup-api.ts` | Authorized job | `test/publisher-setup.test.ts` |
| Investigation, implementation, judge | `server/lib/github-app/setup-agent.ts` | Durable job; native function tools | `test/publisher-setup-agent.test.ts` |
| Private workspace | `server/lib/github-app/setup-agent-tools.ts` | Drafter; judge read-only | `test/publisher-setup-agent-tools.test.ts` |
| Static checks | `server/lib/github-app/setup-agent-validation.ts` | Submission / PR writes | `test/publisher-setup-agent-validation-bypass.test.ts` |
| Durable execution | `server/workflows/publisher-setup.ts` | `PUBLISHER_SETUP_WORKFLOW` | `test/workers/publisher-setup-jobs.test.ts` |

## Contract

### Setup sequence

| Step | Result / maintainer action |
| --- | --- |
| Prepare | One explicit action authorizes repository inspection, proposed workflow/script edits, independent review and automatic draft PR creation. |
| Review | Review complete GitHub diff before merging, pushing a commit or rerunning checks that can use repository secrets. |
| Configure | Add the Drydock custom deployment-protection rule to selected GitHub Environment; bind registry trusted publishing to it. See [workflow gates](./workflow-gates.md). |
| Map | Map repository/environment/ecosystem/artifact as a release target; remove conflicting mappings explicitly. |
| Verify | Run a real release; refresh setup checks. Requested gate, observed Environment rule and completed pre-publication review are separate states. |
| Completion | Already-published review does not finish setup; a draft PR does not establish release protection. |

### Settings UI states

| State | UI |
| --- | --- |
| Unreachable / current step | Unreachable shows only its label; instructions only while current; controls once reachable; errors inside the failing step. |
| No supported workflow | Warning plus secondary links to GitHub's `.github/workflows` editor and the workflow examples. |
| Job running or PR exists | Step 1 folds to a mono summary with `Change` (locked while running); `Cancel preparation` stops the job. |
| Draft ready | GitHub review link leads, then the advisory second review; changes under `View workflow changes`; `Prepare another draft` folded. |
| Primary action | `Prepare draft pull request` while there is a workflow to draft; then `Check setup status`; restored failed/gone job: `Inspect workflows`; after checks: `Map this release target` until mapped, then `Open pre-publish review` once a review completed. |
| Verified | Step 3 states the verified environment and repository; step 2 keeps only the PR link; recheck is secondary. |
| Failures | Gone job is `warn`, others `critical`, stated once; missing permission links to the installation's GitHub permissions. |
| Manual mapping | Native `Map a release target manually` disclosure under mapped targets; secondary submit. Installations are one line each. |

### Agent handoff

| Surface / condition | Contract |
| --- | --- |
| Copy for your agent | Copies plain text with repository, Environment, passed-check count and every check's label, status and detail; excludes gate and scan IDs. |
| Text for your agent | Shows the same text for a maintainer to give a coding agent following the `/agents` setup prompts. |
| Configuration pending / unknown | Closing line says "Not ready" until target mapping, Environment, protection rule and disabled administrator bypass all pass. |
| Configuration passes; first review incomplete | Closing line reports "ready, pending first release" until a real release completes review. |
| First review complete | A completed scan proves neither a real release nor approval; the closing line asks to confirm a real release instead of declaring setup complete. |
| Access | Drydock exposes no agent-callable setup API; checks require the owner/admin session. |

### HTTP surface

All endpoints require session, verified email when configured, organization owner/admin role and organization-scoped access. Owner: `server/routes/github-app/setup.ts`.

| Method | Path | Input / result | Additional requirement |
| --- | --- | --- | --- |
| POST | `/api/v1/github-app/setup/inspect` | Installation/repository → pinned workflow inspection | Organization-owned installation |
| POST | `/api/v1/github-app/setup/draft` | Scope/workflow/revision/environment/ecosystem + `createPullRequest: true` → `202 { job }` | Explicit PR authorization persisted |
| GET | `/api/v1/github-app/setup/draft-jobs/:id` | Safe progress, private feedback/verdict, ready PR/file diff when available | Creator only; `Cache-Control: no-store` |
| POST | `/api/v1/github-app/setup/draft-jobs/:id/cancel` | Cancel pending preparation → current status | Creator only; `Cache-Control: no-store` |
| POST | `/api/v1/github-app/setup/status` | Scope/environment/ecosystem → independent configuration and scoped release-review checks | Organization-owned installation |

| Limit | Value | Constant / file |
| --- | --- | --- |
| Inspect/status | 60/hour/organization | `RATE_LIMITS.read`, `server/routes/github-app/setup.ts` |
| Preparation | 20/hour/organization | `RATE_LIMITS.draft`, `server/routes/github-app/setup.ts` |
| Poll/cancel shared | 120/minute/creator/organization | `RATE_LIMITS.poll`, `server/routes/github-app/setup.ts` |
| Request body | 200,000 bytes | `bodyLimit.maxSize`, `server/routes/github-app/setup.ts` |
| Active jobs | 2/organization; older than 30 minutes excluded | `MAX_ACTIVE_JOBS_PER_ORGANIZATION`, `SETUP_JOB_WALL_MS`, `server/lib/github-app/setup-jobs.ts` |
| Expiry | One day | `JOB_TTL_MS`, `server/db/publisher-setup-jobs.ts` |

### Budgets

| Limit | Value | Constant / file |
| --- | --- | --- |
| Draft/judge turns | 64 / 48 | `SETUP_DRAFT_MAX_TURNS` / `SETUP_JUDGE_MAX_TURNS`, `server/lib/github-app/setup-agent.ts` |
| Model call | 180 seconds; clipped to remaining time/output | `AbortSignal.timeout`, `server/lib/github-app/setup-agent.ts` |
| Shared job | 20 minutes including source inspection; 1,500,000 input / 80,000 output tokens | `MAX_DURATION_MS`, `MAX_INPUT_TOKENS`, `MAX_OUTPUT_TOKENS`, `server/lib/github-app/setup-agent.ts` |
| Draft share | 12 minutes; 900,000 input / 56,000 output tokens | `JUDGE_RESERVE`, `PULL_REQUEST_RESERVE_MS`, `server/lib/github-app/setup-agent.ts` |
| Judge cutoff | 18 minutes; 2 minutes for PR creation | `PULL_REQUEST_RESERVE_MS`, `server/lib/github-app/setup-agent.ts` |
| Review size | 10 pages × 12,000 chars; larger of each file's before/after text | `SETUP_REVIEW_MAX_PAGES`, `SETUP_REVIEW_PAGE_CHARS`, `server/lib/github-app/setup-agent-tools.ts` |
| Directory listings | Shared 2,000 entries for tools and PR creation | `SETUP_TREE_MAX_ENTRIES`, `server/lib/github-app/setup-api.ts` |
| Per-agent reads | 200 requests / 2 MiB decoded source | `MAX_READS`, `MAX_READ_BYTES`, `server/lib/github-app/setup-agent-tools.ts` |
| Files | 64 KiB each; selected workflow + up to 12 supporting files; 256 KiB proposed content | `MAX_FILE_BYTES`, `MAX_CHANGED_FILES`, `MAX_CHANGED_BYTES`, `server/lib/github-app/setup-agent-tools.ts` |
| Investigation cutoff | 12 drafting turns without changed files | `runSetupAgentTurn`, `server/lib/github-app/setup-agent.ts` |
| Source bundle | 96 KiB | `MAX_SOURCE_BYTES`, `server/lib/github-app/setup-agent-handoff.ts` |
| Plan | Asked under 4,000; shortened at 6,000 chars | `setupInvestigationPlanSchema`, `server/lib/github-app/setup-agent-handoff.ts` |
| PR summary | Asked under 600; shortened at 1,000 chars | `submit_changes`, `server/lib/github-app/setup-agent-tools.ts` |
| Issues / blocker | Shortened at 500 / 1,000 chars | `finish_review` / `report_blocker`, `server/lib/github-app/setup-agent-tools.ts` / `server/lib/github-app/setup-agent.ts` |
| Compaction | Older than last 9 messages (normally 3 turns); >48,000 removable chars | `RECENT_MESSAGES`, `COMPACT_AFTER_CHARS`, `server/lib/github-app/setup-agent-context.ts` |
| Durable step | Four-minute deadline; at most one transient retry | `timeout`, `retries.limit`, `server/workflows/publisher-setup.ts` |

Discovery/diff tools paginate; each turn includes remaining time/turn/token allowances. Judge resends read pages each turn. Oversized model prose is shortened at a sentence boundary; other rejected input returns field issues without echoed arguments.

Compaction elides older tool output, staged text and reasoning, retaining paths/revisions/call IDs. Bundled source leaves active context after validation; private workspace retains every file for rereading.

## Invariants

1. Browser polls the creator-owned job after `202` and resumes pending work after refresh. Owner: `src/models/publisher-setup.ts`.
2. Agents never execute inspected repository/package code, generated scripts, builds or lifecycle scripts; no shell, installs, imports, arbitrary network or GitHub mutation tool. Tool surface: `server/lib/github-app/setup-agent-tools.ts`.
3. Tools select only installed repository at inspected commit, never another repo/ref/URL/local path; Git tree modes/blob identities prevent symlink dereferencing. Boundary: `server/lib/github-app/setup-api.ts`.
4. Concurrent tools serialize and reject stale edits. Owner: `server/lib/github-app/setup-agent-tools.ts`.
5. Job never merges, configures Environment protection, approves release or publishes. GitHub write surface: `server/lib/github-app/setup-api.ts`.
6. Time wall/AI killswitch apply until PR creation starts, checked again before first write; afterward own step deadline bounds creation, and time/killswitch cannot make an existing branch/PR a restartable failure. Owner: `server/lib/github-app/setup-jobs.ts`.
7. Cancellation binds checks before every GitHub write; atomically refused after PR creation starts; finished jobs retain PR. Pinned by (test) `test/workers/publisher-setup-jobs.test.ts`.
8. Events allow only codes, stages, durations and bounded provider metadata, never source/tokens/messages/raw exceptions. Incomplete turns record finish status and numeric usage/duration. Owners: `server/lib/github-app/setup-draft-errors.ts`, `server/lib/github-app/setup-agent.ts`.

### Agents

Owner: `server/lib/github-app/setup-agent.ts`.

1. Investigation: Discover actual release scripts, manifests, workspace config and lifecycle hooks; no fixed helper/template. Follow release call graph; ignore repository agent instructions and unrelated product docs.
2. Reads: List directories; pinned regular UTF-8 reads singly/in bounded batches; cached source/change inventories and budgets; literal search in selected files.
3. Edits: Stage contents, revision-check edits, inspect diff, validate and submit complete change in private workspace; no GitHub writes.
4. Semantics: Preserve Changesets versioning, custom package selection, builds/packing, staged/direct publication, access/dist-tags and Git tags/releases.
5. Judge: Fresh conversation, frozen digest, read-only tools, paginated full before/after diffs; inspect every changed file completely before pass.
6. Review scope: Follow original/proposed call paths for build-before-gate, exact artifact publication, credentials, package selection and release semantics.
7. Verdict: Binds submitted digest; changed workspace invalidates review.
8. Files: Generated scripts are ordinary PR files; Settings shows original/proposed contents.
9. Handoff: At the investigation cutoff, only source-grounded advisory plan or blocker; required tool call at low reasoning effort.
10. Implementation: Fresh editing brief with plan, whole pinned source bundle and edit revisions; omitted files readable. `openQuestions` only facts specific edits need.
11. Context: Investigation transcript stays private, excluded from implementation context; shared time/token/source/edit budgets carry through; editor tool choice automatic.
12. Revisions: Bundled files need no reread; other existing files need last read/edit revision. New-file lookup proves absence; existing path returns `file_exists_read_first`.
13. Submission: Validate, inspect diff and submit with PR summary.

### Static validation

Owner: `server/lib/github-app/setup-agent-validation.ts`.

1. YAML: Valid syntax, no aliases; unchanged triggers/defaults; literal protected Environment; known publishers outside gate checked.
2. Changed files: Only selected workflow plus new `.mjs`, `.cjs`, `.js`, `.sh`, `.py`, `.json` under `.github/`, outside `workflows/`, `actions/` and directories with `action.yml` or `action.yaml`.
3. Existing files: Supporting files, manifests, lockfiles, registry config, `.gitattributes`, CODEOWNERS unchanged; nothing may already reference a new file.
4. Paths: `validSetupFilePath` in `server/lib/github-app/setup-api.ts` bounds repository paths; `SUPPORTING_FILE` restricts new support paths. Reject case-only collisions on case-insensitive checkouts.
5. Review events: Refuse selected workflow with `pull_request_review` or `pull_request_review_comment`: PR-owned workflow runs before review.
6. Actions: Inspected actions plus `actions/*` and common release setup actions; new references use release tags (`v4`, `release/v1`), not SHAs that can identify fork imposter commits.
7. Images: Container/service images already in inspected workflows only.
8. Inherited secrets: Refuse `secrets: inherit` unless original job had it for the same reusable-workflow `uses`.
9. Secret references: Only already in selected workflow; parsed strings checked too so YAML escapes cannot hide expressions. `GITHUB_TOKEN` always allowed.
10. Permissions: No write scope absent from original; `id-token: write` only on protected job, never workflow-wide or drafted unprotected job; build-job attestations/Sigstore signing refused.
11. Registry tokens: `NPM_TOKEN`, `NODE_AUTH_TOKEN`, PyPI, `VSCE_PAT`, etc. only in protected job.
12. Runner: GitHub-hosted label or original `runs-on`.
13. Producer: Unprotected upstream producer uploads named candidate; protected job depends on it.
14. Download: Exactly named current-run artifact into dedicated directory; candidate cannot overwrite checkout or supply `.npmrc`/`uv.toml` config.
15. Protected actions: Checkout, toolchain setup, download, `pypa/gh-action-pypi-publish`, `changesets/action`, allowlisted inputs; other inspected actions exactly as originally used.
16. Shell allowlist: Checksums, git identity/tag/push, `set`/`echo`, publisher CLI install, publishers over candidate-directory files (npm `.tgz`, PyPI distributions, `.vsix`), reviewed `.github/` scripts from checkout made before download.
17. Shell scope: Same checks apply to changesets `publish` input.
18. Protected refusals: Redirection, command substitution, `${{ }}`, `$GITHUB_ENV`/`$GITHUB_PATH`, `working-directory`, containers, services, strategies.
19. Config refusals: New/changed loader/package-manager env values (`BASH_ENV`, `NODE_OPTIONS`, `HOME`, `XDG_*`, `NPM_CONFIG_*`, `UV_*`, etc.) are refused; identical original values may remain. Registry/config flags and credential-bearing URLs are refused. URLs must use package-registry hosts or hosts already present in the original workflow.
20. Unchanged job: Original protected job may stay unchanged only if it neither publishes, holds registry credentials nor has `id-token: write`.

Static checks cannot prove arbitrary script semantics; judge and maintainer review remain necessary.

### Persistence and PR creation

Owner: `server/lib/github-app/setup-jobs.ts` and `server/lib/github-app/setup-api.ts`.

1. Durable turn: Load private state; model/tools run on local copy; save transcript/workspace atomically before checkpoint. Failed call cannot persist half a turn.
2. Native context: Preserve GLM reasoning bytes/order in expected native field across tool turns; never mix with visible assistant text.
3. Workflow: Parameters/results contain opaque job IDs and completion metadata only; never source/conversations.
4. Storage: Organization-scoped private R2: source, proposed files, transcripts, tools, feedback, verdicts. D1: request/authorization metadata, safe status/failure codes and expiry.
5. Deletion: Account/organization deletion and scheduled retention sweep remove private data; late writes cannot revive revoked/expired/deleted jobs.
6. Preconditions: Recheck submitted digest, validation, matching assessment, creator membership/verified-email policy, organization installation, AI killswitch, expiry and pinned source immediately before GitHub mutations.
7. Authorization: Persisted `createPullRequest: true` required; old requests/jobs without it cannot write.
8. Grants: Check installation's Contents, Pull requests and Workflows write permissions before model work; App operator and installation owner grant them; Drydock never expands grants.
9. Tokens: Source reads use read-only tokens; only PR creation mints write token; revoked best-effort when step ends. Repository-scoped `api.github.com` only; redirects refused.
10. Commit: Atomic Git tree/commit rooted at pinned source; verify existing modes, original blobs and before contents.
11. Recovery: Stable branch derives from complete change set; bounded recovery verifies every path/byte, refuses collaborator edits.
12. HTTP retries: No blind mutation retries; installation-token minting retries transient failures.
13. Branch: Create at pinned base then move to setup commit: `create` workflows see reviewed base. `[skip ci]` suppresses ordinary push/PR runs, not all automation.
14. PR body: Summary code block and Environment code span prevent mentions/issue closure.
15. Audit: New/recovered PRs share idempotent identity: repository, Environment and PR number only.

### Prefix caching

Owner: `server/lib/github-app/setup-agent.ts`.

1. Stable prefix: Instructions, tools and existing messages byte-stable within phase; current budgets/guidance append at end, checkpoint with native results.
2. Cold boundaries: Investigation, handoff, implementation and judge use separate stable affinity keys.
3. Affinity: Native Workers AI `x-session-affinity` derives from opaque job scope/role/model, stable on retries/reconstruction; no repo/org/user labels; no extra KV/binding.
4. Gateway: Full-response cache disabled (`cf-aig-skip-cache: true`), distinct from prefix caching; payload logging disabled.
5. Usage: Numeric cached-input usage in private state/events when reported; missing unknown; all input counts toward budget. Affinity guarantees neither retention nor hits.

## Failure modes

| Condition | Cause | Result | Fix |
| --- | --- | --- | --- |
| Third draft | Active-job cap | `409 setup_jobs_busy` | Finish/cancel pending job |
| Oversized body | Body cap | `413 setup_request_too_large` | Reduce request |
| AI unavailable | Missing AI / disabled `ai-review` | `503 setup_ai_unavailable` | Operator enables AI; otherwise use [workflow guide](./workflow-gates.md) |
| Invalid input/static failure | Contract violation | Corrective tool feedback | Repair issues |
| Missing evidence/budget reached | Cannot establish behavior | Feedback, no invented behavior | Supply evidence/simplify change |
| Negative judge/unfinished work | No approved complete change | No PR | Review feedback |
| Whole output allowance spent reasoning without tool | Model overrun | Charged; retry once with correction; second ends job | Inspect safe metrics |
| Runtime termination | Workflow ends without terminal job result | Safe failed status; no runtime payload; preserve concurrent completed result | Resume/retry as offered |
| Prolonged poll failure | Browser cannot follow job | Stop polling, offer resume; repo/workflow/ecosystem/Environment locked pending | Resume same job |
| Cancel pending | Creator request | Failed; private payloads deleted; Workflow terminated | Start another job if needed |
| Cancel during PR creation | Cutoff reached | Refused; browser follows same job to PR | Review PR |

## Change checklist

| If you change | Also update / run |
| --- | --- |
| Tools, budgets, context | `test/publisher-setup-agent-tools.test.ts`, `test/publisher-setup-agent-context.test.ts`, `test/publisher-setup-agent-handoff.test.ts` |
| File/credential restrictions | `test/publisher-setup-agent-validation.test.ts`, `test/publisher-setup-agent-validation-allowlist.test.ts`, `test/publisher-setup-agent-validation-bypass.test.ts` |
| GitHub boundary | `test/publisher-setup.test.ts` |
| Auth, cancellation, retention, durable execution | `test/workers/publisher-setup-jobs.test.ts`; [release safety](./release-safety.md) |
| UI/completion states | `src/models/publisher-setup.ts`, `src/features/publisher-setup/PublisherSetup.tsx`; [workflow gates](./workflow-gates.md) |
| Agent handoff text | `src/features/publisher-setup/agent-summary.ts`, `test/publisher-setup-agent-summary.test.ts`, `test/e2e/publisher-setup.spec.ts` |
| This doc | `pnpm run verify:file docs/publisher-setup.md` |

## Why

Repository text can steer models; CI, hooks and package managers can run changed files before review. Restricted edits narrow exposure, while judge and maintainer assess script semantics. See [Workers AI prompt caching](https://developers.cloudflare.com/workers-ai/features/prompt-caching/) for native prefix-cache behavior.
