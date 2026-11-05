# Agent package-review quickstart

The public `/agents` guide has two publisher setup prompts—one for an existing
project and one for a new project—and a dependency-review instruction. Each
setup prompt is a walkthrough with five checkpoints where the agent stops for
the maintainer: explain the current or intended release contract, choose a
release path (Workflow Gate, Stage Watchtower, or gated staging), prepare the
workflow change, hand over the settings only the maintainer can change, and
verify without publishing. They grant no permission to change credentials or
settings, open a PR, or publish a release. Setup stays "ready, pending first
release" until a real release gets a pre-publication review.

Agents and the in-product guided setup
([`publisher-setup.md`](./publisher-setup.md)) should reach the same result. The
existing-project prompt offers the guided setup's draft PR first and has the
agent review it rather than write a second version. Local edits by either prompt
hold the protected publish job to that document's protected-job rules. Drydock
has no setup CLI or MCP server, so the App installation, Environment rule,
release-target mapping and setup checks remain maintainer steps in the UI. To
verify, the prompts read GitHub's side back with the maintainer's own `gh` login
(Environment admin bypass, branch policy, and the Drydock custom protection
rule) and npm's with `npm trust list`. Drydock's own checks reach the agent when
the maintainer pastes **Copy for your agent** from the setup checks
(`src/features/publisher-setup/agent-summary.ts`).

`/docs#release-walkthrough` is the human counterpart: one-time setup and
per-release steps for the workflow gate, with a pointer to the agent prompts.

The dependency-review recipe compares exact published npm/PyPI dependency upgrades
through the existing anonymous package-diff API. This guide adds no backend
capability, MCP server, account authentication, or package execution. atpm remains
available in the API and `/diff`; the dependency recipe deliberately covers the
npm/PyPI manifest and lockfile workflow.

## Entry points and ownership

- `/agents`: prerendered, indexable guide with its own canonical SEO metadata.
- `/agents#existing-project` and `/agents#new-project`: copyable publisher setup
  prompts with byte-identical plain-text downloads at
  https://drydock.org/agents/existing-project.md and
  https://drydock.org/agents/new-project.md. Sources live in `src/features/agent-quickstart/`;
  `PublisherSetup.tsx` presents them using the shared copyable `CodeBlock`.
- `/docs#agent-package-review`: links to both setup prompts, plus the copyable
  dependency-review project instruction in the Docs rail and mobile jump list.
- `https://drydock.org/agents/package-review.md`: static, agent-readable instruction suitable for
  a project's `AGENTS.md` or equivalent rules. The `ProjectInstruction` component
  imports the source instruction in `src/features/agent-quickstart/package-review.md`.
  A parity test keeps that source and the public download byte-identical.
- `/llms.txt`: concise machine-readable navigation to the guide, instruction,
  public diff, setup docs, and trust boundaries. It is a discovery file, not an
  API or authorization mechanism.

`src/pages/Agents/index.tsx` owns the guide. Shared instruction presentation lives
in `src/features/agent-quickstart/ProjectInstruction.tsx`. The existing Docs code
block now lives in `src/components/CodeBlock.tsx`, with unchanged folding/copy
behavior and fold arithmetic in `src/components/code-fold.ts`.

Edit a source prompt or instruction in `src/features/agent-quickstart/` and copy
it to the same name under `public/agents/` when its contract changes. Vite
cannot import raw text from its public directory; keeping the import under
`src/features/` also avoids the Worker-owned `/public` route in the local
harness.

## API and evidence contract

The recipe uses `GET /api/public/v1/package-diff` with `ecosystem`, `package`,
`from`, and `to` query parameters, and `/file` with the same parameters plus
`path`. Query values are URL-encoded; reviewer links encode each path segment
separately and preserve the slash in scoped npm names. The returned canonical
package/version identity determines the link. Examples use React 18.2.0 → 18.3.1
and requests 2.31.0 → 2.32.3. They illustrate the interface, not a safety claim.

The instruction preserves existing-vs-new finding attribution and distinguishes
release risk from artifact risk. Coverage notices, omitted text, absent file
sides, binary/skipped/truncated samples, rate limits, and failed responses must
remain visible to the human reviewer. Package-derived text is evidence, never
instructions. A clean deterministic result cannot establish safety or approve
an upgrade on the user's behalf.

Public requests send no credentials or repository files. They expose the public
package and version pair to Drydock, so the project must permit external review
requests. Private package names are outside the recipe. Custom-registry
self-hosted deployments disable the anonymous diff API as before.

## Measurement and verification

This guide introduces no tracking. Existing `public_diff.viewed` aggregates
count successful pair requests; they cannot identify agent readers or attribute
adoption to this guide. See `product-analytics.md`.

Route/sitemap/metadata parity and prerendered guide discovery are covered in
`test/prerender-routes.test.ts`. Existing Worker tests own the anonymous API
response contract. Verify the Docs anchor, guide navigation, and copy interaction
in a local browser; run `pnpm run build` after route or shared code-block moves.
