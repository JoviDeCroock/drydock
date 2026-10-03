# drydock CLI

Read an organization's Drydock reviews, report exports, and release receipts from scripts and CI. Every command is read-only: approving a gate or recording a decision stays with signed-in maintainers in Drydock.

The CLI has no dependencies and runs on Node 22.14 or later. From a checkout of this repository:

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

`--json` prints the API response instead of a table. Exit codes: `0` success, `1` request or review failed, `2` usage error, `3` risk at or above `--fail-on` (`low`, `medium`, `high`, `critical`; `scans wait` compares the review's risk, `diff` its release risk).

## In CI

```yaml
- name: Check the Drydock review
  env:
    DRYDOCK_API_KEY: ${{ secrets.DRYDOCK_API_KEY }}
  run: |
    node cli/bin/drydock.mjs scans wait "$REVIEW_ID" --fail-on high
    node cli/bin/drydock.mjs receipt "$REVIEW_ID" --output release-receipt.json
```

## Output safety

Package names, file paths, and finding text come from the packages under review. The CLI strips control, bidi-override, and zero-width characters from everything it prints, and escapes them in `--json` output, so a hostile package cannot rewrite or reorder what a reviewer sees in a terminal. Requests never follow redirects, so the key is only ever sent to the configured origin.

The API surface it reads is described in [`docs/api-keys.md`](../docs/api-keys.md) and [`docs/openapi.json`](../docs/openapi.json).
