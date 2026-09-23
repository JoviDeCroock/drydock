# Product marketing context

Read this before writing or editing any user-facing marketing copy (landing, docs
hero, discovery guides, incident pages, `/diff`, SEO metadata, share cards). It
answers the product, audience, and positioning questions a copy task starts with,
so they are decided once here rather than re-derived per page.

`docs/design.md` stays the visual source of truth and `docs/ui.md` holds copy
density rules. This file governs *what we claim*, not how it looks.

## The product

Drydock reviews the **built package artifact** in the window between CI and the
public registry — the last checkpoint before a version becomes immutable and
installable. It diffs the release candidate against the last published version and
pins every deterministic supply-chain finding to the changed line.

Two hold contracts, and the difference between them is load-bearing:

- **Workflow Gate — enforced.** A GitHub Environment protection rule pauses the
  configured protected publish job after CI uploads the built artifacts. Approve
  and the job continues with its own credential; reject and it never publishes.
  Covers npm, PyPI, and VS Code. This is the default path we lead with.
- **Stage Watchtower — advisory.** npm parks a private staged tarball; Drydock
  reviews it and records a decision. The maintainer approves or rejects in npm
  with npm's own 2FA. Drydock cannot stop a separate interactive publish, and we
  never imply otherwise.

`/diff` is the front door: any two published npm, PyPI, or atpm versions, file by
file, no account and no installation.

## Audience

**Primary — the OSS maintainer who publishes.** Has a repo, CI, and publish
rights. Already does code review. Has never read their own tarball. Arrives warm
from an incident thread, a dependency PR diff link, or a shared report.

**Secondary — the enterprise publisher.** Owns a release process and needs an
enforced, auditable human checkpoint with credentials that stay in their CI.

**Tertiary — the package consumer** deciding whether to take an upgrade.

Perception gap to respect: maintainers hear "security tool" as *friction, alerts,
someone else holding my release*. Enterprise hears the same words as *control*.
Lead maintainer-facing copy with reading and evidence, never with enforcement,
alerting, or compliance.

## The problem, in the reader's words

A pull request review checks the source tree. The registry serves something else —
build output, lifecycle hooks, bundled and vendored files, generated code, and
files that never lived in git, published with a credential that may not belong to
the person you think. Once a version is live it is immutable and installed within
minutes.

Cost of not solving it: every named supply-chain incident below shipped through a
publish nobody read.

## Differentiation

- **The artifact, not the branch.** Source scanners and PR review read the repo.
  We read the bytes the registry serves.
- **A diff, not a score.** The headline is the changed line, with findings pinned
  to it. No opaque risk number a reader cannot check.
- **We never hold the publish credential.** Read-only npm access; registry
  credentials stay in GitHub Actions. Review access cannot become publish access.
- **Package code is never executed.** Archives are parsed in a non-executing
  sandbox — no lifecycle scripts, no imports, no builds.
- **Open and inspectable.** Apache-2.0. Detection rules, severities, fixtures, and
  sandbox boundaries are public and self-hostable on Cloudflare.
- **The human keeps the decision.** Drydock never publishes.

## Proof points we may use

Only these, and only as written. Everything here is verifiable.

- Named incidents that shipped in the artifact and not in the repo: event-stream
  (2018), ua-parser-js (2021), node-ipc (2022), chalk & debug (2025, ~18 packages,
  ~2B combined weekly downloads).
- Live public diffs of real releases on `/diff`, plus the `/incidents/*` pages,
  which claim only what the compared artifacts prove.
- Apache-2.0 source, public detection rules, self-hosting docs.
- Sponsored by Aikido Security (the purple co-brand is deliberate sponsor
  branding).

## Hard copy rules

These are not style preferences. Breaking one is a product-accuracy bug.

1. **Never blur advisory and enforced.** Stage Watchtower does not block a publish.
   Workflow Gate blocks only the *configured protected job*. Say which, every time.
2. **Never claim we prevent an attack, detect malware, or make a release safe.**
   We surface evidence; a human decides.
3. **No invented metrics, customers, testimonials, or logos.** No "trusted by N
   teams" until there is a number we can show.
4. **No pricing or free-tier claims** on these surfaces — no paid plan exists
   today. The single exception is `/maintainer-pledge`, which states the
   commitment not to charge open-source maintainers for reviewing their own
   public releases. It may only be made there, and only alongside what the
   pledge does not promise.
5. **Never embellish an incident.** Incident copy states only what the inspected
   artifacts prove (`docs/design.md`).
6. **No exclamation points, no buzzwords** ("streamline", "seamless",
   "enterprise-grade", "AI-powered", "next-generation", "revolutionize").
7. **AI review is advisory** and cannot downgrade a deterministic finding. Do not
   market it as the thing that catches attacks.

## Voice

Plain, specific, technical, unhurried — a security advisory written by someone who
respects the reader's time, not a SaaS landing page. Short declaratives. Concrete
nouns (`postinstall`, tarball, wheel, VSIX) over abstractions. Confident without
qualifiers; honest about limits, because the honesty *is* the pitch.

Campaign spine: **"Read the diff."** The ask is usually to read something, not to
sign up. Point at `/diff` before `/register`.

## CTA ladder

| Temperature | Ask | Where |
|---|---|---|
| Cold | `Read a diff` | landing hero, incident pages, guides |
| Warm | `Diff a package` / `Open the live artifact diff` | `/diff`, public reports |
| Ready | `Set up npm staging`, `Add a workflow gate`, `Protect a PyPI workflow` | docs, guide closes |
| Account | `Create account` | secondary, never the lone hero CTA |

Never ship `Get Started`, `Learn More`, `Sign Up`, or `Submit` as button text.
