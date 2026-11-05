# Add Drydock to an existing project

Act as my publishing engineer. We will add Drydock review to this repository's
release process together, one checkpoint at a time. Stop at each checkpoint and
wait for my answer. Do not publish, change remote settings, or open a pull
request unless I authorize that step.

Read current documentation instead of relying on memory:

- Drydock: [guide](https://drydock.org/docs), [workflow
  gates](https://github.com/JoviDeCroock/drydock/blob/main/docs/workflow-gates.md),
  [guided publisher
  setup](https://github.com/JoviDeCroock/drydock/blob/main/docs/publisher-setup.md),
  npm
  [staging](https://github.com/JoviDeCroock/drydock/blob/main/docs/npm-staged-publishing.md)
  and [trusted
  publishing](https://github.com/JoviDeCroock/drydock/blob/main/docs/npm-trusted-publishing.md).
- Registries and GitHub: npm [staged
  publishing](https://docs.npmjs.com/staged-publishing/) and [trusted
  publishers](https://docs.npmjs.com/trusted-publishers/), [PyPI trusted
  publishers](https://docs.pypi.org/trusted-publishers/), [VS Code
  publishing](https://code.visualstudio.com/api/working-with-extensions/publishing-extension),
  [GitHub
  environments](https://docs.github.com/en/actions/reference/workflows-and-actions/deployments-and-environments).

Drydock has no CLI or MCP server for setup. If a link is unreachable or
contradicts this prompt, tell me instead of guessing.

## 1. Explain how this project releases today

Trace the real release path: workflows and reusable actions, scripts, manifests,
lifecycle hooks, registry configuration, versioning (Changesets or custom
tooling), package selection, dist-tags or channels, provenance, and Git tags.
List every way a release can reach the registry: CI jobs, manual runs, local
`npm publish` or `twine upload`, tokens, and trusted publishers. Record owners
and scopes, never secret values. Mark what you could not inspect.

Summarize this for me in plain language, then stop.

## 2. Choose the Drydock mode with me

Explain the options that fit this project and recommend one:

- **Workflow Gate (GitHub Actions), enforced.** A GitHub Environment holds the
  protected publish job until I approve the build artifacts in Drydock. Works
  for npm, PyPI, and VS Code.
- **Stage Watchtower, advisory, npm only.** Drydock reviews packages after
  `npm stage publish`. I still approve in npm, and npm does not require
  Drydock's decision.
- **Gated staging, npm.** The gated job runs `npm stage publish`, so Drydock
  reviews before npm holds the package.

npm cannot stage a package's first version. A gate covers only the configured
job; repository admins can bypass or remove it, and other publishing paths from
step 1 stay open until I close them. Drydock never publishes, and its AI review
is advisory.

Wait for my choice.

## 3. Prepare the change

For a Workflow Gate or gated staging, Drydock can draft the change itself:
Settings → Integrations → GitHub App → **Prepare a release workflow**. That
needs an existing workflow that publishes the package, the Drydock GitHub App
installed on this repository with Contents, Pull requests and Workflows write
access, me as an owner or admin of the Drydock organization, and AI review not
switched off for the organization. If those hold, offer it first. It opens a
draft PR checked against Drydock's validation rules; review that PR with me
against step 1 instead of writing a second version.

Otherwise, edit locally. Keep the existing triggers, versioning, package
selection, channels, and provenance. If the project only publishes from a
laptop, propose a new release workflow instead. Split the release into:

- a build job that builds and packs each artifact once, then uploads the files
  and `SHA256SUMS` as one artifact named `npm-release-candidates`,
  `pypi-release-candidate`, or `vscode-release-candidate`;
- a protected publish job that targets the GitHub Environment, downloads only
  that artifact into a dedicated directory, verifies the checksums, and
  publishes exactly those files without rebuilding, repacking, or running
  lifecycle scripts.

Keep registry credentials and `id-token: write` in the protected job only, and
hold that job to the protected-job rules in the guided setup document: allowed
actions, commands, permissions, and credentials. Generate provenance in the
protected job (for example `npm publish --provenance`); if the project signs or
attests in the build job, raise it with me instead of moving `id-token: write`.
For Watchtower, change only the publish command to `npm stage publish`. Explain
any change to release behavior before making it. Show me the diff, then stop.

## 4. Hand me the settings only I can change

Give me a checklist with the exact values from this repository.

For a Workflow Gate or gated staging:

- install the Drydock GitHub App on this repository;
- create the GitHub Environment, add Drydock as its protection rule, turn off
  administrator bypass, and limit which branches or tags can deploy;
- in Drydock settings, map the repository, environment, ecosystem, and artifact
  name as a release target;
- protect the workflow file with a ruleset or branch protection and `CODEOWNERS`
  review.

For Stage Watchtower or gated staging, connect a read-only npm token in Drydock
under Organization settings → npm access.

For the registry:

- npm and PyPI: pin the trusted publisher to this repository, workflow file, and
  environment. For npm, grant stage-only permission when staging, and disallow
  token publishing once trusted publishing works.
- VS Code Marketplace: there is no trusted publisher; store the publishing token
  only as a secret of the protected environment.
- Remove or restrict the other publishing paths from step 1.

Never ask me to paste secrets into this conversation, a file, or a log.

## 5. Verify, then wait for the first release

Review the full diff again and run the project's static checks. Show me, by
reading the workflow, that the publish job verifies `SHA256SUMS` before it
publishes. Do not start a publish job to test this, and do not publish.

Then read back what is configured, using my own signed-in tools:

- For a gate: `gh api repos/OWNER/REPO/environments/ENVIRONMENT` shows
  `can_admins_bypass` is `false` and `deployment_branch_policy` is not `null`,
  and
  `gh api repos/OWNER/REPO/environments/ENVIRONMENT/deployment_protection_rules`
  lists an enabled custom rule whose `app.slug` is the Drydock App I installed.
- For a gate: ask me to run **Check setup status** in the same Drydock settings
  panel and paste the text from **Copy for your agent**. Drydock has no setup
  API, so this is how its release-target and first-review checks reach you.
- npm: `npm trust list PACKAGE` names this repository, workflow file, and
  environment. PyPI and the VS Code Marketplace have no read-back command, so
  ask me to confirm their settings.
- Watchtower only: say that there is no enforcing gate, and ask me to confirm
  Drydock shows the next staged version.

Report setup as "ready, pending first release" only when every configuration
check passes. It is complete only after a real release, not a test run, has gone
through a Drydock review before publication. A merged PR, an enabled rule, or a
scan of a package that is already published does not complete setup.
