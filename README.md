# Staged Publish Review

Drydock reviews package artifacts before a maintainer approves publication. It compares the candidate with a tag-aware published baseline, runs deterministic supply-chain checks, optionally sends changed-file evidence to Cloudflare Workers AI, and saves a review report.

Approval stays outside Drydock: maintainers approve in npm, npmjs.com, or GitHub with their own required 2FA/review step. Drydock never publishes and never collects approval codes.

## Modes

- **npm registry staging** — `npm publish --stage` creates a private staged tarball. Drydock downloads it through a sandbox and leaves final approval in npm.
- **Workflow gates** — for ecosystems where the registry cannot stage a candidate, GitHub Actions uploads built artifacts and a GitHub Environment custom deployment-protection rule blocks publishing until Drydock review is accepted or rejected. PyPI, npm, and VS Code workflow-gate artifacts are supported by the shared gate pipeline.

## Docs

Start with [`docs/README.md`](docs/README.md) to pick the smallest relevant reference. Common entry points:

- [`docs/self-hosting.md`](docs/self-hosting.md) — local setup, Cloudflare resources, deployment, GitHub App, and Slack setup.
- [`docs/architecture.md`](docs/architecture.md) — runtime components, trust boundaries, adapters, storage, and API shape.
- [`docs/security-model.md`](docs/security-model.md) — non-negotiable security posture.
- [`docs/workflow-gates.md`](docs/workflow-gates.md) — GitHub Environment gate contract for PyPI, npm, and VS Code workflow-gated releases.
- [`docs/release-safety.md`](docs/release-safety.md), [`docs/security-detection-corpus.md`](docs/security-detection-corpus.md), [`docs/detection-eval.md`](docs/detection-eval.md), and [`docs/e2e-test-environment.md`](docs/e2e-test-environment.md) — verification and detection quality.

## Layout

```text
server/       Hono Worker, scan pipeline, adapters, persistence, webhooks
src/          Preact UI and typed API models
drizzle/      D1 migrations
docs/         Architecture, security, workflow, setup, and test references
test/         Vitest, Worker-runtime, security corpus, and fake-registry e2e
```

## Develop

```sh
pnpm install
pnpm run dev
```

The dev server runs the Worker and UI through Vite at `http://localhost:5173`. Edit `.dev.vars` with local Cloudflare, Better Auth, npm, GitHub App, Slack, and optional Workers AI/Flagship values as described in [`docs/self-hosting.md`](docs/self-hosting.md).

Useful commands:

```sh
pnpm run lint
pnpm run format:check
pnpm run typecheck
pnpm run test
pnpm run test:e2e
pnpm run verify
```

For deterministic browser testing without real staged publishes, use the local fake-registry harness in [`docs/e2e-test-environment.md`](docs/e2e-test-environment.md). For an agent-readable product walkthrough, use [`docs/agent-tour.md`](docs/agent-tour.md).

## Configuration

Core Cloudflare bindings are in `wrangler.jsonc`: D1 (`DB`), KV (`SESSIONS`), R2 (`SCAN_ARTIFACTS`), Queue (`SCAN_QUEUE`), Dynamic Worker namespace (`DYNAMIC_WORKER`), AI Gateway (`AI_GATEWAY`), Workers AI (`AI`), and service bindings used by Slack and workflow gates.

Important secrets/vars:

- `BETTER_AUTH_SECRET`, `BETTER_AUTH_URL`
- `NPM_CONNECTIONS_ENCRYPTION_KEY`
- `GITHUB_APP_ID`, `GITHUB_APP_PRIVATE_KEY`, `GITHUB_WEBHOOK_SECRET`, `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`
- `SLACK_CLIENT_ID`, `SLACK_CLIENT_SECRET`, `SLACK_SIGNING_SECRET`, `SLACK_STATE_SECRET`
- `CF_ACCOUNT_ID`, `AI_GATEWAY_ID`, `AI_GATEWAY_TOKEN`, `FLAGSHIP_*`, `CRON_SECRET`

Run `pnpm run cf-typegen` after changing Cloudflare bindings.

## API surface

The authenticated JSON API lives under `/api/v1`. The main resources are:

- scans: create/list/read/export reports, compare published baselines, and fetch prior file samples;
- npm connection: read public metadata, store/rotate, validate, and remove the current organization token;
- release targets and workflow gates: map GitHub repositories/environments, review queued gate artifacts, and post accept/reject decisions;
- auth/org/settings helpers for Better Auth-backed sessions and organization membership.

Consult route definitions under `server/routes/` for exact request/response shapes; shared types are imported by the UI from `server/`.

## Security posture

- Package artifacts are untrusted evidence and are never executed.
- npm credentials are encrypted at rest, decrypted only for registry access, and never passed into the Dynamic Worker sandbox.
- The sandbox can fetch only through constrained brokers/gateways and returns bounded metadata/text evidence.
- AI review is advisory and on by default behind the `ai-review` killswitch, and cannot downgrade deterministic findings.
- Raw tarballs are not retained by default; persisted reports use redacted summaries and canonical report JSON.

See [`docs/security-model.md`](docs/security-model.md) for the full contract.

## License

Drydock is released under the [Functional Source License, Version 1.1, Apache 2.0
Future License](LICENSE.md) (`FSL-1.1-Apache-2.0`). You may read, self-host,
modify, and contribute to Drydock for free; the license only bars using it to
offer a competing commercial product or service. Each release converts to the
Apache License 2.0 two years after it is made available.
