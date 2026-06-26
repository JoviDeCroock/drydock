# npm workflow-gate inspection

This compatibility page is intentionally short. Canonical workflow-gate documentation now lives in [`workflow-gates.md`](./workflow-gates.md), including the [npm workflow-gate notes](./workflow-gates.md#npm-workflow-gate-notes).

Use npm workflow gates when the release is built in GitHub Actions and should be paused by a GitHub Environment protection rule instead of by npm registry staging. The workflow must upload the exact `npm pack` artifact that the publish job later publishes; rebuilding after clearance breaks Drydock's inspection boundary.
