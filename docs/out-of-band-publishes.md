# Out-of-band publish alarm

Drydock cannot stop a publish it never sees: npm's staged approval is owned by
the npm account, the workflow gate only guards the configured publish job, and
npm still allows an interactive `npm publish` from a laptop. The out-of-band
watch turns that residual gap into a detection: **any public version of a
previously reviewed package that appears with no Drydock review trips an alarm
within one discovery sweep** (the 15-minute cron, or the on-demand "Check npm"
button). That fingerprint — no review, usually no provenance — is how the
chalk/debug, axios, and worm-republish incidents reached the registry.

## How it works

Each staged-publish discovery sweep also runs `sweepOutOfBandPublishes`
(`server/lib/ecosystems/npm/out-of-band-watch.ts`), using the organization's
existing npm connection against metadata endpoints only:

1. **Targets** are the organization's 50 most recently reviewed package names,
   taken only from scans' immutable registry coordinates
   (`registryPackageName`): `packageName` is rewritten from the inspected
   tarball manifest, and hostile bytes must never aim a credentialed registry
   lookup, so workflow-gate scans' manifest-claimed names never become watch
   targets. Gate scans still suppress candidates. There is no separate
   enrollment step.
2. **Baseline**: a package's first sighting stores its current public version
   set in `package_watches`. History never alarms retroactively.
3. **Candidates** are versions in the abbreviated public packument that are
   outside the accounted set. A candidate with any scan for that release is
   accounted silently. Otherwise npm's version-status endpoint refines the
   evidence: `published` alarms as confirmed; `blocked`/`deleted` are accounted
   without an alarm; `staged`/`validating` defer to the next sweep; a failed
   lookup still alarms (packument presence is the evidence) but is marked
   unconfirmed, except malformed coordinates, which can never alarm.
4. **Alarm**: one row in `out_of_band_publishes` per release (the unique index
   is the send-once gate), a `package_watch.out_of_band_publish` audit event
   (security severity), a `package_watch.out_of_band` analytics counter, and a
   best-effort email + Slack notification. Alarm rows are never pruned — they
   are the permanent dedupe record.

Per sweep, at most 20 packuments are fetched (stalest-checked first) and at
most 5 candidates per package spend a status lookup, so a mass-publish cannot
exhaust the budget. Per-package failures are contained and logged as
`package_watch.package_failed`.

## Posture

Advisory by design: the alarm changes no scan, risk, finding, or gate state.
It is the detection half of the honesty stated in
[`npm-staged-publishing.md`](./npm-staged-publishing.md#what-this-does-not-stop)
and [`npm-trusted-publishing.md`](./npm-trusted-publishing.md#what-this-does-not-stop):
registry-side bypasses are not preventable from outside the registry, so any
publish that routes around review must itself become the signal. The related
`registry-version-status.md` reminder covers the softer case (a reviewed scan
that npm published without a decision); this alarm covers the strictly harder
one — no scan at all.

The `out-of-band-watch` Flagship flag (keyed by organization) is an operator
killswitch. Unlike `ai-review`, it defaults **on** when the FLAGS binding is
absent: the sweep is deterministic registry metadata with no paid dependency,
so self-hosters get it without Flagship.

## Surfaces

- Dashboard: a critical banner lists unacknowledged alarms; any member can
  acknowledge (audited as `package_watch.out_of_band_acknowledged`).
- API: `GET /api/v1/package-watch/out-of-band`,
  `POST /api/v1/package-watch/out-of-band/:id/acknowledge`.
- Audit log: both event types are in the visible allowlist.
