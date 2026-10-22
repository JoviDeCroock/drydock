# Detonation fixtures

Synthetic packages for exercising the detonation sandbox
(`containers/detonation/`) locally with `scripts/detonation-local.mjs`. We
wrote all of them; none is real malware.

- `benign/`: a postinstall that only prints `ok`.
- `canary-thief/`: a simulated credential thief. Its postinstall reads the
  planted fake `~/.npmrc` and `NPM_TOKEN`, attempts an HTTP POST and a `curl` to
  the unresolvable `exfil.drydock-test.invalid`, appends to `~/.bashrc`, and
  writes into a sibling package directory under `node_modules` when one exists.
- `flooder/`: a preinstall that creates 3000 files in `/tmp` to exhaust the
  harness's event budget, then reads `~/.npmrc` through a relative path
  (`cd ~ && cat .npmrc`). The read must survive as `/home/pkg/.npmrc` and the
  later steps must still run.
- `npm-run/`: a postinstall that runs its build through `npm run` and
  `yarn run`. Both read the planted `~/.npmrc` for their own config, which must
  not count as the package reading credentials.
- `npm-run-thief/`: the same shape, but the build script npm launches reads
  `~/.npmrc` itself, which must.
- `browser-lib/`: a web library (`"browser"` field) whose code only acts when
  `window` exists. Loading it under Node does nothing; the report must carry
  `browserTargeted: true` so the UI does not present the clean run as strong.

- `pypi-startup-thief/`: a defanged copy of the LiteLLM 1.107.0 shape for the
  PyPI path. `wheel/` installs `cook.pth`, which imports `cook.py` on every
  interpreter start; `cook.py` reads the planted fake `~/.pypirc`,
  `~/.aws/credentials`, and token env vars, then POSTs to
  `exfil.drydock-test.invalid`. A package-level `sitecustomize.py` fetches from
  `stage2.drydock-test.invalid`. `sdist/` builds the same package, and its
  `setup.py` reads `~/.git-credentials`, so the build step has its own signal.
  The report must place the credential read and the exfil DNS at `startup`.

`reports/` holds each fixture's captured report; `test/detonation-classify.test.ts`
classifies them, so re-capture them when the harness output changes.
`reports/pypi-requests.json` is the benign baseline: the public `requests`
2.32.3 wheel and sdist, run the same way.

Pack one with a `package/` prefix before running it:

```sh
tmp=$(mktemp -d) && cp -R test/fixtures/detonation/canary-thief "$tmp/package"
tar -czf "$tmp/canary-thief.tgz" -C "$tmp" package
node scripts/detonation-local.mjs "$tmp/canary-thief.tgz"
```

Pack the PyPI fixture as a wheel (a zip of `wheel/`) and an sdist (a gzipped
tar of the versioned directory), then pass both with `--pypi`.
`COPYFILE_DISABLE=1` keeps macOS from adding AppleDouble `._*` members:

```sh
tmp=$(mktemp -d) && fixture=test/fixtures/detonation/pypi-startup-thief
(cd "$fixture/wheel" && zip -qrX "$tmp/startup_hook_thief-1.0.0-py3-none-any.whl" .)
COPYFILE_DISABLE=1 tar -czf "$tmp/startup_hook_thief-1.0.0.tar.gz" -C "$fixture/sdist" startup_hook_thief-1.0.0
node scripts/detonation-local.mjs --pypi "$tmp/startup_hook_thief-1.0.0-py3-none-any.whl" "$tmp/startup_hook_thief-1.0.0.tar.gz"
```
