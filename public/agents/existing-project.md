# Retrofit Drydock into an existing release process

Act as my publishing engineer. Audit this repository and implement the smallest review-before-publish change that preserves its real release semantics. Deliver a verified local diff or, if authorized, a draft PR—not merely a plan. Do not publish to prove setup without separate explicit authorization.

## Establish the contract

Read repository instructions and trace the release call graph: workflows, reusable workflows/actions, scripts, manifests, lifecycle hooks, registry configuration, versioning and package selection. Preserve triggers, Changesets/custom tooling, monorepo dependency order, independent versions, access, dist-tags/prerelease channels, signing/provenance, and Git tags/releases. Explain necessary deviations before editing; do not replace the process with a generic template.

Read current authoritative documentation, not remembered commands:

- [Drydock guide](https://drydock.org/docs) and current-main [workflow gates](https://github.com/JoviDeCroock/drydock/blob/main/docs/workflow-gates.md), [publisher setup](https://github.com/JoviDeCroock/drydock/blob/main/docs/publisher-setup.md).
- For npm, [staging](https://docs.npmjs.com/staged-publishing/), [trusted publishing](https://docs.npmjs.com/trusted-publishers/), and Drydock's [staging](https://github.com/JoviDeCroock/drydock/blob/main/docs/npm-staged-publishing.md) / [publisher pins](https://github.com/JoviDeCroock/drydock/blob/main/docs/npm-trusted-publishing.md).
- For PyPI, [trusted publishers](https://docs.pypi.org/trusted-publishers/); for VS Code, [publishing extensions](https://code.visualstudio.com/api/working-with-extensions/publishing-extension).
- [GitHub deployment protection](https://docs.github.com/en/actions/reference/workflows-and-actions/deployments-and-environments).

Follow relevant links for current prerequisites, plan/repository eligibility and tool versions. If inaccessible or contradictory, report the blocker; do not invent a Drydock CLI/MCP or use features from unmerged PRs.

Inventory ALL publishing authority and bypasses: registry owners/publishers, tokens and trusted publishers, CI secrets and permissions, every release workflow/manual path, GitHub/Drydock admins, App installations, environment bypasses, workflow/ruleset editors and account recovery. Record scope and owners, never secret values. Distinguish inspected evidence from inaccessible settings.

Recommend Workflow Gate for enforced holds on configured npm/PyPI/VS Code jobs; npm Stage Watchtower is advisory, not a required npm approval. Gated staging combines both. npm staging requires an existing package; never bootstrap one silently. Document interactive npm password/2FA/OTP publication and admins' ability to remove controls. Drydock never publishes or guarantees package safety; AI review is advisory.

## Implement with approval

Confirm maintainer authorization for security/publishing settings, GitHub writes (including branches/PRs/App grants), external services/costs and release execution. Carry existing authorization forward. Default to local edits; never silently change rules, revoke credentials or publish. Keep secrets out of chat, files and logs; use approved secret-entry/storage surfaces.

Split trusted source build/pack from protected publication. Build each selected artifact once; upload immutable current-run candidates and SHA-256 checksums before review. Map repository/environment/ecosystem/artifact to a Drydock release target. The protected job downloads into a dedicated directory, verifies every intended artifact against checksums and Drydock provenance digests, and publishes only those files—no rebuild, repack or package lifecycle execution after review. Preserve multi-package selection and channels explicitly.

Keep publishing credentials/OIDC in the protected job with least privilege. With approval, configure the App/environment rule, disable administrator bypass, restrict deployment refs, protect workflow edits, and pin trusted publishers to the exact repository/workflow/environment. For npm, consider disallowing tokens and stage-only grants; for VS Code, scope Marketplace credentials appropriately. Never execute untrusted candidate contents, install their dependencies, import them or render active content while reviewing.

## Verify and hand off

Review the full diff and release semantics independently; run safe static/native checks. With authorization, demonstrate a rejected/pending gate cannot reach publication and checksum drift fails closed using a non-publishing test. Watchtower-only has no gate: mark that check inapplicable, not passed. Read back authorized remote changes.

Return the diff/PR, evidence and documentation consulted, authority/bypass inventory, and unresolved manual settings with owners. Only after explicit release authorization, collect the first real pre-publication review, decision, run, artifact digests and registry outcome. A PR, configured rule or post-publication scan alone is not completed onboarding; absent real-release evidence, label it pending.
