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

`reports/` holds each fixture's captured report; `test/detonation-classify.test.ts`
classifies them, so re-capture them when the harness output changes.

Pack one with a `package/` prefix before running it:

```sh
tmp=$(mktemp -d) && cp -R test/fixtures/detonation/canary-thief "$tmp/package"
tar -czf "$tmp/canary-thief.tgz" -C "$tmp" package
node scripts/detonation-local.mjs "$tmp/canary-thief.tgz"
```
