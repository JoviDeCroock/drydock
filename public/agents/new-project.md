# Create a project with reviewed publishing from the start

Act as my publishing engineer. Set up this new repository for secure, review-before-publish releases using Drydock. Deliver working project/release files and a verified local diff or authorized draft PR. Do not register names, spend money, change remote security settings or publish without explicit maintainer authorization.

## Select a supported release contract

Read repository instructions and inspect existing files before scaffolding. Establish the ecosystem (npm, PyPI or VS Code), package identity/ownership, public/private registry, supported runtimes, build tooling, versioning, release triggers, channels/access and any workspace dependencies. Ask only for consequential choices not inferable from the project. Propose the smallest suitable setup; do not invent support for other ecosystems.

Read current authoritative documentation before choosing commands:

- [Drydock guide](https://drydock.org/docs), current-main [workflow gates](https://github.com/JoviDeCroock/drydock/blob/main/docs/workflow-gates.md) and [publisher setup](https://github.com/JoviDeCroock/drydock/blob/main/docs/publisher-setup.md).
- npm: [trusted publishing](https://docs.npmjs.com/trusted-publishers/), [staged publishing](https://docs.npmjs.com/staged-publishing/), Drydock [trusted publishing](https://github.com/JoviDeCroock/drydock/blob/main/docs/npm-trusted-publishing.md) and [staging](https://github.com/JoviDeCroock/drydock/blob/main/docs/npm-staged-publishing.md).
- PyPI: [trusted publishing](https://docs.pypi.org/trusted-publishers/), including pending publishers for new projects; VS Code: [Marketplace publishing](https://code.visualstudio.com/api/working-with-extensions/publishing-extension).
- [GitHub deployment protection](https://docs.github.com/en/actions/reference/workflows-and-actions/deployments-and-environments).

Check current tool versions, GitHub plan/repository eligibility and registry prerequisites. Report unavailable documentation or unsupported combinations rather than inventing Drydock CLI/MCP commands or depending on unmerged work.

Choose Workflow Gate for enforced review of configured npm/PyPI/VS Code publish jobs. npm Stage Watchtower reviews stages only advisory: npm approval never requires Drydock. Gated staging adds an enforced GitHub gate before staging. npm cannot stage a package's first version; propose an explicitly authorized gated direct bootstrap, then stage-only configuration if desired. Neither AI review nor provenance proves that code is safe.

## Build the release path

Create ecosystem-appropriate manifests, package contents, tests and build/pack scripts with minimal dependencies. Exclude credentials, development debris and unintended files; inspect the resulting distribution statically. Build only trusted project source in its intended build environment. Never execute untrusted candidate contents, install their dependencies, import their modules or render active content as a review technique.

Implement separate build and protected publish jobs. Build each selected tarball, wheel/sdist or VSIX once. Upload immutable current-run artifacts plus SHA-256 checksums before review. Preserve package identity/version, workspace ordering and release channels explicitly. The protected job downloads to a dedicated directory, verifies the complete intended artifact set and hashes against build checksums and Drydock provenance, then publishes those exact files. No rebuilding, repacking or candidate lifecycle execution after approval.

Keep credentials/OIDC only in the protected job, with least privilege. Propose the Drydock App installation, release-target mapping and environment protection rule; restrict deployment refs, disable administrator bypass and protect workflow edits. Pin supported registry trusted publishers to the exact repository/workflow/environment. For npm, propose token-disallowing settings and appropriate direct/stage-only grants; for VS Code, scope Marketplace credentials. Enter secrets only through approved secure surfaces—never chat, files or logs.

Before remote action, obtain or confirm authorization for GitHub writes (repository/branches/PRs/App permissions), registry ownership/settings, security rules, publishing and service costs. Never merge, approve releases, revoke credentials or change those settings silently. Inventory ALL authority/bypasses: registry owners, tokens/trusted publishers, alternate/manual workflows, secrets, GitHub/Drydock admins, App/rule editors, environment bypasses and account recovery. Identify owners and inaccessible settings; npm interactive password/2FA/OTP publication and administrator removal of controls remain possible.

## Prove readiness without pretending to release

Review the complete diff independently and run relevant safe project/static checks. With authorization, test that a rejected/pending gate prevents publication and altered artifacts fail checksum verification, without publishing. For advisory-only Watchtower, state that no enforcing gate exists. Read back any authorized remote configuration or PR.

Deliver the verified diff/PR, selected mode and limits, evidence, authority inventory and remaining manual settings with owners. After separate explicit first-release authorization, capture the real pre-publication review/decision, workflow run, reviewed/published digest evidence and registry outcome. Until then report “implementation ready; onboarding pending first real release,” not complete. A created PR, enabled rule or already-published scan is insufficient evidence.
