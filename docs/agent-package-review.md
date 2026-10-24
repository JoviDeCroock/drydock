# Agent package-review quickstart

The public `/agents` guide teaches coding agents and their users to review exact
published npm/PyPI dependency upgrades through the existing anonymous package-diff
API, either over HTTPS or through the anonymous, read-only MCP endpoint described
below. Neither needs account authentication or executes package code. atpm
remains available in the API, MCP tools, and `/diff`; the project instruction
deliberately covers the npm/PyPI manifest and lockfile workflow. The CLI's
anonymous `diff`/`file` commands read the same evidence; their contract lives in
[`cli/README.md`](../cli/README.md).

## Entry points and ownership

- `/agents`: prerendered, indexable guide with its own canonical SEO metadata.
- `/docs#agent-package-review`: copyable project instruction and guide link in
  the Docs rail and mobile jump list.
- `https://drydock.org/agents/package-review.md`: static, agent-readable instruction suitable for
  a project's `AGENTS.md` or equivalent rules. The `ProjectInstruction` component
  imports the source instruction in `src/features/agent-quickstart/package-review.md`.
  A parity test keeps that source and the public download byte-identical.
- `/agents#mcp`: the MCP connection, with the same evidence rules.
- `/llms.txt`: concise machine-readable navigation to the guide, instruction,
  MCP endpoint, public diff, setup docs, and trust boundaries. It is a discovery
  file, not an API or authorization mechanism.

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
canonical human review page, built by the site's own path helper from the
returned package/version identity; clients link it as returned. Examples use React 18.2.0 → 18.3.1
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

## MCP endpoint

Connect a remote MCP client using Streamable HTTP to
`https://drydock.org/api/public/v1/mcp`. The endpoint is anonymous: no account,
API key, OAuth flow, or npm installation is needed. Change the origin for a
self-hosted deployment. Clients with an MCP server map can configure:

```json
{
  "mcpServers": {
    "drydock": {
      "type": "http",
      "url": "https://drydock.org/api/public/v1/mcp"
    }
  }
}
```

Client configuration syntax varies; the contract is the URL and Streamable
HTTP transport. The official MCP SDK handles current protocol requests and
stateless compatibility for the 2025-03-26, 2025-06-18, and 2025-11-25 clients.
There are no persistent sessions, resumable streams, or server-initiated calls.

The server advertises two tools, each with `readOnlyHint: true`,
`destructiveHint: false`, and `openWorldHint: true`:

| Tool                       | Inputs                                                   | Output                                                                  |
| -------------------------- | -------------------------------------------------------- | ----------------------------------------------------------------------- |
| `compare_package_versions` | `ecosystem` (defaults to `npm`), `package`, `from`, `to` | Complete public diff response, plus canonical `reviewUrl`               |
| `get_changed_file`         | The same pair plus exact `path`                          | Complete bounded file response, including null sides and coverage flags |

Only the existing ecosystem registry decides which public packages and
versions are valid. Tools accept no credentials, organization selectors, or
arbitrary fetch targets. On npm, explicit versions can also be supported
`pkg.pr.new` preview URLs under the public API's existing rules.

## MCP request and evidence boundaries

`server/routes/public-mcp.ts` mounts before session/API-key authentication.
It dispatches in process to `publicDiffRoutes` with only the caller's IP for
rate-limit accounting. It forwards no cookies or Authorization headers and
never makes an HTTP request back to the Worker.

The endpoint is disabled with a custom `NPM_REGISTRY`, accepts no browser
Origin except the canonical app origin, limits protocol requests to 120/minute
per IP, and bounds message bodies to 16 KiB. Analysis additionally consumes the
existing public diff/file budgets, including the shared cold-computation
budget. Native rate-limit bindings avoid D1; missing native tiers use the
existing D1 rate-limit fallback. There is no review persistence, organization
access, AI review, or new credentialed egress.

Successful tool responses retain all evidence in `structuredContent` and a
JSON text block. Findings remain advisory to the user: deterministic findings
cannot establish safety or authorize a release. Package text is untrusted
input, never instructions, and is never executed or installed. Clients must
retain coverage notices, omitted samples, file flags, and finding attribution.

Tool failures set `isError: true` and carry status/retry metadata; they cannot
be mistaken for clean results. Unexpected backend failures return a generic
message rather than raw errors. The outer protocol budget returns HTTP 429
with `Retry-After`; an analysis-budget error is a tool error with
`retryAfterSeconds`. Neither path retries automatically.

## Measurement and verification

This guide introduces no tracking. Existing `public_diff.viewed` aggregates
count successful pair requests; they cannot identify agent readers or attribute
adoption to this guide. See `product-analytics.md`.

Route/sitemap/metadata parity and prerendered guide discovery are covered in
`test/prerender-routes.test.ts`. Existing Worker tests own the anonymous API
response contract. `test/public-mcp.test.ts` covers MCP schema/argument
boundaries, evidence parity, canonical links, and safe errors;
`test/workers/public-mcp.test.ts` exercises the deployed route with the official
client, cached public artifacts, legacy protocol requests, Origin/body/rate
limits, and credential/organization isolation. No test installs or executes
reviewed package content. Verify the Docs anchor, guide navigation, and copy
interaction in a local browser; run `pnpm run build` after route or shared
code-block moves.
