---
name: pre-pr
description: Finish a Drydock branch before any push or PR, including requests to open a PR, finish a branch, or prepare it for review.
---

# Pre-PR Finishing Ritual

Four gates, in order: verify, adversarial self-review, docs, safe push. Skipping any of them is how regressions and shared-branch clobbers happen.

## 1. Run the full verify gate

```sh
pnpm run verify
```

Runs lint + format check + typecheck + knip + the logic and Worker test suites in parallel (`scripts/verify.mjs`); all five always run to completion so one pass surfaces every failure. Fix everything it reports. If e2e scenarios or registry behavior changed, also run `pnpm run test:e2e`.

## 2. Adversarial self-review

Re-read the entire branch diff actively trying to refute it — as a hostile reviewer, not the author:

```sh
git fetch origin main
git diff origin/main...HEAD
```

Hunt specifically for:

- Bugs: off-by-one, fail-open error paths, unhandled null/undefined, stale comments describing removed behavior.
- AGENTS.md non-negotiables: package bytes executed or imported anywhere, npm auth touching anything but `NpmStageGateway`, a non-auth `/api/*` endpoint missing org scoping, raw tokens or package contents in logs.
- Missed tests: every new behavior needs coverage at the narrowest useful layer; anything crossing a trust boundary needs broader coverage (see AGENTS.md "Testing").
- Docs drift: code now contradicting a doc, or a doc that should have been updated.

Fix findings in a final commit whose subject is prefixed `review:`, matching repo history (`git log --oneline` shows examples like `review: pin the capped-baseline note on rendered diff evidence` and `review: correct the retention module path, scope the status-projection note`). Commit subjects are short, sentence-case, imperative.

## 3. Docs expectation

Use `docs/README.md` to select the relevant layer. Either update the docs the change touches, or state `docs checked, no update needed` in the PR summary/testing notes. One of the two must happen — silence is not an option.

## 4. Fetch, check divergence, then push

Parallel Conductor agents share branches, so the remote may have moved since you branched. Always re-fetch immediately before pushing:

```sh
git fetch origin
git log --oneline HEAD..origin/<branch> 2>/dev/null   # anything here = remote is ahead
```

- If the remote diverged, rebase or merge the remote work first — never blind-push over it, and never force-push without having just re-fetched and inspected what would be overwritten.
- zsh mangles bare refspecs: `$sha:refs/heads/x` trips the zsh `:r` modifier. Always brace both sides: `git push origin "${sha}:refs/heads/${branch}"`.
- First push of a new branch: `git push -u origin <branch>`.

Then open the PR with `gh pr create --base main`, including a summary, testing notes, and the docs statement from step 3.
