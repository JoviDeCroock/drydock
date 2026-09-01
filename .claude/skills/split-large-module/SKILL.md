---
name: split-large-module
description: Split an oversized module or component without behavior changes, preserving consumers with a barrel and mechanically verifying the move.
---

# Split A Large Module

A split is a behavior-preserving change with no test that proves it. The suite going green after a 1200-line file becomes six files tells you the paths the tests reach still work — it says nothing about the declaration you dropped or the route you renamed. So the discipline here is: pick a seam that reflects the domain, keep the public surface fixed, and **verify mechanically**.

## 1. Choose the seam by what the code does to the domain object

Not by caller, not by "these look related", not by file size.

`server/db/scans.ts` was 1233 lines with 27 callers. A caller-shaped split would have put the same function in two files, because the callers already overlapped. Splitting by *what it does to a scan* gave six modules with no overlap: `scan-jobs` / `scan-persist` / `scan-list` / `scan-detail` / `scan-decisions` / `scan-risk`.

Seams that have worked here:

- **Route file → directory, one module per resource.** The 932-line GitHub App route became `server/routes/github-app/` — `installations.ts`, `release-targets.ts`, `workflow-gates.ts`, `shared.ts` for the org-scoping helpers every resource needs, and `index.ts` mounting them.
- **Component → pull the DOM-free part out first.** `src/components/DiffView.tsx` (1642 → 1062) yielded `diff-rows.ts` (line pairing, word diff, and their give-up budgets), `diff-scroll.ts` (scroll geometry), `DiffOverview.tsx` (the rail), `DiffAnnotations.tsx` (finding annotations). The row model is the part worth extracting because it is the part worth testing without rendering.
- **Page → data, primitives, prose.** `src/pages/Docs/` split into `index.tsx` / `toc.ts` / `primitives.tsx`; `src/pages/Diff/` gave up `TrustEvidence.tsx` and its off-site link builders.

If a candidate seam forces you to export internals that are only meaningful together, it is not a seam.

## 2. Keep the public surface fixed

- **Widely imported module → keep a barrel.** `server/db/scans.ts` is now 44 lines re-exporting the six implementation modules, so none of the 27 callers changed and the diff stays reviewable. AGENTS.md names the six modules in its `db/` bullet — keep that list accurate.
- **But do not leave a re-export grab-bag just so tests keep their old import path.** Once a pure helper is extracted, point its tests at it directly (`test/diff-view.test.ts` imports `diff-rows`; the trust-evidence tests import `Diff/TrustEvidence`) instead of reaching through a component or a lazily-loaded page entry. A barrel that exists only for tests is dead weight, and `knip` will say so.
- A route directory's `index.ts` must mount exactly the paths the old file did — no re-ordering that changes which handler wins.

## 3. Verify mechanically — a green suite is necessary, not sufficient

For any split you would not want to be wrong about, run one of these before committing:

**Declaration census** — nothing was lost, and nothing was copied instead of moved. Two directions matter and they are not the same check:

```sh
DECL='^(export )?(declare )?(async )?(function|const|class|type|interface|enum) [A-Za-z0-9_]+'
git show <pre-split-ref>:server/db/scans.ts \
  | grep -oE "$DECL" | awk '{print $NF}' | sort -u > /tmp/before.txt
cat server/db/scan-jobs.ts server/db/scan-persist.ts server/db/scan-list.ts \
    server/db/scan-detail.ts server/db/scan-decisions.ts server/db/scan-risk.ts \
    server/db/d1-chunk.ts \
  | grep -oE "$DECL" | awk '{print $NF}' | sort > /tmp/after.txt

comm -23 /tmp/before.txt <(sort -u /tmp/after.txt)   # dropped on the floor — must be empty
uniq -d /tmp/after.txt                               # same name in two modules — must be empty
```

Check *containment*, not equality: extra names in `after` are normal, because a split usually absorbs a neighbor or two. Missing names are the defect. List every destination file explicitly rather than globbing — a `scan-*.ts` glob silently misses the `d1-chunk.ts` the split also produced, and a census with a hole in it is worse than none.

**Surface diff** — for routes, print the route table before and after and diff it to zero. All 12 GitHub App paths were checked this way. Hono exposes the mounted routes; a `console.log` of the router's route list in a throwaway script is enough.

**Then the wider gates**, because a split fails in ways unit tests do not see:

```sh
pnpm run verify      # lint + format + typecheck + node and workers suites
pnpm run knip        # exports orphaned by the split
pnpm run build       # bundling and prerender, which lazy page splits can break
```

## 4. Know which files to leave whole

Line count is not the criterion. `server/lib/platform/js-lexer.ts` is 2768 lines — the largest file in the repo — and stays that way on purpose: it is one mutually-recursive tokenizer state machine, so separating `updateBracketState` from the scanners that call it would spread a single control flow across files, making it harder to follow rather than easier. It is also security-relevant code, where "harder to follow" has a cost.

Leave a module whole when any of these hold, and say so explicitly rather than silently skipping it:

- It is one state machine or algorithm whose parts only make sense together.
- Splitting would require exporting internals that have no meaning as a public surface.
- It is security-relevant and the split trades reviewability for tidiness.

Conversely, do not split a file you have not confirmed has a seam. Size alone ("900 lines, 48 declarations") is a reason to *look*, not a reason to promise.

## 5. Land it reviewably

- **One commit per split**, each independently passing the full gate. Subject in repo style: short, sentence-case, imperative — `refactor: split db/scans.ts by what it does to a scan`.
- If the split created or revealed a shared helper, that is the `shared-primitives` skill's territory: hoist it, name it for its context, and give it direct tests. Centralizing raises blast radius, so the tests are part of the same change.
- **Update the layout docs.** AGENTS.md's `server/` and `src/` bullets name modules by path; `docs/ui.md` and `docs/architecture.md` do too. A split that moves a named module and leaves the doc pointing at the old path is a real defect. Either update them or state `docs checked, no update needed`.
- Finish with the `pre-pr` skill.

## Checklist

- [ ] Seam reflects what the code does to the domain object, not who calls it.
- [ ] Widely imported entry kept as a barrel; no grab-bag barrel kept only for tests.
- [ ] Declaration census or surface diff run — not just a green suite.
- [ ] `pnpm run verify`, `pnpm run knip`, `pnpm run build` all clean.
- [ ] Files deliberately left whole are named, with the reason.
- [ ] AGENTS.md layout bullets and any docs naming the moved paths updated.

Related: `shared-primitives`, `pre-pr`.
