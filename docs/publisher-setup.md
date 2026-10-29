# Guided publisher setup

Organization owners and admins can open **Settings → Integrations → GitHub App → Set up a release workflow** to inspect an installed repository, draft changes to an existing release workflow, and explicitly request a draft pull request. CI publishers can enter the same flow from the first-review panel.

## Flow

1. Select an active GitHub App installation and an accessible repository. Inspection reads at most 12 regular UTF-8 `.github/workflows/*.yml` or `*.yaml` files, at most 48 KB each, from a pinned default-branch revision. Drydock does not execute source, workflows, builds, package code, or dependencies.
2. Select the release workflow, ecosystem, and GitHub Environment, then start drafting. The request returns `202` with a job id immediately after dispatch to Cloudflare Workflows. The browser polls the creator-owned job and can resume polling after a reload. No AI request runs inside the HTTP handler.
3. The durable job fetches the pinned workflow, drafts proposed YAML, applies deterministic checks, and asks a fresh model call to independently judge the original and proposed workflows. The judge receives neither the drafter's conversation nor its explanation. A negative assessment stops the job with actionable issues; it never creates a signed proposal.
4. Review the complete original/proposed diff and the independent assessment. Only a candidate that passes deterministic validation and the judge receives a signed proposal. The user must still explicitly confirm the diff before requesting a draft PR.
5. Configure the GitHub Environment and its Drydock custom deployment-protection rule, then map the selected ecosystem and artifact name as a release target. Existing conflicting mappings must be removed explicitly before remapping.
6. Run a real release and refresh setup checks. An observed workflow gate and a completed release review are separate states. Reviewing an already-published package does not complete publisher setup.

## Model and durable execution

Both drafting and judging use GLM 5.3 Flash (`@cf/zai-org/glm-5.3-flash`). The drafter returns plain YAML, avoiding JSON escaping/constrained decoding around a complete code file; the server supplies a neutral summary. The independent judge returns a bounded structured assessment. Both are advisory, use the existing AI Gateway with payload logging disabled, and have individual 180-second timeouts. Each Workflow model step has a four-minute deadline and at most one retry for a transient timeout, capacity, or provider failure. Invalid drafts and negative judgments are not retried or repaired automatically.

The stages are `fetch_source`, `draft`, `validate`, `judge`, and `ready`. Workflow parameters, checkpoint results, and the final run result contain only an opaque job id. D1 stores request metadata, current status/stage, safe failure codes/messages, and a one-day expiry. Original source, the candidate, judge evidence, and signed result stay in the private artifact bucket under the organization's `publisher-setup` prefix; they do not enter Workflow checkpoint history. Completed results are returned only by the authenticated, organization-admin, creator-owned job endpoint.

Each attempt rechecks the creator's account, current organization role, active installation, job expiry, and the organization's `ai-review` killswitch. These checks run again before storing a model result and before signing. A revoked or deleted job cannot be revived by a late storage write. Account deletion removes authored jobs and their private objects; organization deletion removes job metadata and its artifact prefix. The scheduled retention sweep removes expired job payloads and then metadata in bounded batches. Expired jobs are inaccessible before the storage sweep runs.

A deployment without `PUBLISHER_SETUP_WORKFLOW` returns an actionable `503` instead of running an inline or `waitUntil` fallback. Queueing does not modify GitHub. No Workflow step opens a PR, alters an Environment, or changes a release decision.

## Draft limits and authority

The proposed replacement preserves existing triggers and separates build/package from publishing. Validation checks a producer artifact upload before the review environment, the publish job's dependency on that producer and literal environment, and a matching current-run artifact download before publishing those archives. It accepts the supported ecosystem guide shapes, including reviewed relative artifact directories, digest verification, existing action SHA pins, npm CLI setup before download, and PyPI's trusted-publishing action. Complex publishers and unsupported triggers require manual setup.

These checks and the independent model verdict do not prove arbitrary workflow semantics. Review build commands, conditions, provenance, package selection, permissions, secrets, and other release paths before merging. AI findings cannot relax deterministic checks. A draft must preserve existing secret references without introducing new ones.

The generated commit includes `[skip ci]`. Push and `pull_request` checks may need another commit or an explicit rerun before merging. The PR does not configure an Environment or enable protection rules. GitHub protects only the configured job; other workflows, manual publishing, and administrator bypass remain separate paths.

Inspection requires repository-scoped Contents and Actions read permissions. **Create draft PR** separately requests a repository-scoped token with Contents, Pull requests, and Workflows write permissions. The operator must configure these optional App permissions, and the repository owner must approve the installation update; Drydock never silently expands an installation. If write access is unavailable, copy the reviewed draft and open a PR manually.

PR creation verifies the judge-gated v2 proposal signature, its user/organization scope and expiry, then rechecks the default revision and original blob. Legacy unjudged signatures are invalid. A stable proposal branch recovers an existing PR or a partially completed one-file write; additional edits on that branch are never overwritten. Mutations are not automatically retried. Credentials stay server-side on `api.github.com`, redirects are refused, and reads are bounded. The audit event records only repository, environment, and PR number.

## Setup checks and HTTP

Checks independently report the selected release target, Environment existence, this exact Drydock App's enabled protection rule, administrator bypass, and a real workflow-gated review. Target matching includes installation, repository, environment, selected ecosystem, and artifact name. History lookup is restricted to that target and organization. GitHub permission/upstream failures are errors rather than evidence of absent protection.

Every endpoint requires a session, verified email when verification is configured, organization owner/admin role, and organization-owned installation. Job polling additionally requires the job's creator. Request bodies are capped at 200 KB. Inspection/status requests allow 60/hour/organization; drafting and PR creation each allow 20/hour/organization. Polling has a separate 120/minute creator/organization budget.

- `POST /api/v1/github-app/setup/inspect`: installation id and repository → `{ inspection }`, with pinned revision and eligible workflow files.
- `POST /api/v1/github-app/setup/draft`: selected scope, workflow/revision, environment, ecosystem → `202 { job }`. Queued responses contain metadata only.
- `GET /api/v1/github-app/setup/draft-jobs/:id`: `{ job }`, with status, stage, safe failure, independent assessment when available, and signed result only when ready. Responses use `Cache-Control: no-store`.
- `POST /api/v1/github-app/setup/pull-request`: exact signed proposal → `{ pullRequest }`, creating or recovering its draft PR.
- `POST /api/v1/github-app/setup/status`: selected installation, repository, environment, ecosystem → `{ status }` with independent setup checks.

Failed model attempts emit only model, stage, duration, category, bounded numeric provider/status codes, and an allowlisted finish reason. Logs and failure metadata never include raw provider errors, prompts, source, credentials, model text, or request/response bodies.
