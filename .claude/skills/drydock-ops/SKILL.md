---
name: drydock-ops
description: Use when asked to run the ops loop, check what's happening for customers, produce an ops report, review prod usage or detection quality signals, or before prioritizing detection/product work. Queries prod D1 read-only via wrangler and turns anomalies into trackable issues.
---

# Drydock ops loop

You are the customer-feedback loop for Drydock. Read prod usage data, compare against history, and turn anomalies into trackable work. The deliverable is a dated report plus issues — not raw query dumps.

## Hard rules

- Prod D1 is **read-only**: only `SELECT` / `PRAGMA` via
  `npx wrangler d1 execute staged-publish-review --remote --json --command "..."`.
  Never UPDATE/DELETE/INSERT unless the user explicitly asks for a specific cleanup. Never touch wrangler secrets or deploy.
- Timestamps in D1 are **epoch milliseconds** (`created_at >= (strftime('%s','now') - 7*86400) * 1000`).
- Exclude `staged_publishes.scans_started` from event-volume analysis if it dominates — rows from before #332 are */15min cron-sweep noise (one per connected org per run, even no-op).
- Customer data stays in `~/.drydock-ops/` and this private repo's issues; never paste it anywhere else.

## State (outside the repo, survives sessions)

- `~/.drydock-ops/history.jsonl` — one JSON line per run; the trend baseline. Keep the existing metric keys.
- `~/.drydock-ops/reports/<YYYY-MM-DD>.md` — dated reports. If today's exists, refine it rather than duplicating.
- `~/.drydock-ops/backup/` — row backups taken before any explicitly requested prod cleanup.

## Each run

1. Read `history.jsonl` and the most recent report.
2. Compute the current 7-day window with the same metric keys as history.jsonl: scans started/completed/failed, decisions (publish / no_publish, high-risk published), active orgs 7d/30d, totals (orgs, users, lifetime scans), scan views, gate requests (external = repos not under `JoviDeCroock/`), notifications sent/failed.
3. Compare against history. For anything that moved meaningfully — new or churned orgs, failure spikes, new error codes, notification failures, high-risk overrides, rule fire-rate shifts — run follow-up queries until you know *which org/package/rule* and why it matters. Real names, real numbers.
4. Write the dated report: headline-numbers table first, then only findings that would change what a maintainer does next. Append one history.jsonl line (`notes` field for context).
5. For each actionable anomaly, check `gh issue list --label ops-loop --state all` and skim open issues for an existing match before filing `gh issue create --label ops-loop`, body signed "🤖 Filed by the ops feedback loop." Product regressions and onboarding failures qualify; ordinary fluctuation does not.
6. If you learned something durable (not a one-week blip), update persistent memory — `project_prod_customer_signal.md` is the standing customer-reality memory.
7. Check whether recently merged remediation actually moved the numbers it was supposed to move, and say so in the report.

## Useful query shapes

- Events by type: `SELECT type, COUNT(*) FROM scan_events WHERE created_at >= ... GROUP BY type ORDER BY COUNT(*) DESC`
- Per-org activity: `SELECT organization_id, COUNT(*), GROUP_CONCAT(DISTINCT package_name) FROM scans WHERE created_at >= ... GROUP BY organization_id`
- Risk × decision matrix: `SELECT risk, status, decision, COUNT(*) FROM scans WHERE created_at >= ... GROUP BY risk, status, decision`
- FP signal: scans with `risk='high' AND decision='publish'` joined to `scan_findings` for their `rule_id`s — every override is a customer saying a detection was probably wrong.

## Headless use

`run.sh` next to this skill runs the loop unattended via `claude -p` (cron/launchd-friendly; it raises the file-descriptor limit launchd jobs need and logs to `~/.drydock-ops/logs/`). It needs `claude`, a logged-in `wrangler`, and an authed `gh` on the machine.

## Known context (update as reality changes)

- ljharb (Jordan Harband) is the most active external user — his packages (tape, es-iterator-helpers, …) are benign hard-negative material; alert fatigue for him is a top product risk.
- High-risk "publish anyway" decisions are the false-positive signal; track them every run.
- Current remediation set: #330 (process-execution FPs), #331 (finding flood), PRs #324 (test-path demotion + rule grouping), #328 (auto release detection), #332 (sweep-noise + token-failure UX).
