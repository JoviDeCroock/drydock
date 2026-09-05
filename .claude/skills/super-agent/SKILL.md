---
name: super-agent
description: Own a complex Drydock task end to end with evidence-driven planning, parallel agents, recovery, integration, and verified completion. Use for broad or sustained work, not a small local edit.
---

# Super agent execution

Take responsibility for the user's outcome across investigation, implementation, verification, and any authorized delivery. Choose the depth and tools the task needs. Autonomy means resolving the work within scope while retaining Drydock's trust boundaries and the user's control over consequential choices.

## Establish the outcome

Translate the request into observable completion conditions: the behavior that must work, affected users/adapters, constraints that must survive, and evidence needed to establish success. Infer routine details from the repository and session. Make material assumptions visible; ask early when competing interpretations would produce meaningfully different products.

Read `docs/README.md` and the relevant ownership layer, then follow the actual call path. Include error paths, persisted state, and equivalent adapters when they affect the outcome. Form a hypothesis and use the cheapest decisive check before committing to a broad implementation. Update the plan when evidence changes it.

For sustained work, keep a short checkpoint in `.context/`: objective, decisions, changed files, evidence, blockers, and next actions. Resume from verified state after a handoff or context reset. The checkpoint supports execution; maintaining it is not a separate deliverable.

## Parallelize with ownership

Use available subagents when an independent task can advance alongside useful main-thread work. Good units include tracing an unfamiliar subsystem, implementing one adapter in distinct files, constructing regression evidence, or independently reviewing a completed fix. Handle small or tightly coupled tasks directly.

Give each agent the outcome, relevant context, constraints, owned files, and required evidence. Avoid overlapping edits; shared contracts need one owner. Ask investigators for findings tied to code and behavior. Give independent reviewers the request and raw artifacts without coaching them toward a desired conclusion.

Keep the coordinating agent on integration and the next dependency that unblocks work. Read results critically: reconcile conflicting assumptions, inspect changes, and verify the assembled behavior. A subagent's success report is evidence to assess, not a substitute for integration. Cancel or redirect work made obsolete by new evidence.

## Execute and recover

Implement the smallest complete change that achieves the outcome. Extend existing owners and contracts; address every equivalent surface implicated by the same defect. Use task-specific skills for ecosystem, detection, Signals, shared primitives, and module moves.

When a check fails, classify it: regression, incorrect assumption, environment problem, or unrelated baseline failure. Investigate the relevant evidence and try a safe repair or alternative. Do not weaken tests or trust boundaries to obtain a pass. Do not expand the branch to absorb unrelated defects.

Exhaust reasonable local options before calling something blocked. If a user decision or unavailable access is essential, ask for that specific input and continue independent work. Stop dependent work until the required answer arrives. State the attempted action and concrete failure when an external block remains.

Preserve existing user changes and session authorization. Complete already-authorized implementation, integration, and delivery without repeatedly requesting permission. Broader scope and genuinely destructive choices still require authority; tool availability alone does not supply it.

## Establish completion

Verify observable behavior and affected contracts using `docs/release-safety.md`. Use narrow tests while iterating, then the required broader checks for the integrated change. Exercise user-visible behavior with [verify-live](../verify-live/SKILL.md) when browser evidence is needed. Do not substitute screenshots for backend invariants or a green typecheck for a working flow.

For review fixes or branch finishing, follow [pre-pr](../pre-pr/SKILL.md): triage first, fix accepted findings across the parity class, adversarially review the fix diff, and apply its stopping rule. Do not keep reopening clean work to generate more polish.

Before reporting completion, compare the result with the original request and later steering. Finish omitted requirements, update affected docs, and complete authorized delivery. Report the outcome, decisive verification, and any material limits. If blocked, distinguish completed work from the exact remaining dependency; do not present an incomplete result as done.
