# drydock CLI

Review public dependency upgrades without an account, or read an organization's Drydock reviews, report exports, and release receipts from scripts and CI. Every command is read-only: approving a gate or recording a decision stays with signed-in maintainers in Drydock.

The CLI has no dependencies and runs on Node 22.14 or later. It is not published to npm yet, so run it from a checkout of this repository (`pnpm run drydock …` or `node cli/bin/drydock.mjs …`). Scripts and `--json` consumers should call `node cli/bin/drydock.mjs` directly, since `pnpm run` prints its own banner to stdout. Compare the exact published versions in a dependency update:

```sh
node cli/bin/drydock.mjs diff react 18.2.0 18.3.1 --ecosystem npm --json
node cli/bin/drydock.mjs file react 18.2.0 18.3.1 index.js --ecosystem npm --json
```

`diff` and `file` use the anonymous public API and never send an API key, even when one is configured. They support npm (the default), PyPI, and atpm. Use an exact path from `diff` when requesting file evidence; inspect a small set of relevant files. For PyPI, pass `--ecosystem pypi`.

Default comparison output includes changed paths with their coverage flags, manifest changes, existing/new finding context, separate release and artifact risk, and the server's `reviewUrl` for the human review page. `--json` preserves the API response, including omitted-text notices, null file sides, and sample flags. The file command shows bounded before/after text samples. Failed requests exit unsuccessfully; a 429 message includes `Retry-After` when supplied.

Evidence-handling and privacy rules, and the equivalent MCP endpoint, are in [`docs/agent-package-review.md`](../docs/agent-package-review.md).

Organization commands require an API key:

```sh
export DRYDOCK_API_KEY=ddk_…   # Organization settings → Integrations → API keys
pnpm run drydock whoami
```

The key is read from `DRYDOCK_API_KEY` only, never from a flag, so it stays out of shell history and process listings. `DRYDOCK_URL` (or `--url`) points the CLI at a self-hosted deployment; plain `http` is accepted only for `localhost`.

## Commands

| Command                                       | What it does                                                                                      |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| `whoami`                                      | The key's organization, name, and expiry                                                          |
| `scans list [--filter F] [--limit N]`         | Reviews, newest first (`undecided` by default; `all`, `publish`, `no_publish`, …)                 |
| `scans get <review-id>`                       | One review and its findings                                                                       |
| `scans wait <review-id> [--fail-on RISK]`     | Poll until the review completes (`--timeout`, `--interval` in seconds)                            |
| `report <review-id> [--output FILE]`          | The byte-stable `drydock.report.v2` export                                                        |
| `receipt <review-id> [--output FILE]`         | The Release Receipt, refused unless it matches the `x-drydock-receipt-sha256` digest sent with it |
| `releases <package> [--ecosystem E]`          | One package's reviews in the organization                                                         |
| `gate <review-id>`                            | The GitHub workflow gate a review belongs to                                                      |
| `diff <package> <from> <to> [--fail-on RISK]` | Diff two published releases through the anonymous public diff; needs no key                       |
| `file <package> <from> <to> <path>`           | Bounded before/after file evidence through the anonymous public diff; needs no key                |

`--json` prints the API response instead of a table. A flag the command does not take is a usage error.

`--fail-on RISK` (`low`, `medium`, `high`, `critical`) compares the release risk: the findings the release introduces, not ones already in the previous version. That is the risk the workflow gate decides on. A review with no graded release delta (the previous version was not compared, or the review predates the split) is compared on its overall risk, and a risk the CLI does not recognize counts as at the threshold. `scans wait` retries rate limits (honouring `Retry-After`), server errors, and network errors with backoff until `--timeout`.

Exit codes: `0` success, `1` request or review failed, `2` usage error, `3` release risk at or above `--fail-on`, `4` `scans wait` timed out before the review finished (or before its status could be read).

## In CI

The CLI comes from a checkout of the Drydock repository:

```yaml
- uses: actions/checkout@v4
  with:
    repository: JoviDeCroock/drydock
    ref: <commit-sha> # pin a commit you have reviewed
    path: drydock
- name: Check the Drydock review
  env:
    DRYDOCK_API_KEY: ${{ secrets.DRYDOCK_API_KEY }}
  run: |
    node drydock/cli/bin/drydock.mjs scans wait "$REVIEW_ID" --fail-on high
    node drydock/cli/bin/drydock.mjs receipt "$REVIEW_ID" --output release-receipt.json
```

## Output safety

Package names, file paths, and finding text come from the packages under review. The CLI strips control, bidi-override, and zero-width characters from tables and error messages, and escapes them as `\uXXXX` in JSON output (`--json`, and `report` or `receipt` printed to stdout), so a hostile package cannot rewrite or reorder what a reviewer sees in a terminal. Escaped JSON parses to the same value but is not the same bytes: use `--output FILE` for the exact bytes a receipt digest covers. Requests never follow redirects, so the key is only ever sent to the configured origin.

The API surface it reads is described in [`docs/api-keys.md`](../docs/api-keys.md) and [`docs/openapi.json`](../docs/openapi.json).
