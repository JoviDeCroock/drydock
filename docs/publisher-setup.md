# Guided publisher setup

Organization owners and admins can open **Settings → Integrations → GitHub App → Set up a release workflow** to inspect an installed repository and prepare a draft pull request. One explicit action authorizes repository inspection, proposed workflow/script edits, independent review, and automatic draft PR creation. Maintainers review the resulting diff in GitHub before merging.

## Repository agents

The drafting agent uses GLM 5.3 Flash with native function tools. It can list directories, read pinned regular UTF-8 files individually or in bounded batches, inspect cached source/change inventories and remaining repository budgets, search literal text in selected files, stage new file contents, make revision-checked edits, inspect the proposed diff, run static validation, and submit the complete change. It discovers the repository's actual release scripts, manifests, workspace configuration and lifecycle hooks; there is no fixed helper or repository template.

Tools operate only on the installed repository at the inspected commit. Paths cannot select another repository, ref, URL or local filesystem. Git tree modes and blob identities prevent symlink dereferencing. Edits remain in a private workspace and do not write to GitHub. Creating a new file requires a read proving that path is absent; editing an existing file requires its current read revision. Concurrent calls serialize and reject stale edits.

The agent follows repository-specific publishing behavior, including Changesets versioning, custom package selection, builds and packing, staged versus direct publication, access/dist-tags, and Git tags/releases. Its prompt provides investigation and editing recipes rather than prescribed release code. Generated scripts are ordinary files in the draft PR, with original/proposed contents visible in Settings.

An independent judge gets a fresh conversation, the frozen change digest, its own read-only repository tools, and paginated full before/after diffs. It must inspect every changed file completely before recording a pass. It can follow original and proposed call paths to assess build-before-gate, exact artifact publication, credentials, package selection and release semantics. The judge cannot edit files. Its verdict binds the same digest submitted by the drafter; a changed workspace invalidates the review.

Neither agent has a shell, dependency-install/build capability, repository imports, arbitrary network access, or a GitHub mutation tool. Drydock never executes inspected repository/package code or generated scripts. Static validation checks observable facts such as YAML syntax, unchanged triggers, secret references, a literal protected environment, current-run artifact download and producer dependencies, known publishers outside the gate, and explicit rebuild/install commands. It cannot prove arbitrary script semantics. The judge and maintainer review remain necessary, and a draft PR does not establish that a release is protected.

## Durable execution and budgets

Preparation returns `202` with a job ID; the browser polls its creator-owned status and resumes pending work after refresh. Cloudflare Workflows checkpoints pinned source reads, individual drafting/reviewing turns, validation and PR creation. A turn loads private state, runs the model and tools against a local copy, and saves the complete transcript/workspace atomically before the checkpoint. Failed calls cannot persist half a turn. Workflow parameters/results contain only opaque job IDs and completion metadata, never source or conversations.

Source, proposed files, transcripts, tool results, feedback and verdicts remain in organization-scoped private R2. D1 stores request/authorization metadata, safe status/failure codes and one-day expiry. Gateway payload logging is disabled. Account/organization deletion and the scheduled retention sweep remove private job data. A late write cannot revive a revoked, expired or deleted job.

Limits include 64 drafting turns, 48 judge turns, 180 seconds per model call, 20 minutes per job, 1,500,000 cumulative input tokens and 80,000 output tokens. Each agent's repository tools allow 200 requests and 2 MiB of decoded source. Files are limited to 64 KiB; a proposal can change the selected workflow and up to 12 supporting files, with 256 KiB of proposed content. Discovery/diff tools paginate results. Each model turn includes the remaining time, turn and token allowances. Investigation follows the release call graph and ignores repository agent instructions and unrelated product documentation. Reaching a budget or encountering missing evidence stops preparation with feedback rather than inventing repository behavior.

Each model turn is a durable step with a four-minute deadline and at most one transient retry. Calls are clipped to the remaining time/output allowance; completed usage and elapsed time are checked before accepting a terminal result. The shared clock starts at job creation, including source inspection. Invalid arguments or static failures return tool feedback for correction. The agent can explicitly report a blocker. Negative judgments and unfinished work open no PR. The browser stops automatic polling after prolonged failures and offers a resume action; hiding a job or changing selection does not revoke an already authorized server job.

## Draft PR creation

Successful preparation rechecks the submitted digest, static validation, matching independent assessment, creator membership/verified-email policy, organization installation, AI killswitch, expiry and pinned source. These checks run immediately before GitHub mutations too. The persisted `createPullRequest: true` marker is required; old requests/jobs without it cannot begin writing.

Write permission is checked before spending model work. Tokens remain repository-scoped on `api.github.com`; redirects are refused. Contents, Pull requests and Workflows write permissions must already be granted by the App operator and installation owner. Drydock never expands those grants.

All proposed files are committed atomically using a Git tree and commit rooted at the pinned source revision. Existing file modes, original blobs and before contents are verified. A stable branch derived from the complete change set permits bounded recovery after an uncertain response; recovery verifies every changed path and byte and refuses collaborator edits. Individual HTTP mutations are not blindly retried. New and recovered PRs share one idempotent audit identity containing repository, environment and PR number only.

The setup commit includes `[skip ci]`, which suppresses ordinary push/pull_request runs but does not guarantee that no GitHub automation runs. Review the complete diff and run required repository checks before merging. The job never merges, configures Environment protection, approves a release or publishes a package.

## Finish setup

Configure the selected GitHub Environment and Drydock custom deployment-protection rule, bind registry trusted publishing to that environment, and map the repository/environment/ecosystem/artifact as a release target. Existing conflicting mappings must be removed explicitly. Run a real release and refresh setup checks. A requested workflow gate, an observed Environment rule, and a completed pre-publication review are separate states; an already-published package review does not finish publisher setup.

## HTTP contract

Endpoints require a session, verified email when configured, organization owner/admin role, and organization-scoped access. Job polling additionally requires its creator. Inspect/status allow 60/hour/organization; preparation and compatibility PR creation each allow 20/hour/organization; polling has a separate 120/minute creator/organization budget.

- `POST /api/v1/github-app/setup/inspect`: installation and repository → pinned workflow inspection.
- `POST /api/v1/github-app/setup/draft`: selected scope/workflow/revision/environment/ecosystem and explicit `createPullRequest: true` → `202 { job }`.
- `GET /api/v1/github-app/setup/draft-jobs/:id`: safe progress, private feedback/verdict when available, and ready PR/file diff. Responses use `Cache-Control: no-store`.
- `POST /api/v1/github-app/setup/pull-request`: compatibility endpoint for an exact v3 signed proposal. Earlier signatures are invalid. Its body limit is 4 MiB for before/after file data; other setup bodies remain capped at 200 KB. File-count/content budgets still apply.
- `POST /api/v1/github-app/setup/status`: selected scope/environment/ecosystem → independent configuration and scoped release-review checks.

Unexpected runtime termination is reconciled to a safe failed status without exposing runtime error payloads or overwriting a concurrent completed result. Operational events contain only allowlisted codes, stages, durations and bounded provider metadata, never source, tokens, messages or raw exceptions.
