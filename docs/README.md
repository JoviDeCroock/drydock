# Documentation map

Start here instead of reading every Markdown file. Pick the smallest set that matches the change, then update the same layer when behavior changes.

## Always-use references

- [`../AGENTS.md`](../AGENTS.md) — repo rules, commands, invariants, and test expectations for agents.
- [`../DESIGN.md`](../DESIGN.md) — visual/UI source of truth. Read before UI changes.
- [`release-safety.md`](./release-safety.md) — required verification layer by change type.
- [`security-model.md`](./security-model.md) — security boundaries and non-negotiables.

## Product/runtime docs

- [`architecture.md`](./architecture.md) — Worker, sandbox, adapters, storage, org model, and API shape.
- [`workflow-gates.md`](./workflow-gates.md) — GitHub Environment gate flow for PyPI and npm workflow-gated releases.
- [`diff-baseline.md`](./diff-baseline.md) — default previous-version comparison strategy.
- [`artifact-storage.md`](./artifact-storage.md) — D1/R2 report and artifact persistence.

## Operations and setup

- [`self-hosting.md`](./self-hosting.md) — local setup, Cloudflare resources, deploy, GitHub App, Slack.
- [`e2e-test-environment.md`](./e2e-test-environment.md) — fake registry and Playwright harness.
- [`tooling.md`](./tooling.md) — oxlint/oxfmt/typecheck, signals lint rules, route/client helpers.
- [`agent-tour.md`](./agent-tour.md) — portable product walkthrough artifacts.
- [`test-package.md`](./test-package.md) — package fixture used for manual staged-publish checks.

## Domain docs

- [`security-detection-corpus.md`](./security-detection-corpus.md) — rule/eval fixture layout and expected findings.
- [`detection-eval.md`](./detection-eval.md) — eval harness, metrics, and gates.
- [`organization-members.md`](./organization-members.md) — organization invitation/membership behavior.
- [`two-factor-auth.md`](./two-factor-auth.md) — step-up auth and sensitive actions.
- [`slack-notifications.md`](./slack-notifications.md) — Slack install and notification flow.
- [`account-deletion.md`](./account-deletion.md) — account deletion lifecycle.
- [`product-analytics.md`](./product-analytics.md) — first-party PostHog product analytics, privacy posture, and captured events.

## Retired or compatibility pointers

- [`npm-workflow-gate.md`](./npm-workflow-gate.md) — short pointer kept for old links; canonical npm workflow-gate details now live in [`workflow-gates.md`](./workflow-gates.md#npm-workflow-gate-notes).
