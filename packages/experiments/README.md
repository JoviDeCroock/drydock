# @pracht/experiments

Small public npm package used to exercise Staged Publish Review with real published and staged artifacts.

It usually has:

- no runtime dependencies;
- no explicit install lifecycle scripts;
- a tiny ESM entrypoint;
- a tiny CLI binary;
- a narrow `files` allowlist so package contents are predictable.

This test revision intentionally generates a source-root `binding.gyp` before staging without adding it to the package `files` allowlist. npm may infer `scripts.install = "node-gyp rebuild"` in the prepared staged manifest even though the tarball omits the gyp file. The probe is removed after the command so local workspace installs do not run node-gyp. Do not approve this staged publish.

## Publish the baseline package

From this directory:

```sh
npm login
npm run pack:dry-run
npm run publish:public
```

The first publish creates the previous-version artifact that the review app can diff future staged publishes against.

## Create a staged publish for review

This requires an npm CLI version that supports `npm stage` commands.

Make a small change, bump the version, then stage the package:

```sh
npm version patch --no-git-tag-version
npm run pack:implicit-node-gyp
npm run stage:publish
```

Copy the stage ID printed by npm into Staged Publish Review. Approval remains manual and outside the app:

```sh
npm stage approve <stage-id>
```

If the staged artifact was only for testing, discard it instead of approving it.
