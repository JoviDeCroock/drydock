# Public agent integrations

The CLI's anonymous `diff`/`file` commands, hosted MCP endpoint, and in-page WebMCP tools expose the
same existing public package-review API. The downloadable agent recipe lives
at [`public/mcp.md`](../public/mcp.md), served as the
[agent instructions](https://drydock.org/mcp.md). The CLI's usage and
output contract live in [`cli/README.md`](../cli/README.md).

## MCP connection

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

## WebMCP on the diff page

On browsers exposing `document.modelContext.registerTool`, the public diff
page registers the same two tools and strict input schemas. The current
[WebMCP specification](https://webmachinelearning.github.io/webmcp/) uses
document-scoped registration with AbortSignal cleanup. No polyfill, browser
extension, account, or separate MCP connection is installed by Drydock. On
unsupported browsers the normal page works unchanged.

`compare_package_versions` loads an exact public pair and updates the page to
the canonical review URL, including its heading, version picker, and workbench.
The response seeds the new pair's model so the visible page does not repeat
the comparison request. `get_changed_file` opens the requested pair if needed,
selects the exact file, clears the file filter, and reveals unchanged files
when necessary. Both tools return the complete public evidence using the same
result envelope as hosted MCP.

These browser tools change visible page state, so their annotations use
`readOnlyHint: false`, `untrustedContentHint: true`, and
`consequentialHint: false`. They have no backend write authority. Registration
exists only on the diff page and is removed on navigation away. Separate
registration and execution signals cancel disposed or superseded calls;
late comparisons cannot redirect a user who has moved elsewhere. Newer file
selections retain ownership of the workbench when an older response arrives.
Registration refusal rolls back the tools and leaves ordinary page controls
usable.

All browser public-review requests omit cookies and organization selectors,
even for a signed-in user. Errors retain status/retry information and remain
explicit failures. WebMCP adds no endpoint, permission, account operation, or
release decision.

## Request and evidence boundaries

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

## Verification

Node tests cover schema/argument boundaries, evidence parity, canonical links,
and safe errors. Worker tests exercise the deployed route with the official
client, cached public artifacts, legacy protocol requests, Origin/body/rate
limits, and credential/organization isolation. No test installs or executes
reviewed package content.

Browser tests use a document-scoped WebMCP shim to exercise registration,
navigation and version/file synchronization, cancellation, request races,
unsupported browsers, and refused registration. This verifies Drydock's
integration; native browser/agent support depends on the browser's WebMCP
implementation and rollout.
