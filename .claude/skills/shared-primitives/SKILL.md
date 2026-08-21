---
name: shared-primitives
description: Where a small helper belongs and what it must be called. Use before writing any guard, escaper, hash, path check, fan-out helper, tone mapper, or page-level component; when a helper "feels generic"; when a function's safe use depends on the context it lands in; or right after hoisting something into a shared module.
---

# Shared Primitives: Define It Once, Name It For Its Context

Every duplicate in this repo started as one reasonable local helper. A single audit found four of them that had drifted into three to seven near-identical copies, and two were already doing damage:

| helper | copies | what the duplication cost |
|---|---|---|
| `isSafeManifestPath` | 3, byte-identical | one per ecosystem manifest parser — a **path-traversal hardening fix had to be written three times** to take effect, and missing one left that ecosystem exposed with nothing to tell you |
| `mapWithConcurrency` | 3, divergent | two copies had no fail-fast and silently returned an array of `undefined` when passed `concurrency: 0` |
| `sha256Hex` | 3 signatures | these digests are compared against each other across layers, so an encoding disagreement is a silent mismatch |
| `escapeHtml` | 3 escape sets | see "Name it for its context" below |
| `isRecord` | 7, one spelled differently | the definition of "a plain object" drifting between ecosystem parsers |

None of these were written carelessly. Each was written by someone who needed five lines and had no reason to look first. That is the failure mode this skill exists to interrupt.

## Before you write a small helper

1. **Grep for the behavior, not the name.** Copies drift in name before they drift in behavior, so `isRecord` will not find `isPlainObject`. Search for what it does: `crypto.subtle.digest`, `replace(/&/g`, `"\.\."`, a chunked `Promise.all` loop, `startsWith("/")`.
2. **Read `server/lib/platform/` first.** It is the domain-free layer everything above narrows, fans out, escapes, hashes and retries with. Today it holds `guards.ts` (`isRecord`), `path-safety.ts` (`isSafeManifestPath`), `concurrency.ts` (`mapWithConcurrency`), `crypto-utils.ts` (`sha256Hex`, `hmacSha256`, `timingSafeEqual`, base64url, hex), `html-escape.ts`, plus `http.ts`, `errors.ts`, `fetch-retry.ts`, `rate-limit.ts`, `stable-json.ts`, `text.ts`, `secret-box.ts`, `observability.ts`, `security-headers.ts`, `js-lexer.ts`.
3. **If the shared one is subtly wrong for your case, fix the shared one.** Forking it is how the three `mapWithConcurrency` variants happened. Widening the shared definition means every other caller gets the fix; forking means every other caller keeps the bug.
4. **Two call sites in two modules is the threshold.** Not three, not "when it gets annoying". The second call site is the last cheap moment to hoist — after that, the copies start to drift and the merge becomes an archaeology exercise.

## Where shared code goes

| shape | home |
|---|---|
| domain-free infrastructure — guard, hash, escape, path check, concurrency, retry, rate limit, canonical JSON | `server/lib/platform/` |
| ecosystem-specific resolution/fetching/validation/findings | `server/lib/ecosystems/<id>/` — never an `ecosystem === "x"` branch in shared code (machine-checked by `test/ecosystem-branching-invariants.test.mjs`) |
| behavior one ecosystem needs from shared gate plumbing | an **optional method on `WorkflowGateAdapter`**, implemented in `server/lib/ecosystems/<id>/workflow-gate.ts` — `narrowParsedArtifact?` and `shardedArtifactNames?` are the precedents |
| deterministic rule logic | `server/lib/review/rules/` — see the `add-detection-rule` skill |
| UI used by two or more pages | `src/features/` (machine-checked by the `boundaries-local/no-cross-page-import` lint rule) |
| UI primitive or typography | `src/components/` — e.g. `Prose` and `InlineCode` live in `src/components/Typography.tsx`, not in the page that first needed them |
| persistence for one kind of write | the matching `server/db/scan-*.ts` module behind the `scans.ts` barrel |

One deliberate exception exists: `server/lib/tar-parser.js` keeps its own `sha256Hex` because it is inlined verbatim into the rendered sandbox worker and must stay import-free. If you add a genuine exception, put the reason in a comment at the copy so the next audit does not "fix" it.

## Name it for the context it is valid in, not for what it does

`escapeHtml` was three functions with three different outputs and one name:

| file | escaped | apostrophe |
|---|---|---|
| `notify/account-email.ts` | `& < >` | separate attribute variant |
| `routes/public-diff.ts` | `& < > " '` | `&#39;` |
| `public-diff/card.ts` | `& < > " '` | `&apos;` — correct for SVG, wrong for HTML4 |

**No call site was wrong at the time.** That is the point: a name that does not state its context can only be checked by opening the implementation, which nobody does at a call site, so the bug arrives on the next edit rather than in the diff that created it. The fix was to put the context in the name — `escapeHtmlText`, `escapeHtmlAttribute`, `escapeXml` in `server/lib/platform/html-escape.ts` — so choosing wrong is now visible where the choice is made.

The same shape without the security stake: `severityTone` in `src/components/Badge.tsx` maps *finding* severity, while the audit log maps a *different* severity vocabulary onto different tones. Both return `BadgeTone`, so a mix-up typechecks cleanly. It is now `auditSeverityTone` in `src/pages/Dashboard/Settings/AuditLogSection.tsx`.

Two tests to apply when naming:

- If two functions in this repo could both plausibly be called `X`, then neither may be called `X`.
- If a function's *safe* use depends on where its output lands — markup context, encoding, severity vocabulary, trust level, credentialed vs anonymous — the name has to say which. `escapeHtmlAttribute` over `escapeHtml2`; `auditSeverityTone` over `severityTone`.

## Hoisting raises blast radius, so pin it with tests

Centralizing is a trade. One definition means one place to fix and one place to break everything at once. `isSafeManifestPath` is the sharp end: before it was hoisted, a weakening edit hurt one ecosystem; now the same edit weakens npm, PyPI and VS Code simultaneously.

**A hoist is not finished until the primitive has direct tests that do not go through any caller.** `test/platform-primitives.test.ts` is the pattern — table-driven, one describe per primitive, covering the inputs the callers happen not to send:

- `isSafeManifestPath`: `../`, `/abs`, `C:\`, embedded NUL, backslash, bare `.` and `..` segments, the 512-char cap, and the ordinary paths that must still pass.
- `mapWithConcurrency`: empty input, `concurrency: 0` and negative (clamped to 1), result order under out-of-order completion, fail-fast with in-flight workers awaited.
- The escapers: one case per markup context, including the one that distinguishes them (`'` in an attribute vs `&apos;` in SVG).

"The callers' suites cover it" is not sufficient. They cover the paths callers happen to take; after a hoist, the inputs that matter are precisely the ones no current caller sends.

## Checklist

- [ ] Grepped for the behavior before writing it; checked `server/lib/platform/`.
- [ ] Second call site in a second module → hoisted, not copied.
- [ ] Placed per the table above; no ecosystem name branch in shared code; no cross-page import.
- [ ] Name states the context, not just the action; no two functions share a name for different behavior.
- [ ] Newly shared code has direct tests of its own, including inputs no current caller sends.
- [ ] Left-behind copies deleted — grep again after the hoist to confirm zero remain.
- [ ] `pnpm run verify`, then the `pre-pr` skill.

Related: `split-large-module` (the structural half of the same cleanup), `add-ecosystem`, `add-detection-rule`, `pre-pr`.
