---
name: split-large-module
description: Split a Drydock module along responsibility boundaries while preserving behavior, public exports, route ordering, and consumers.
---

# Split a large module

Choose a seam that makes a responsibility easier to understand. Size is a reason to inspect, not a reason to split. Keep a state machine or mutually recursive algorithm together when extraction would expose meaningless internals or make security review harder; `server/lib/platform/js-lexer.ts` is a deliberate example.

Useful precedents are the responsibility modules behind `server/db/scans.ts`, resource routes under `server/routes/github-app/`, and DOM-free row/scroll logic extracted from `src/components/DiffView.tsx`. Use the current repository map for ownership rather than copying an old file layout.

## Preserve contracts

- Keep widely imported public entries as barrels, especially those named in AGENTS.md. Point direct helper tests at their owner; do not keep a barrel solely for obsolete test imports.
- Preserve route paths, methods, middleware order, and handler precedence.
- Separate behavior changes from moves so a reviewer can assess both. Use commit boundaries when commits are requested; the skill does not require committing or publishing.

## Verify the move

A green suite only covers exercised paths. Inspect the moved-code diff and account for declarations and exports across **every** destination, including helpers moved outside the main directory. A declaration census can find dropped or duplicated names; it does not prove initialization order or side effects stayed the same. For route splits, compare the mounted method/path/order surface before and after as well.

Run relevant regression tests and `pnpm run verify` (already includes knip). Run `pnpm run build` when module moves affect bundling, lazy imports, or prerendering. Investigate lost exports, cycles, and side-effect ordering instead of adding compatibility exports solely to silence checks.

Update path references in `docs/repository-map.md` and the affected architecture/UI docs. Report the preserved surface and the evidence used to check it. If extraction reveals a reusable helper, use [shared-primitives](../shared-primitives/SKILL.md) for its contract and ownership.
