# Drydock release review action

Upload your release candidate to Drydock while CI builds it, and refuse to
publish bytes that drifted from what was reviewed.

No API key. The action authenticates with a short-lived GitHub Actions OIDC
token, so nothing Drydock-shaped lives in your repository secrets. Add
`permissions: id-token: write` to the job and you are done.

This action has **no runtime dependencies** and is not bundled — `index.js` is
the code that runs. A tool that inspects your release pipeline should be
readable in the place you install it from.

## Quick start (npm)

```yaml
permissions:
  contents: read
  id-token: write

jobs:
  pack:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: npm ci
      - run: npm pack
      - uses: drydock/release-action@v1
        with:
          path: "*.tgz"
      - uses: actions/upload-artifact@v4
        with:
          name: npm-release-candidates
          path: "*.tgz"

  publish:
    needs: pack
    runs-on: ubuntu-latest
    environment: production
    steps:
      - uses: actions/download-artifact@v4
        with:
          name: npm-release-candidates
      # Fails closed if these bytes are not the ones Drydock reviewed.
      - uses: drydock/release-action@v1
        with:
          mode: verify
          path: "*.tgz"
      - run: npm publish *.tgz
        env:
          NODE_AUTH_TOKEN: ${{ secrets.NPM_TOKEN }}
```

Review starts when the `pack` job uploads, not when `publish` asks for
permission — so by the time the protected environment is reached, the review is
usually already done and often already approved.

## Monorepos

Every job in one workflow run uploads into the same release set, and Drydock
fans it out into one review per package. In a matrix build, only the last leg
seals:

```yaml
jobs:
  build:
    strategy:
      matrix:
        package: [core, cli, plugin]
    steps:
      - run: npm pack --workspace packages/${{ matrix.package }}
      - uses: drydock/release-action@v1
        with:
          path: "*.tgz"
          seal: false # do not review a half-uploaded release

  finalize:
    needs: build
    steps:
      - uses: drydock/release-action@v1
        with:
          path: "" # nothing new to upload
          seal: true
```

Distinct package names become separate reviews and separate approvals:
approving `core` never approves `cli`.

## Blocking on the result

| `wait-for`       | Behavior                                                                        |
| ---------------- | ------------------------------------------------------------------------------- |
| `none` (default) | Return once the upload is accepted.                                             |
| `review`         | Block until Drydock finishes reviewing; print per-package risk.                 |
| `decision`       | Block until a maintainer decides every package; fail the job if any is blocked. |

`decision` turns the action into a gate on its own, for repositories that do not
use GitHub Environments. If you do use one, prefer leaving this at `none` and
letting the environment's protection rule collect the decision — the job does
not burn runner minutes waiting.

## Inputs

See [`action.yml`](./action.yml). The ones that matter most:

- `path` — globs to upload or verify (`*` and `**` supported).
- `mode` — `publish` (default) or `verify`.
- `seal` — set `false` in matrix legs that are not last.
- `ecosystem` — pin `npm` / `pypi` / `vscode`; leave unset to auto-detect.
- `release-key` — separate independent releases produced by one run.
- `api-url` — for a self-hosted Drydock.

## What Drydock sees

Only the artifact bytes you point it at, plus the claims GitHub signed into the
OIDC token: repository, run, workflow ref, commit, actor. The bytes are parsed
in a credentials-free sandbox, and they are deleted once the review completes —
the digests stay as provenance, the packages do not.
