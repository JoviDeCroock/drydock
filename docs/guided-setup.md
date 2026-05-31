# Guided setup

The guided setup at `/dashboard/setup` walks an organization through standing up
a publishing flow Drydock can review. It does **not** introduce new backend
endpoints — it orchestrates the existing npm-connection, GitHub App, release
target, and staged-publish-discovery models and generates best-practice config.

Entry points:

- Dashboard header → **Set up**.
- The dashboard "npm not connected" callout → **Set up staged publishing**
  (`/dashboard/setup?flow=npm`).

The page is authed (session check → `/login` redirect) and is **not**
prerendered (`isPrerenderedRoute` only covers `/`, `/login`, `/register`,
`/docs`).

## Shape

`src/pages/Dashboard/Setup/`:

- `index.tsx` — wizard shell. Session check, loads org-scoped models, ecosystem
  chooser, and the `?flow=npm|pypi` query binding (`useQuerySignal`).
- `NpmFlow.tsx` / `PypiFlow.tsx` — the two flows, rendered as a vertical stack of
  `StepCard`s. Each step lights up `done` from backing model state rather than
  acting as a step machine; steps Drydock can't observe carry a neutral `manual`
  badge.
- `StepCard.tsx` — shared step shell + `Checklist` helper.
- `workflow-templates.ts` — pure generators for the copy-paste artifacts. No repo
  mutation happens here; these only produce text.

The generated config is surfaced through the `CodeBlock` component
(copy-to-clipboard, mono, surface-2 fill — DESIGN.md compliant).

## npm flow (staged publishing via trusted publishing)

1. **Connect npm for discovery** — a read-only granular token so Drydock can list
   staged publishes (`/-/stage`). The token never reaches the sandbox and is
   never used to publish. Status is driven by `npm.validated`.
2. **Add the staged-publish workflow** (manual) — `npmStagedPublishWorkflow()`
   generates a tag-triggered workflow. The build job has no credentials; only the
   `stage` job gets `id-token: write`, runs behind the `npm` GitHub Environment,
   disables the package-manager cache (in **both** jobs), verifies the tarball
   identity, and runs `npm stage publish`. No `NPM_TOKEN`. Pack output is isolated
   under `.drydock-npm-pack`; the generated workflow records the tarball(s)
   selected from `npm pack --json` by package name, so root `.tgz` files and
   monorepo pack outputs with multiple tarballs cannot accidentally stage the
   wrong package. The UI accepts a comma-separated package allowlist for
   monorepos that intentionally stage several workspaces in one release flow.
3. **Configure the npm package as stage-only** (manual) — `npmTrustCommand()`
   generates one `npm trust github … --allow-stage-publish --no-allow-publish`
   command per selected package, so OIDC can stage but never publish directly.
   Checklist covers requiring 2FA and disallowing token publishes. GitHub YAML
   alone does not enable trusted publishing — the `npm trust` config is required.
4. **Verify** — runs staged-publish discovery (`stagedPublishes.discover()`) and
   reports whether a staged publish was found.

## PyPI flow (GitHub Actions release gate)

Mirrors `drydock-ci-example` and `docs/pypi-workflow-gate.md`.

1. **Install the GitHub App** — `githubApp.startInstall()`. Status from active
   installations.
2. **Add the PyPI release workflow** (manual) — `pypiReleaseWorkflow()` generates
   a plain tag-triggered workflow: build uploads `pypi-release-candidate`, the
   `publish` job blocks on the GitHub Environment, downloads the reviewed artifact
   (never rebuilds), and publishes via Trusted Publishing. There is no
   `workflow_dispatch` target picker — it publishes to PyPI on a `v*` tag.
3. **Configure the GitHub environment gate** (manual) — create the environment,
   add Drydock as a custom deployment protection rule, and point a PyPI Trusted
   Publisher at the same environment name. The shared environment name is what
   ties the gate to the OIDC exchange.
4. **Map the release target** — reuses `Settings/ReleaseTargetForm`. Existing
   mappings must be selected explicitly for this setup flow; merely having an
   unrelated release target in the organization does not mark the step complete.
5. **Test the gate** (manual) — push a `v*` tag; the held deployment surfaces on
   the dashboard.

## Automation boundary

Drydock **generates + guides + reuses existing automation** (npm-connection,
release-target registration). It deliberately does **not** auto-create GitHub
Environments or deployment protection rules — that would require an
`Environments: write` App permission and force every existing installation to
re-consent. Those remain manual steps with linked instructions.

## Tests

`test/setup-workflow-templates.test.ts` pins the security-critical invariants of
the generators (single `id-token: write`, `npm stage publish`, no `NPM_TOKEN`,
cache disabled on the publish path, stage-only trust, single build/checkout in
the PyPI workflow, no `workflow_dispatch`).
