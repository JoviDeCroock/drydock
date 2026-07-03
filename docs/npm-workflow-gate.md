# npm workflow-gate mode

This compatibility page is intentionally short. Canonical workflow-gate documentation now lives in [`workflow-gates.md`](./workflow-gates.md), including the [npm workflow-gate notes](./workflow-gates.md#npm-workflow-gate-notes).

Use npm workflow gates when the release is built in GitHub Actions and should be paused by a GitHub Environment protection rule instead of by npm registry staging. The workflow must upload the exact `npm pack` artifact that the publish job later publishes; rebuilding after approval breaks Drydock's review boundary. The recommended workflow records `SHA256SUMS` for the packed tarballs at build time and re-checks it in the publish job before `npm publish`, so the digests in the report Provenance section can be verified against the published bytes — see the [npm workflow-gate notes](./workflow-gates.md#npm-workflow-gate-notes) for the full shape.
