# Test package for staged publishes

This repository includes `packages/experiments`, a tiny publishable npm package named `@pracht/experiments` for end-to-end testing against real npm staged publishes.

## Why it exists

The application needs real package artifacts to verify the full review flow:

1. publish a baseline package version to npm;
2. create a later staged publish;
3. paste the npm stage ID into the app;
4. compare the staged tarball against the published baseline;
5. manually approve or discard the staged publish outside the app.

The baseline package is intentionally boring and predictable: no dependencies, no explicit install lifecycle scripts, a small ESM entrypoint, a small CLI binary, and a `files` allowlist. Individual staged-test branches may temporarily add risky probes; discard those staged publishes after review.

## Baseline publish

From `packages/experiments`:

```sh
npm login
npm run pack:dry-run
npm run publish:public
```

The package has `publishConfig.access = public`, but scoped packages should still be published from an npm account that has access to the `@pracht` scope.

## Staged publish test

This requires an npm CLI version that supports `npm stage` commands.

From `packages/experiments`:

```sh
npm version patch --no-git-tag-version
npm run pack:dry-run
npm run stage:publish
```

Copy the printed stage ID into Staged Publish Review. The app reviews the staged artifact only; final npm approval remains a human action:

```sh
npm stage approve <stage-id>
```

For disposable tests, discard the staged publish instead of approving it.

## Useful staged changes

For low-risk smoke tests, change only `index.js`, `index.d.ts`, `README.md`, or `CHANGELOG.md`.

For deterministic-rule tests, introduce a temporary change that should be flagged, such as adding an install lifecycle script, adding network-capable code, adding dynamic-code primitives, or adding a credential-looking file. Do not approve those staged publishes.

### Implicit node-gyp probe

The current `0.1.2` fixture adds a root `binding.gyp` without defining `install`, `preinstall`, or `gypfile=false`. It intentionally leaves `binding.gyp` out of the package `files` allowlist. This tests both paths for npm's implicit `scripts.install = "node-gyp rebuild"` behavior:

- tarball-derived review when a root `*.gyp` file is packed;
- staged-view metadata recovery when npm inferred the install hook from source files that are absent from the packed tarball.

Expected result: a staged review for this fixture should include an `install-script.implicit-node-gyp` high-severity finding. Discard the staged publish after testing.
