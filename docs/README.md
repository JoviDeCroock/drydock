# Docs map

Read one row, not the folder. User-facing guide: `src/pages/Docs/index.tsx` (keep it aligned with the docs below).

## Start by task

| I want to… | Read first | Then |
| --- | --- | --- |
| Run the app locally with no credentials | [`e2e-test-environment.md`](./e2e-test-environment.md) | `pnpm run e2e:dev:seed` |
| Find the code that owns a behavior | [`repository-map.md`](./repository-map.md) | the doc in that row |
| Know which tests a change needs | [`release-safety.md`](./release-safety.md) | `pnpm run verify:file <path>` |
| Find a command | [`tooling.md`](./tooling.md) |  |
| Understand the system | [`architecture.md`](./architecture.md) | [`security-model.md`](./security-model.md) |
| Touch auth, an anonymous route, an API key route, or egress | [`security-model.md`](./security-model.md) | [`api-keys.md`](./api-keys.md), [`two-factor-auth.md`](./two-factor-auth.md), [`organization-members.md`](./organization-members.md) |
| Change UI | [`design.md`](./design.md) | [`ui.md`](./ui.md), the Signals skill named in `tooling.md`, `verify-live` skill |
| Add or change a detection rule | [`security-detection-corpus.md`](./security-detection-corpus.md) | [`detection-eval.md`](./detection-eval.md), `add-detection-rule` skill |
| Change the AI reviewer | [`ai-review-eval.md`](./ai-review-eval.md) | [`security-model.md`](./security-model.md) |
| Add an ecosystem | [`architecture.md`](./architecture.md#ecosystems-and-capabilities) | `add-ecosystem` skill |
| Self-host or deploy | [`self-hosting.md`](./self-hosting.md) | [`artifact-storage.md`](./artifact-storage.md) |

## Release modes

| Mode | Authority | Ecosystems | Doc |
| --- | --- | --- | --- |
| Workflow Gate — enforced | GitHub holds the configured protected publish job | npm, PyPI, VS Code | [`workflow-gates.md`](./workflow-gates.md), [`pypi-workflow-gate.md`](./pypi-workflow-gate.md) |
| Stage Watchtower — advisory | npm approves; Drydock records advice | npm | [`npm-staged-publishing.md`](./npm-staged-publishing.md) |
| Gate setup (guided) | draft PR only; maintainer merges | npm, PyPI, VS Code | [`publisher-setup.md`](./publisher-setup.md) |
| npm trusted publishing pin | narrows npm OIDC to the gate environment | npm | [`npm-trusted-publishing.md`](./npm-trusted-publishing.md) |
| Dependency review — enforced when required | GitHub App check on same-repository PRs; holds capability changes until a repository writer approves, and what it could not read until it is old enough or approved | npm, PyPI | [`dependency-review.md`](./dependency-review.md) |
| Public diff | anonymous, advisory | npm, PyPI, atpm | [`public-diff.md`](./public-diff.md), [`atpm.md`](./atpm.md) |

Canonical npm gate workflow: [`examples/npm-workflow-gate.yml`](./examples/npm-workflow-gate.yml).

## Feature reference

| Doc | Owns |
| --- | --- |
| [`sandbox-parser.md`](./sandbox-parser.md) | archive limits, tar/zip reading rules, archive digests, sample retention |
| [`diff-baseline.md`](./diff-baseline.md) | previous-version selection and tarball/compare caching |
| [`intent-envelope.md`](./intent-envelope.md) | source-binding tiers (attested / declared / absent) |
| [`artifact-storage.md`](./artifact-storage.md) | D1 metadata + R2 report/artifact layout |
| [`release-memory.md`](./release-memory.md) | prior-release finding-profile consistency (advisory) |
| [`release-fingerprint.md`](./release-fingerprint.md) | `release.source-drift` rule |
| [`provenance-continuity.md`](./provenance-continuity.md) | `release.provenance-dropped` / `release.provenance-publisher-changed`: registry provenance compared between baseline and candidate |
| [`registry-version-status.md`](./registry-version-status.md) | npm lifecycle status of a staged version, forgotten-approval reminder |
| [`publication-monitor.md`](./publication-monitor.md) | public npm watches, direct releases outside staging |
| [`package-claims.md`](./package-claims.md) | canonical npm package ownership and migration audit |
| [`public-reports.md`](./public-reports.md) | share links, attestations, threat feed |
| [`public-badge.md`](./public-badge.md) | README badge states, opt-out, release lines |
| [`release-receipts.md`](./release-receipts.md) | Release Receipt v1 |
| [`agent-package-review.md`](./agent-package-review.md) | coding-agent quickstart: publisher setup prompts, dependency-review instruction, anonymous HTTPS recipe, read-only public MCP endpoint |
| [`api-keys.md`](./api-keys.md) | organization API keys: route allowlists by access level, auth rules, storage, lifecycle; [`openapi.json`](./openapi.json) contract |
| [`dependency-pr-diff-links.md`](./dependency-pr-diff-links.md) | Renovate preset + Dependabot/Renovate PR comment workflow (public contract) |
| [`dependency-review.md`](./dependency-review.md) | GitHub App check on dependency-update PRs: source and pin checks, hold policy and age fallback, approval authority, `dependency-review` rollout flag, limits |
| [`two-factor-auth.md`](./two-factor-auth.md) | 2FA enrollment, sign-in challenge, step-up |
| [`organization-members.md`](./organization-members.md) | roles, invitations |
| [`audit-log.md`](./audit-log.md) | organization audit log |
| [`account-deletion.md`](./account-deletion.md) | account deletion lifecycle |
| [`slack-notifications.md`](./slack-notifications.md) | Slack install and delivery |
| [`product-analytics.md`](./product-analytics.md) | Analytics Engine events and privacy posture |

## Quality and evals

| Doc | Owns |
| --- | --- |
| [`security-detection-corpus.md`](./security-detection-corpus.md) | rule inventory, fixture format, coverage gaps |
| [`detection-rule-behavior.md`](./detection-rule-behavior.md) | what each rule fires on and leaves quiet, with pinning fixtures |
| [`detection-rule-history.md`](./detection-rule-history.md) | rule-set version history |
| [`detection-eval.md`](./detection-eval.md) | eval harness, metrics, gated thresholds |
| [`incident-benchmark.md`](./incident-benchmark.md) | Shai-Hulud / Nx benchmark |
| [`ai-review-eval.md`](./ai-review-eval.md) | AI reviewer contract, evals, promotion checklist |

## Development and operations

| Doc | Owns |
| --- | --- |
| [`tooling.md`](./tooling.md) | Commands and tooling: every `pnpm` script, lint rules, hooks |
| [`e2e-test-environment.md`](./e2e-test-environment.md) | fake registry, seeded dev server, Playwright harness |
| [`agent-tour.md`](./agent-tour.md) | fixed product walkthrough artifacts |
| [`design.md`](./design.md) | visual source of truth (tokens, components) |
| [`design-decisions.md`](./design-decisions.md) | dated design decisions behind `design.md` |
| [`ui.md`](./ui.md) | UI implementation map, primitives, large-diff performance |
| [`self-hosting.md`](./self-hosting.md) | bindings, secrets, deploy, GitHub App, Slack |
| [`ops-snapshot.md`](./ops-snapshot.md) | operator-only aggregate prod snapshot |
| [`incident-content-playbook.md`](./incident-content-playbook.md) | what to publish during a public supply-chain incident |

## Human path

1. [`../README.md`](../README.md): what Drydock is and how to add it to a release.
2. [`architecture.md`](./architecture.md) → [`security-model.md`](./security-model.md): how it works and what it refuses to do.
3. [`workflow-gates.md`](./workflow-gates.md) or [`npm-staged-publishing.md`](./npm-staged-publishing.md): pick a release mode.
4. [`../CONTRIBUTING.md`](../CONTRIBUTING.md): send a change.

## Doc shape

New and edited docs follow this order, omitting empty sections: one-sentence purpose with **Authority** and **Owner** → At a glance table → Contract (endpoints, states, config, one example) → Invariants (each naming its enforcing file or test) → Failure modes table → Change checklist → optional short Why. No history in reference docs; git has it.
