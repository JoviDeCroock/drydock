# Add Drydock to an existing project

Act as my publishing engineer. We will add Drydock review to this repository's release process together, one checkpoint at a time. Stop at each checkpoint and wait for my answer. Do not publish, change remote settings, or open a pull request unless I authorize that step.

Read current documentation instead of relying on memory:

- Drydock: [guide](https://drydock.org/docs), [workflow gates](https://github.com/JoviDeCroock/drydock/blob/main/docs/workflow-gates.md), [guided publisher setup](https://github.com/JoviDeCroock/drydock/blob/main/docs/publisher-setup.md), npm [staging](https://github.com/JoviDeCroock/drydock/blob/main/docs/npm-staged-publishing.md) and [trusted publishing](https://github.com/JoviDeCroock/drydock/blob/main/docs/npm-trusted-publishing.md).
- Registries and GitHub: npm [staged publishing](https://docs.npmjs.com/staged-publishing/) and [trusted publishers](https://docs.npmjs.com/trusted-publishers/), [PyPI trusted publishers](https://docs.pypi.org/trusted-publishers/), [VS Code publishing](https://code.visualstudio.com/api/working-with-extensions/publishing-extension), [GitHub environments](https://docs.github.com/en/actions/reference/workflows-and-actions/deployments-and-environments).

Drydock has no CLI or MCP server for setup. If a link is unreachable or contradicts this prompt, tell me instead of guessing.

## 1. Explain how this project releases today

Trace the real release path: workflows and reusable actions, scripts, manifests, lifecycle hooks, registry configuration, versioning (Changesets or custom tooling), package selection, dist-tags or channels, provenance, and Git tags. List every way a release can reach the registry: CI jobs, manual runs, local `npm publish` or `twine upload`, tokens, and trusted publishers. Record owners and scopes, never secret values. Mark what you could not inspect.

Summarize this for me in plain language, then stop.

## 2. Choose the Drydock mode with me

Explain the options that fit this project and recommend one:

- **Workflow Gate (GitHub Actions), enforced.** A GitHub Environment holds the protected publish job until I approve the build artifacts in Drydock. Works for npm, PyPI, and VS Code.
- **Stage Watchtower, advisory, npm only.** Drydock reviews packages after `npm stage publish`. I still approve in npm, and npm does not require Drydock's decision.
- **Gated staging, npm.** The gated job runs `npm stage publish`, so Drydock reviews before npm holds the package.

npm cannot stage a package's first version. A gate covers only the configured job; repository admins can bypass or remove it, and other publishing paths from step 1 stay open until I close them. Drydock never publishes, and its AI review is advisory.

Wait for my choice.

## 3. Prepare the change

If the Drydock GitHub App is installed and I am an owner or admin of the Drydock organization, Drydock can draft this change itself: Settings → Integrations → GitHub App → Set up a release workflow. Offer that first. It opens a draft PR checked against Drydock's validation rules. Then review that PR with me against step 1 instead of writing a second version.

Otherwise, edit locally. Keep the existing triggers, versioning, package selection, channels, and provenance. Split the workflow into:

- a build job that builds and packs each artifact once, then uploads the files and `SHA256SUMS`;
- a protected publish job that targets the GitHub Environment, downloads only those files into a dedicated directory, verifies the checksums, and publishes exactly those files without rebuilding, repacking, or running lifecycle scripts.

Keep registry credentials and `id-token: write` in the protected job only, and hold that job to the protected-job rules in the guided setup document: allowed actions, commands, permissions, and credentials. Explain any change to release behavior before making it. Show me the diff, then stop.

## 4. Hand me the settings only I can change

Give me a checklist with the exact values from this repository:

- install the Drydock GitHub App on this repository;
- create the GitHub Environment, add Drydock as its protection rule, turn off administrator bypass, and limit which branches or tags can deploy;
- in Drydock settings, map the repository and environment to a release target;
- pin the registry's trusted publisher to this repository, workflow, and environment, then remove or restrict the other publishing paths from step 1.

Never ask me to paste secrets into this conversation, a file, or a log.

## 5. Verify, then wait for the first release

Review the full diff again and run the project's static checks. Then read back what is configured, using my own signed-in tools:

- `gh api repos/OWNER/REPO/environments/ENVIRONMENT`: `can_admins_bypass` is `false` and `deployment_branch_policy` is not `null`.
- `gh api repos/OWNER/REPO/environments/ENVIRONMENT/deployment_protection_rules`: one enabled custom rule whose `app.slug` is the Drydock App I installed.
- npm: `npm trust list PACKAGE` names this repository, workflow file, and environment. PyPI and the VS Code Marketplace have no read-back command, so ask me to confirm their settings.
- Ask me to run **Check setup status** in Drydock settings and paste the text from **Copy for your agent**. Drydock has no setup API, so this is how its release-target and first-review checks reach you.

If I authorize a test run, show that a pending or rejected gate stops the publish job and that a changed artifact fails the checksum check. Do not publish to test this. With Watchtower only, skip the GitHub checks and say that there is no enforcing gate.

Report setup as "ready, pending first release" until a real release has gone through a Drydock review before publication. A merged PR, an enabled rule, or a scan of a package that is already published does not complete setup.
