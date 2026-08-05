# Contributing

Thanks for helping improve Drydock. This project reviews release artifacts before
maintainers approve publication, so changes are held to a security-focused
standard.

## Before you start

- Read [`README.md`](README.md) for the project overview.
- Read the relevant files in [`docs/`](docs/) before changing behavior.
- Read [`docs/release-safety.md`](docs/release-safety.md) for the expected test
  layer by change type.
- Read [`docs/design.md`](docs/design.md) before changing visual UI or public copy.
- For local setup and deployment, use [`docs/self-hosting.md`](docs/self-hosting.md).

If you plan to make a large behavior, API, storage, or security-boundary change,
open an issue first so maintainers can agree on the direction and required
tests.

## Development setup

```sh
pnpm install
cp .dev.vars.example .dev.vars
pnpm run test
pnpm run dev
```

The local app runs at `http://localhost:5173` through Vite and the Cloudflare
Worker plugin. The fake-registry E2E harness is documented in
[`docs/e2e-test-environment.md`](docs/e2e-test-environment.md).

## Pull request expectations

Every pull request should include:

- a concise description of the change;
- the trust boundary touched, if any;
- tests run, including skipped tests and why;
- docs updated, or the note `docs checked, no update needed`;
- screenshots or recordings for UI changes.

Keep pull requests focused. Separate unrelated refactors, UI work, detection
logic, storage changes, and workflow changes.

## Security-sensitive changes

Package bytes are hostile evidence. npm credentials, Slack tokens, GitHub App
credentials, Better Auth secrets, session cookies, and package contents must not
leak into logs, errors, test snapshots, AI prompts beyond bounded redacted
evidence, or issue comments.

Changes touching these areas need focused tests:

- auth or organization scoping;
- npm credential storage, validation, and egress;
- Dynamic Worker sandbox parsing or network access;
- deterministic detection rules and risk computation;
- artifact storage, report export, and redaction;
- GitHub workflow-gate decisions and callbacks;
- notification delivery.

Use [`docs/security-model.md`](docs/security-model.md) as the contract.

## Coding conventions

- Use `pnpm run lint`, `pnpm run format:check`, `pnpm run typecheck`, and
  `pnpm run test`; `pnpm run verify` runs the core checks together.
- Do not hand-write SQL migrations. Update `server/db/schema.ts`, then run
  `pnpm db:generate`.
- Do not use `useState` or `useReducer`; the app uses Preact Signals.
- Prefer existing primitives in `src/components/` before introducing new UI
  patterns.
- Keep comments for rationale, trust boundaries, concurrency, and edge cases.
  Avoid comments that narrate obvious control flow.

## Documentation

Update the smallest relevant docs in the same pull request when behavior, APIs,
workflows, deployment, security posture, or operator requirements change. Use
[`docs/README.md`](docs/README.md) to find the right layer. The public `/docs`
page is implemented in `src/pages/Docs/index.tsx`; check whether it needs updates
for public-facing documentation changes.

## Reporting vulnerabilities

Do not open public issues for suspected vulnerabilities. Follow
[`SECURITY.md`](SECURITY.md).
