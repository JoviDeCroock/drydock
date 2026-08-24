# Documentation map

Start here instead of reading every Markdown file. Pick the smallest set that matches the change, then update the same layer when behavior changes.

The user-facing learning guide is [`../src/pages/Docs/index.tsx`](../src/pages/Docs/index.tsx). Keep its product model and setup steps aligned with the canonical runtime docs below; the Markdown files remain the detailed engineering and operator reference.

## Always-use references

- [`../AGENTS.md`](../AGENTS.md) — repo rules, commands, invariants, and test expectations for agents.
- [`design.md`](./design.md) — visual/UI source of truth. Read before UI changes.
- [`release-safety.md`](./release-safety.md) — required verification layer by change type.
- [`security-model.md`](./security-model.md) — security boundaries and non-negotiables.

## Product/runtime docs

- [`architecture.md`](./architecture.md) — Worker, sandbox, adapters, storage, org model, and API shape.
- [`workflow-gates.md`](./workflow-gates.md) — shared GitHub Environment gate flow for PyPI, npm, and VS Code releases.
- [`diff-baseline.md`](./diff-baseline.md) — default previous-version comparison strategy.
- [`dependency-review.md`](./dependency-review.md) — reviewing the artifacts of dependencies a release newly introduces: selection, credential-free resolution, install-time observations, resolution honesty, and the coverage gaps that fail visibly.
- [`atpm-public-diff.md`](./atpm-public-diff.md) — the atpm ecosystem on `/diff`: AT Protocol resolution (handle → DID → PDS → record → blob), why it does not go through atpm.dev, the host policy that bounds publisher-named egress, and the record-vs-tarball findings.
- [`atpm-trusted-publishing.md`](./atpm-trusted-publishing.md) — atpm's OIDC trusted publishing, the Sigstore bundles Drydock re-verifies against a pinned root, and the anonymous public-diff link atpm's own dashboard uses to hand a maintainer a pre-publish review with no account. Review only: Drydock does not approve, gate, or watch an atpm release.
- [`intent-envelope.md`](./intent-envelope.md) — advisory source-binding tiers (attested / declared / absent) persisted with every scan.
- [`artifact-storage.md`](./artifact-storage.md) — D1/R2 report and artifact persistence.
- [`public-reports.md`](./public-reports.md) — public share links, signed report attestations, badges, and the threat feed.

## Operations and setup

- [`self-hosting.md`](./self-hosting.md) — local setup, Cloudflare resources, deploy, GitHub App, Slack.
- [`e2e-test-environment.md`](./e2e-test-environment.md) — fake registry and Playwright harness.
- [`tooling.md`](./tooling.md) — oxlint/oxfmt/typecheck, signals lint rules, route/client helpers.
- [`ui.md`](./ui.md) — compact implementation map for the Preact UI: primitives, copy density, and large-diff performance rules. `docs/design.md` remains the visual source of truth.
- [`agent-tour.md`](./agent-tour.md) — portable product walkthrough artifacts.
- [`incident-content-playbook.md`](./incident-content-playbook.md) — what to publish when a public supply-chain compromise breaks, the hard rules, and the post templates.
- [`ops-snapshot.md`](./ops-snapshot.md) — operator-only aggregate prod D1 snapshot (`pnpm run ops:snapshot`) and its unattributability rules.
- [`test-package.md`](./test-package.md) — package fixture used for manual staged-publish checks.

## Domain docs

- [`security-detection-corpus.md`](./security-detection-corpus.md) — rule/eval fixture layout and expected findings.
- [`detection-eval.md`](./detection-eval.md) — eval harness, metrics, and gates.
- [`ai-review-eval.md`](./ai-review-eval.md) — versioned AI reviewer contract, recorded-output evals, live model comparison, traces, and feedback loop.
- [`release-memory.md`](./release-memory.md) — advisory prior-release finding-profile consistency; discounts already-approved package context from the artifact-risk headline, and never moves release risk or a gate decision.
- [`release-fingerprint.md`](./release-fingerprint.md) — the history-based `release.source-drift` rule and its FP posture.
- [`organization-members.md`](./organization-members.md) — organization invitation/membership behavior.
- [`audit-log.md`](./audit-log.md) — organization audit log surface, visible-event allowlist, and retention.
- [`product-analytics.md`](./product-analytics.md) — Analytics Engine counters, privacy posture, and the positional event schema.
- [`dependency-pr-diff-links.md`](./dependency-pr-diff-links.md) — the `renovate/diff-links.json` shared preset and Dependabot workflow that link dependency-update PRs to public `/diff` pages; the preset path is a public contract.
- [`two-factor-auth.md`](./two-factor-auth.md) — step-up auth and sensitive actions.
- [`slack-notifications.md`](./slack-notifications.md) — Slack install and notification flow.
- [`account-deletion.md`](./account-deletion.md) — account deletion lifecycle.

## Retired or compatibility pointers

- [`npm-workflow-gate.md`](./npm-workflow-gate.md) — short pointer kept for old links; canonical npm workflow-gate details now live in [`workflow-gates.md`](./workflow-gates.md#npm-workflow-gate-notes).
- [`vscode-workflow-gate.md`](./vscode-workflow-gate.md) — short pointer; canonical VS Code workflow-gate details live in [`workflow-gates.md`](./workflow-gates.md#vs-code-workflow-gate-notes).
