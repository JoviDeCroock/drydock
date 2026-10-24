# Agent package-review quickstart

The public `/agents` guide teaches coding agents and their users to review exact
published npm/PyPI dependency upgrades through the existing anonymous package-diff
API. It adds no backend capability, MCP server, account authentication, or
package execution. atpm remains available in the API and `/diff`; this first
recipe deliberately covers the npm/PyPI manifest and lockfile workflow.

## Entry points and ownership

- `/agents`: prerendered, indexable guide with its own canonical SEO metadata.
- `/docs#agent-package-review`: copyable project instruction and guide link in
  the Docs rail and mobile jump list.
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

Edit the source instruction and copy it to `public/agents/package-review.md`
when its contract changes. Vite cannot import raw text from its public directory;
keeping the import under `src/features/` also avoids the Worker-owned `/public`
route in the local harness.

## API and evidence contract

The recipe uses `GET /api/public/v1/package-diff` with `ecosystem`, `package`,
`from`, and `to` query parameters, and `/file` with the same parameters plus
`path`. Query values are URL-encoded. The diff response's `reviewUrl` is the
canonical human review page, built by the site's own path helper; an atpm
handle request links the stable DID form. Clients link it as returned.
Examples use React 18.2.0 → 18.3.1 and requests 2.31.0 → 2.32.3. They
illustrate the interface, not a safety claim.

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
