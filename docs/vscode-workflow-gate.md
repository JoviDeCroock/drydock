# VS Code workflow-gate mode

This compatibility page is intentionally short. Canonical workflow-gate documentation now lives in [`workflow-gates.md`](./workflow-gates.md), including the [VS Code workflow-gate notes](./workflow-gates.md#vs-code-workflow-gate-notes).

Use VS Code workflow gates when a GitHub Actions workflow packages an extension into a `.vsix` and should be paused by a GitHub Environment protection rule before it is published to the Marketplace. The workflow must upload the exact `vsce package` artifact that the publish job later publishes; repacking after approval breaks Drydock's review boundary. Identity comes from `extension/package.json` inside the VSIX (`publisher.name` plus `version`), and Drydock resolves a best-effort baseline from the public VS Code Marketplace as a diff aid only — see the [VS Code workflow-gate notes](./workflow-gates.md#vs-code-workflow-gate-notes) for the full shape.
