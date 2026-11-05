# Set up reviewed publishing for a new project

Act as my publishing engineer. We will set up this new repository so every
release is built once, reviewed in Drydock, and published from a protected job.
Work through the checkpoints below and wait for my answer at each one. Do not
register package names, spend money, change remote settings, open a pull
request, or publish unless I authorize that step.

Read current documentation instead of relying on memory:

- Drydock: [guide](https://drydock.org/docs), [workflow
  gates](https://github.com/JoviDeCroock/drydock/blob/main/docs/workflow-gates.md),
  [guided publisher
  setup](https://github.com/JoviDeCroock/drydock/blob/main/docs/publisher-setup.md),
  npm
  [staging](https://github.com/JoviDeCroock/drydock/blob/main/docs/npm-staged-publishing.md)
  and [trusted
  publishing](https://github.com/JoviDeCroock/drydock/blob/main/docs/npm-trusted-publishing.md).
- Registries and GitHub: npm [trusted
  publishers](https://docs.npmjs.com/trusted-publishers/) and [staged
  publishing](https://docs.npmjs.com/staged-publishing/), [PyPI trusted
  publishers](https://docs.pypi.org/trusted-publishers/) (including pending
  publishers), [VS Code
  publishing](https://code.visualstudio.com/api/working-with-extensions/publishing-extension),
  [GitHub
  environments](https://docs.github.com/en/actions/reference/workflows-and-actions/deployments-and-environments).

Drydock has no CLI or MCP server for setup. If a link is unreachable or
contradicts this prompt, tell me instead of guessing.

## 1. Agree on the release contract

Read the repository and its instructions first. Confirm with me the ecosystem
(npm, PyPI, or VS Code extension), package name and owner, registry, supported
runtimes, build tool, versioning, release trigger, and channels. Ask only about
choices the files do not answer. Then stop.

## 2. Choose the Drydock mode with me

Recommend a **Workflow Gate (GitHub Actions), enforced**: a GitHub Environment
holds the publish job until I approve the build artifacts in Drydock.

For npm, also explain the alternatives:

- **Stage Watchtower, advisory**: Drydock reviews packages after
  `npm stage publish`, but npm approval does not require Drydock.
- **Gated staging**: the gated job runs `npm stage publish`.

npm cannot stage a package's first version, so gated staging starts with a gated
direct first release, which I must authorize separately. Drydock never
publishes, and its AI review is advisory.

Wait for my choice.

## 3. Build the release path

Create the manifest, package contents, tests, and build or pack scripts with
minimal dependencies. Exclude credentials and development files, and check the
packed contents.

Write the workflow as two jobs:

- a build job that builds each tarball, wheel or sdist, or VSIX once, then
  uploads the files and `SHA256SUMS` as one artifact named
  `npm-release-candidates`, `pypi-release-candidate`, or
  `vscode-release-candidate`;
- a protected publish job that targets the GitHub Environment, downloads only
  that artifact into a dedicated directory, verifies the checksums, and
  publishes exactly those files without rebuilding, repacking, or running
  lifecycle scripts.

Keep registry credentials and `id-token: write` in the protected job only, and
hold that job to the protected-job rules in the guided setup document: allowed
actions, commands, permissions, and credentials. Generate provenance in the
protected job, for example `npm publish --provenance`. Show me the diff, then
stop.

## 4. Hand me the settings only I can change

Give me a checklist with the exact values:

- install the Drydock GitHub App on this repository;
- create the GitHub Environment, add Drydock as its protection rule, turn off
  administrator bypass, and limit which branches or tags can deploy;
- in Drydock settings, map the repository, environment, ecosystem, and artifact
  name as a release target;
- protect the workflow file with a ruleset or branch protection and `CODEOWNERS`
  review;
- for Watchtower or gated staging, connect a read-only npm token in Drydock
  under Organization settings → npm access.

For the registry:

- PyPI: add a pending trusted publisher for this repository, workflow file, and
  environment before the first upload.
- npm: check npm's current documentation for whether trusted publishing can be
  configured before a package exists. If it cannot, the first gated release uses
  a short-lived granular token stored only as a secret of the protected
  environment. After that release, pin trusted publishing to this repository,
  workflow file, and environment, delete the token, and disallow token
  publishing.
- VS Code Marketplace: there is no trusted publisher; store the publishing token
  only as a secret of the protected environment.

Never ask me to paste secrets into this conversation, a file, or a log.

## 5. Verify, then wait for the first release

Review the full diff again and run the project's checks. Show me, by reading the
workflow, that the publish job verifies `SHA256SUMS` before it publishes. Do not
start a publish job to test this, and do not publish.

Then read back what is configured, using my own signed-in tools:

- `gh api repos/OWNER/REPO/environments/ENVIRONMENT` shows `can_admins_bypass`
  is `false` and `deployment_branch_policy` is not `null`.
- `gh api repos/OWNER/REPO/environments/ENVIRONMENT/deployment_protection_rules`
  lists an enabled custom rule whose `app.slug` is the Drydock App I installed.
- npm: once the package exists, `npm trust list PACKAGE` names this repository,
  workflow file, and environment. PyPI and the VS Code Marketplace have no
  read-back command, so ask me to confirm their settings.
- Ask me to run **Check setup status** in Drydock settings (Settings →
  Integrations → GitHub App) and paste the text from **Copy for your agent**.
  Drydock has no setup API, so this is how its release-target and first-review
  checks reach you.

Report setup as "ready, pending first release" only when every configuration
check passes. It is complete only after the first real release has gone through
a Drydock review before publication. A merged PR or an enabled rule alone does
not complete setup.
