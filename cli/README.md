# drydock CLI

Read an organization's Drydock reviews, report exports, and release receipts from scripts and CI, and start new reviews with a key that has scan access. Approving a gate or recording a decision stays with signed-in maintainers in Drydock.

The CLI has no dependencies and runs on Node 22.14 or later. It is not published to npm yet, so run it from a checkout of this repository (`pnpm run drydock …` or `node cli/bin/drydock.mjs …`). Scripts and `--json` consumers should call `node cli/bin/drydock.mjs` directly, since `pnpm run` prints its own banner to stdout:

```sh
export DRYDOCK_API_KEY=ddk_…   # Organization settings → Integrations → API keys
pnpm run drydock whoami
```

The key is read from `DRYDOCK_API_KEY` only, never from a flag, so it stays out of shell history and process listings. `DRYDOCK_URL` (or `--url`) points the CLI at a self-hosted deployment; plain `http` is accepted only for `localhost`.

## Commands

| Command                                       | What it does                                                                                      |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| `whoami`                                      | The key's organization, name, expiry, and access (`read` or `scan`)                               |
| `scans list [--filter F] [--limit N]`         | Reviews, newest first (`undecided` by default; `all`, `publish`, `no_publish`, …)                 |
| `scans get <review-id>`                       | One review and its findings                                                                       |
| `scans wait <review-id> [--fail-on RISK]`     | Poll until the review completes (`--timeout`, `--interval` in seconds)                            |
| `report <review-id> [--output FILE]`          | The byte-stable `drydock.report.v2` export                                                        |
| `receipt <review-id> [--output FILE]`         | The Release Receipt, refused unless it matches the `x-drydock-receipt-sha256` digest sent with it |
| `releases <package> [--ecosystem E]`          | One package's reviews in the organization                                                         |
| `gate <review-id>`                            | The GitHub workflow gate a review belongs to                                                      |
| `diff <package> <from> <to> [--fail-on RISK]` | Diff two published releases through the anonymous public diff; needs no key                       |

### Starting reviews

These need a key created with **scan access**; a read-only key gets a clear error and exit `1`. A review started with a key is owned by the key's creator and audited with the key's name.

| Command                                           | What it does                                                                       |
| ------------------------------------------------- | ---------------------------------------------------------------------------------- |
| `scans start <package>@<version> [--ecosystem E]` | Review a published version against the release before it, or `--baseline VERSION`  |
| `scans start --stage <stage-id>`                  | Review one npm staged publish                                                      |
| `check-npm`                                       | The dashboard's "Check npm": discover new staged publishes and start their reviews |

Each takes `--wait` to poll the started reviews until they finish (`--timeout`, `--interval` as for `scans wait`); `scans start --wait` also takes `--fail-on`. Scoped names keep their leading `@`: `scans start @acme/cli@2.0.0`. `check-npm` refuses `--fail-on` with a usage error, because it is not a gate (below); `check-npm --wait` exits `1` when a review it started failed.

Starting a stage that already has a review (one that has not failed) starts nothing: `scans start --stage` prints `already reviewing <review-id>` and, with `--wait`, waits for that review. A re-run CI job therefore gates on the same review instead of paying for a second one.

`--json` prints the API response instead of a table (with `--wait`, the start response plus a `results` array of final statuses). A flag the command does not take is a usage error.

`--fail-on RISK` (`low`, `medium`, `high`, `critical`) compares the release risk: the findings the release introduces, not ones already in the previous version. That is the risk the workflow gate decides on. A review with no graded release delta (the previous version was not compared, or the review predates the split) is compared on its overall risk, and a risk the CLI does not recognize counts as at the threshold. Every wait retries rate limits (honouring `Retry-After`), server errors, and network errors with backoff until `--timeout`.

Exit codes: `0` success, `1` request or review failed, `2` usage error, `3` release risk at or above `--fail-on`, `4` a wait timed out before the review finished (or before its status could be read).

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

After `npm stage publish`, a key with scan access can review the stage without waiting for the 15-minute discovery cron. Gate on the stage id `npm stage publish` printed (with the same Drydock checkout as above):

```yaml
- name: Review the staged publish
  env:
    DRYDOCK_API_KEY: ${{ secrets.DRYDOCK_SCAN_KEY }}
  run: node drydock/cli/bin/drydock.mjs scans start --stage "$STAGE_ID" --wait --fail-on high
```

`scans start --stage` always starts a review of that stage, so the step gates on it even if discovery reviewed it first. `check-npm --wait` waits only for reviews it started itself: if the cron already picked the stage up, it starts nothing and exits `0`, so it is not a gate.

## Output safety

Package names, file paths, and finding text come from the packages under review. The CLI strips control, bidi-override, and zero-width characters from tables and error messages, and escapes them as `\uXXXX` in JSON output (`--json`, and `report` or `receipt` printed to stdout), so a hostile package cannot rewrite or reorder what a reviewer sees in a terminal. Escaped JSON parses to the same value but is not the same bytes: use `--output FILE` for the exact bytes a receipt digest covers. Requests never follow redirects, so the key is only ever sent to the configured origin.

The API surface it reads is described in [`docs/api-keys.md`](../docs/api-keys.md) and [`docs/openapi.json`](../docs/openapi.json).
