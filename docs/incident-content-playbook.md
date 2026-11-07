# Incident content playbook

This playbook governs posts about confirmed public supply-chain compromises and their readable package diffs. **Authority:** internal. **Owner:** `scripts/incident-post.mjs`.

## At a glance

| Thing | Owner file | Who may call / trigger | Pinned by (test) |
| --- | --- | --- | --- |
| Post templates and version check | `scripts/incident-post.mjs` | Operator responding to a confirmed public incident | `test/incident-post.test.mjs` |
| Diff URL shape | `src/lib/package-diff-path.ts` | Script and public diff links | `test/incident-post.test.mjs` |
| Measurement | `server/routes/public-diff.ts` | Successful version-pair API requests | `test/workers/public-diff-routes.test.ts` |

## Contract

### Response timeline

| When | Action |
| --- | --- |
| T+0 | Confirm named package, disclosed compromise and public advisory, maintainer statement or registry action; never post on rumor |
| T+10 | Open drydock.org diff and read it; skip the incident if the change is not legible |
| T+15 | Run `pnpm incident:post` to check both versions and fill copy |
| T+20 | Screenshot one actual diff hunk showing the changed lines |
| T+30 | Post `breaking` then `whatToDo` in one thread on Bluesky and X |
| T+24–48h | LinkedIn `analysis`: change, reviewability and limits of provenance; product mentioned once at end |
| T+1 week | Check `public_diff.viewed` for the package across the post window |

The useful response window is roughly 24–48 hours. Frequency is reactive: two or three confirmed incidents a quarter is healthy; a month with no eligible incident needs no post.

### Script

```bash
pnpm incident:post \
  --package chalk --from 5.6.0 --to 5.6.1 \
  --vector "a postinstall script that posts environment variables to a remote host" \
  --consequence "Anything the build host could reach should be treated as exposed."
```

| Option / output | Contract |
| --- | --- |
| Default | npm registry check, diff URL, per-channel copy and character counts against limits |
| `--ecosystem pypi` | PyPI registry/version check and diff URL |
| `--template provenance` | Valid provenance, signed pipeline or 2FA accompanied the compromised release |
| `--template correction --claim … --correction …` | Public correction of an incorrect claim |
| Pulled version | Exit without posts; list recent surviving versions and rebuild around a resolvable pair, usually last clean → remediation |
| Registry request failure | Prints `UNVERIFIED` copy with warning; operator must check the link by hand before publishing |
| `--no-verify` | Offline drafting only; never use for real posts |
| Channel limits | `CHANNEL_LIMITS` in `scripts/incident-post.mjs`; overflows reported, never silently truncated |

### Templates

| Template | Channel | Use |
| --- | --- | --- |
| `breaking` | Bluesky, X | First post: release change and diff link |
| `whatToDo` | Bluesky, X | Second post: lockfile users' concrete action, such as pinning and rotating exposed credentials |
| `provenance` | Any | Explain what provenance attests about a pipeline and what it cannot establish about bytes |
| `analysis` | LinkedIn | T+24–48h considered analysis |
| `unpublished` | Any | Explain the pulled version and link a pair that still resolves |
| `correction` | Any | State the wrong claim and correction; leave original up |

### Measurement

| Question | Evidence / limit |
| --- | --- |
| Did readers request the diff? | `public_diff.viewed`, by day/package on post day and following day; cache hits also count |
| Did post-window activity rise? | A package-specific spike is a useful signal, not proof of attribution |
| Was it CI or a reader? | Separate `client: dependency-pr` from `other`; dependency-PR enrichment also requests diffs |
| Which platform sent traffic? | Not answerable: no page-view/referrer attribution; see [analytics](./product-analytics.md) |
| Did an unfurl alone count? | No version-pair API request means no event; a link preview alone emits none |

## Invariants

1. Only confirmed public incidents qualify; never accuse a live maintainer's release on suspicion (operator rule; `scripts/incident-post.mjs` templates do not verify incident truth).
2. Describe changed bytes without asserting intent or attribution; investigators own attribution (operator rule; `TEMPLATES` in `scripts/incident-post.mjs`).
3. Name the package, never a person or username; never blame a compromised maintainer or suggest they should have used 2FA (operator rule).
4. Verify the actual diff link resolves before publishing; the script checks registry version presence, not successful tarball retrieval or diff computation (`scripts/incident-post.mjs`, `test/incident-post.test.mjs`).
5. Never claim first discovery without a supporting scan timestamp (operator rule).
6. Never paste payloads, deobfuscations or exfiltration endpoints; link the diff without shortening the path to reuse (operator rule).
7. No AI output in incident content; public diff uses deterministic rules only (`server/lib/public-diff/index.ts`).
8. Correct publicly; never delete the original to conceal an error (`correction` template in `scripts/incident-post.mjs`).

## Failure modes

| Symptom/condition | Cause | What happens | Fix |
| --- | --- | --- | --- |
| Missing version | Registry pulled one side | Script exits without copy and lists surviving versions | Choose a resolvable pair; use `unpublished` template |
| `UNVERIFIED` output | Registry check unavailable or skipped | Copy exists without verification | Open and verify actual diff before posting |
| Illegible diff | Change cannot be demonstrated in visible lines | No useful artifact for this story | Skip incident content |
| Incorrect public claim | Human error | Trust requires visible correction | Use correction template and keep original |

## Change checklist

- If posting → lead with the changed release bytes, show one hunk screenshot, give a concrete reader action and mention “no account required” once.
- If templates/link generation change → update `scripts/incident-post.mjs` and run `pnpm exec vitest run --project node test/incident-post.test.mjs`.
- If measurement changes → check emitter semantics and [analytics](./product-analytics.md); never infer channel attribution from aggregate package activity.
