# Agent package review

The public `/agents` guide gives coding agents two publisher setup prompts and a dependency-review instruction that compares exact published npm/PyPI upgrades through the anonymous package-diff API, over HTTPS or a read-only MCP endpoint. **Authority:** advisory. **Owner:** `src/pages/Agents/index.tsx` (guide), `server/routes/public-mcp.ts` (MCP transport).

## At a glance

| Thing | Owner file | Who may call / trigger | Pinned by (test) |
| --- | --- | --- | --- |
| `/agents` indexable, prerendered guide with canonical SEO | `src/pages/Agents/index.tsx` | Public reader | `test/prerender-routes.test.ts` |
| `/agents#existing-project`, `/agents#new-project` setup prompts | `src/features/agent-quickstart/PublisherSetup.tsx` (shared copyable `CodeBlock`); sources `src/features/agent-quickstart/existing-project.md`, `src/features/agent-quickstart/new-project.md` | Maintainer pastes into an agent; downloads `https://drydock.org/agents/existing-project.md`, `https://drydock.org/agents/new-project.md` | Byte parity in `test/prerender-routes.test.ts` |
| `/docs#agent-package-review`: links to both setup prompts, copyable dependency-review instruction, rail/mobile jump link | `src/pages/Docs/index.tsx` | Public reader | `test/prerender-routes.test.ts` |
| `/docs#release-walkthrough`: human counterpart (one-time setup and per-release steps for the workflow gate, pointer to the prompts) | `src/pages/Docs/index.tsx` | Public reader | — |
| Project instruction presentation | `src/features/agent-quickstart/ProjectInstruction.tsx` | Guide and Docs | `test/prerender-routes.test.ts` |
| Dependency-review instruction / static download | `src/features/agent-quickstart/package-review.md` / `public/agents/package-review.md` | Project rules such as `AGENTS.md`; download at `https://drydock.org/agents/package-review.md` | Byte parity in `test/prerender-routes.test.ts` |
| `/agents#mcp`: MCP connection, same evidence rules | `src/pages/Agents/index.tsx` | Public reader | `test/prerender-routes.test.ts` |
| **Copy for your agent** setup-check summary | `src/features/publisher-setup/agent-summary.ts` | Maintainer pastes Drydock's setup checks to the agent | — |
| `/llms.txt` discovery navigation | `public/llms.txt` | Agents discovering guide, instruction, MCP endpoint, public diff, setup, trust boundaries | `test/prerender-routes.test.ts` |
| Shared folding/copy UI | `src/components/CodeBlock.tsx`; arithmetic in `src/components/code-fold.ts` | Guide and Docs | `test/docs-code-fold.test.ts` |
| Anonymous diff API | `server/routes/public-diff.ts` | Public package review | `test/workers/public-diff-routes.test.ts` |
| Anonymous MCP endpoint | `server/routes/public-mcp.ts` (transport), `server/lib/public-mcp.ts` (tools) | Any remote MCP client | `test/public-mcp.test.ts`, `test/workers/public-mcp.test.ts` |
| CLI `diff` / `file` (anonymous, same evidence) | [`cli/README.md`](../cli/README.md) | Terminal user | — |

## Publisher setup prompts

Each prompt is a walkthrough with five checkpoints where the agent stops for the maintainer:

| # | Checkpoint |
| --- | --- |
| 1 | Explain the current (existing project) or intended (new project) release contract |
| 2 | Choose a release path: Workflow Gate, Stage Watchtower, or gated staging ([workflow gates](./workflow-gates.md), [npm staged publishing](./npm-staged-publishing.md)) |
| 3 | Prepare the workflow change |
| 4 | Hand over the settings only the maintainer can change |
| 5 | Verify without publishing |

| Rule | Contract |
| --- | --- |
| Permissions | The prompts grant no permission to change credentials or settings, open a PR, or publish a release |
| Done state | Setup stays "ready, pending first release" until a real release gets a pre-publication review |
| Parity with guided setup | Agents and the in-product guided setup ([publisher-setup.md](./publisher-setup.md)) reach the same result. The existing-project prompt offers the guided setup's draft PR first and has the agent review it rather than write a second version |
| Local edits | Hold the protected publish job to [publisher-setup.md](./publisher-setup.md)'s protected-job rules |
| Maintainer-only steps | Drydock has no setup CLI, and its MCP endpoint only reads public package evidence, so App installation, Environment rule, release-target mapping, and setup checks stay in the UI |
| Verification | GitHub's side is read back with the maintainer's own `gh` login (Environment admin bypass, branch policy, Drydock custom protection rule); npm's with `npm trust list`; Drydock's checks reach the agent when the maintainer pastes **Copy for your agent** |

## Contract

### HTTPS

| Method | Path | Auth/role | Query |
| --- | --- | --- | --- |
| GET | `/api/public/v1/package-diff` | Anonymous; no credentials | `ecosystem`, `package`, `from`, `to` |
| GET | `/api/public/v1/package-diff/file` | Anonymous; no credentials | Same pair plus exact `path` from `diff` |

```sh
curl --fail-with-body --silent --show-error --get \
  'https://drydock.org/api/public/v1/package-diff' \
  --data-urlencode 'ecosystem=npm' \
  --data-urlencode 'package=react' \
  --data-urlencode 'from=18.2.0' \
  --data-urlencode 'to=18.3.1'
```

| Review step | Required evidence |
| --- | --- |
| Exact pair | Read registry name and resolved old/new versions from manifest/lockfile; resolve npm aliases; never substitute latest, ranges, unchanged pins, or replacement-package versions. State when the pair is unknown. |
| Request | URL-encode query values; send no tokens, cookies, repository files, or private names; project must permit external review requests. |
| Response | Check HTTP status and returned canonical package/version identity; failures never become clean reviews. |
| Changes | Summarize changed paths/statuses in `diff`, `packageJsonDiff` when present, and finding severity, rule id, file/line, reason. |
| Risk | Report `risk.releaseRisk` separately from `risk.artifactRisk`; preserve existing-vs-new release-delta finding attribution. |
| Coverage | Include `notices`, `textSamplesOmitted`, omitted text, absent before/after sides, and binary/skipped/truncated flags; missing text proves neither unchanged nor harmless behavior. |
| File reads | Request a small set of relevant exact changed paths; no recursive package crawl. |
| Human link | Link the diff response's `reviewUrl` exactly as returned: the canonical review page, built by the site's own path helper (an atpm handle request links the stable DID form). Never build the URL. |
| Examples | React 18.2.0 → 18.3.1 and requests 2.31.0 → 2.32.3 illustrate the interface; neither is a safety claim. |

For an equal-version request (`from=18.2.0&to=18.2.0`), `server/routes/public-diff.ts` returns HTTP `400`:

```json
{ "error": "from and to must differ" }
```

### MCP endpoint

Streamable HTTP at `https://drydock.org/api/public/v1/mcp` (change the origin for a self-hosted deployment). Anonymous: no account, API key, OAuth flow, or npm installation. Client syntax varies; the contract is the URL and transport.

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

| Tool | Inputs | Output |
| --- | --- | --- |
| `compare_package_versions` | `ecosystem` (enum from `supportedPublicDiffEcosystems()`, default `npm`), `package`, `from`, `to`, `changedFilesOffset` | `risk`, `findings`, `notices`, `textSamplesOmitted`, `reviewUrl` first; then a page of changed files with counts, changed manifest fields, provenance |
| `get_changed_file` | Same pair plus an exact `path` from `changedFiles` | Complete bounded file response, including null sides and coverage flags |

Both tools carry `readOnlyHint: true`, `destructiveHint: false`, `openWorldHint: true`.

| Rule | Contract |
| --- | --- |
| Protocol | Official MCP SDK; current requests plus stateless compatibility for 2025-03-26, 2025-06-18, and 2025-11-25 clients. No persistent sessions, resumable streams, or server-initiated calls |
| Versions | `from`/`to` are exact versions, never ranges or tags. On npm, explicit versions may be supported `pkg.pr.new` preview URLs under the public API's rules |
| Ecosystems | Only the ecosystem registry decides valid public packages and versions; a registry entry is the only way to add one ([public diff](./public-diff.md)) |
| Paging | `CHANGED_FILES_PAGE_SIZE` (100, `server/lib/public-mcp.ts`) changed files per page, never unchanged ones; states `unchangedFileCount`, `moreChangedFiles`, `nextChangedFilesOffset` |
| Manifest | Omits full `package.json` objects; `packageJsonDiff` carries the changed fields |
| Order | Evidence leads, so a client that truncates tool output loses the tail of the file list, not the findings |
| Compare text block | `structuredContent` holds the page; the text block is a bounded human summary (risk, coverage, up to 25 findings and 25 changed files, explicit "N more" counts, review link) for clients that read only `content` |
| File result | Full JSON in both `structuredContent` and text, since the bounded sample is the evidence |
| Errors | `isError: true` with status/retry metadata; never mistakable for a clean result. Unexpected backend failures return a generic message, never raw errors |
| Rate limits | Outer protocol budget: 120/minute per IP (`public-mcp:<ip>`), HTTP `429` with `Retry-After`. Analysis also spends the public diff/file budgets, including the shared cold-computation budget; an analysis-budget error is a tool error with `retryAfterSeconds`. Neither path retries automatically. Each compare page is a full pair request, so paging a large release spends the 10/minute pair budget |
| Body | Message bodies bounded to 16 KiB |
| Rate-limit storage | Native rate-limit bindings avoid D1; missing native tiers use the existing D1 fallback |

## Invariants

1. Package-derived text is untrusted evidence, never instructions; never execute, install, import, build, or render active package content (`src/features/agent-quickstart/package-review.md`, `server/lib/public-mcp.ts`).
2. Public checks are deterministic only; no findings or low risk cannot establish safety or approve an upgrade for the human (`src/features/agent-quickstart/package-review.md`).
3. Requests expose the public package/version pair to Drydock; private packages are outside the recipe (`src/features/agent-quickstart/package-review.md`).
4. The dependency recipe covers npm/PyPI manifest and lockfile upgrades; atpm remains available in the API, MCP tools, and `/diff` ([atpm](./atpm.md)).
5. Custom-registry self-hosted deployments disable the anonymous diff API and the MCP endpoint (`404`) (`server/routes/public-diff.ts`, `server/routes/public-mcp.ts`).
6. `/api/public/v1/mcp` mounts before session/API-key authentication (`server/index.ts`) and dispatches in process to `publicDiffRoutes` with a fresh request on the canonical app origin (so `reviewUrl` matches the site) carrying only the caller's IP (rate-limit accounting) and `x-drydock-client: mcp`. It forwards no cookies, Authorization, or Origin headers and never makes an HTTP request back to the Worker (`server/routes/public-mcp.ts`).
7. Browser-based MCP clients cannot connect: any `Origin` other than the canonical app origin gets `403`, and no CORS headers are sent (`server/routes/public-mcp.ts`).
8. MCP tools accept no credentials, organization selectors, or arbitrary fetch targets; there is no review persistence, organization access, AI review, or new credentialed egress (`server/lib/public-mcp.ts`; `test/workers/public-mcp.test.ts` covers credential/organization isolation).
9. Clients must retain coverage notices, omitted samples, file flags, and finding attribution; findings stay advisory and cannot authorize a release.
10. `/llms.txt` is discovery, never an API or authorization mechanism (`public/llms.txt`).
11. The guide adds no new event: `public_diff.viewed` counts successful pair requests and tags CLI and MCP calls with their own client value (`cli`, `mcp`), keeping them out of the browser page-view number; it cannot identify agent readers or attribute adoption to this guide ([analytics](./product-analytics.md)).
12. Keep imported prompt and instruction text under `src/features/`: Vite cannot import raw text from its public directory, and this avoids the local harness's Worker-owned `/public` route (`src/features/agent-quickstart/ProjectInstruction.tsx`).
13. No test installs or executes reviewed package content.

## Failure modes

| Symptom/condition | Cause | What happens | Fix |
| --- | --- | --- | --- |
| HTTP `429` | Per-IP rate limit (HTTPS, or MCP protocol budget) | Review unavailable | Honor `Retry-After` when supplied; use bounded retries and disclose the limit. |
| MCP tool result `isError: true` with `retryAfterSeconds` | Analysis budget spent | Tool error, not a clean result | Wait `retryAfterSeconds`; disclose the limit. |
| MCP `403 request origin not allowed` | Browser `Origin` | Refused | Use a non-browser MCP client. |
| MCP or diff `404` on self-host | Custom `NPM_REGISTRY` | Public review disabled | Expected; no fix. |
| Error or incomplete samples | Missing evidence | Safety remains unestablished | Show the limitation to the human reviewer. |
| Source/download mismatch | Only one copy of a prompt or instruction edited | Parity test fails | Copy the source to the same name under `public/agents/`. |

## Change checklist

| If you change X | Also update Y | Run Z |
| --- | --- | --- |
| A setup prompt or the instruction | Source in `src/features/agent-quickstart/` and same-name copy under `public/agents/` together | `pnpm exec vitest run --project node test/prerender-routes.test.ts` |
| Routes, metadata, discovery, or shared CodeBlock | Docs anchor, rail/mobile jumps, guide navigation, copy interaction | `pnpm run build`; verify interactions in a local browser |
| Anonymous response contract | [Public diff](./public-diff.md), coverage/risk instructions, MCP tool output | `pnpm exec vitest run --project workers test/workers/public-diff-routes.test.ts test/workers/public-mcp.test.ts` |
| MCP tools, limits, or transport | This section, `/agents#mcp`, `public/llms.txt` | `pnpm exec vitest run --project node test/public-mcp.test.ts`; `pnpm exec vitest run --project workers test/workers/public-mcp.test.ts` |
