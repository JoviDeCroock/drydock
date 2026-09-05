---
name: pre-pr
description: Triage review findings or finish a Drydock branch for review, push, PR, or landing, with verification and an adversarial pass over accepted fixes.
---

# Review and finish a branch

Carry authorized branch work through verification and landing without repeated permission checks. Determine scope from the whole session: a request to fix and land includes the necessary integration, push, PR, and merge work; a request for local preparation ends with a verified local result. Own the remaining steps instead of handing back a checklist.

## Review scope and triage

Read `.context/review-log.md` before fixing review findings; create it if absent. Record the review base, reviewed HEAD SHA, and any uncommitted files included. On the first pass, inspect the branch diff against `origin/main` plus staged, unstaged, and relevant untracked changes. On subsequent passes, review the delta since the last-reviewed SHA plus working changes; revisit older code only when the delta or new evidence calls its earlier conclusion into question.

Mark every pending finding **accept**, **decline**, or **defer** before editing. Record severity, concrete trigger/impact, and a short reason. Declining a P3 with a misconfiguration or degenerate trigger needs only one line of reasoning. A hypothetical edge case without a credible impact is not automatically a fix.

Fix accepted findings across the whole parity class: every adapter, duplicate implementation, and equivalent UI/API surface with the same contract. Test the shared behavior at the narrowest useful layer. Record each outcome so later reviews do not reopen it without new evidence. Keep unrelated defects and polish out of the fix diff.

## Verification and adversarial re-review

Use `docs/release-safety.md` for coverage. Run `pnpm run verify` before finishing; add `pnpm run test:e2e` when registry behavior or end-to-end scan workflows changed. Fix failures caused by the branch; report unrelated or environmental failures with their evidence rather than silently absorbing them into scope. Update the relevant docs or record `docs checked, no update needed`.

After accepted fixes, always adversarially re-review the **fix diff** before declaring completion. Look for broken behavior, incomplete parity, fail-open trust boundaries, missing regression coverage, and contradictory docs. Include working changes, not just committed HEAD. Record the reviewed revision/scope, findings, and result in the log. Triage any new findings before further edits; rerun checks affected by those edits.

When verification passes, no accepted fixes or unresolved P1/P2 remain, and the delta review finds no P1/P2, the branch is done. Land it when authorized and file remaining P3 polish as follow-up issues rather than starting another hardening round. If external actions are outside scope, report readiness and the follow-ups locally. Do not treat a deferred P1/P2 as a clean review.

A log entry can be brief:

```text
Review: base <SHA>, reviewed <SHA>; working changes <paths or none>
P2 <finding>: accept — <trigger/impact>; fixed <surfaces>; verified <check>
P3 <finding>: decline/defer — <reason or follow-up issue>
Adversarial fix review: <revision/scope>; <findings or no P1/P2>; <remaining work>
```

## Authorized remote actions

Fetch immediately before pushing and inspect the current branch's upstream/divergence. Integrate remote work before pushing; preserve other contributors' commits. Do not force-push by default. A history rewrite needs authorization and a freshly inspected remote revision protected by an explicit lease.

For a new branch, use `git push -u origin <branch>`. If pushing an explicit SHA in zsh, brace variables in the refspec: `git push origin "${sha}:refs/heads/${branch}"`.

PRs target `main` (`gh pr create --base main`). Describe the final behavior, verification, and docs outcome. Before an authorized merge, check current PR status, required checks, and unresolved reviews. Report what actually landed or what remains blocked.
