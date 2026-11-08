# npm package claims and migration audit

A package claim binds one organization to an npm package by immutable registry URL, `npm` ecosystem, and registry package name; it gates staged admission, monitoring enrollment, and the public badge. **Authority:** enforced (staged admission and discovery refuse packages claimed elsewhere). **Owner:** `server/db/package-claims.ts`.

## At a glance

| Thing | Owner file | Who may trigger | Pinned by |
| --- | --- | --- | --- |
| Claim, reservation, transfer | `server/db/package-claims.ts` | first verified staged scan; owner/admin transfer | `test/package-claim-model.test.ts`, `test/workers/npm-package-claims.test.ts` |
| Identity normalization | `stagedClaimIdentity` on the staged adapter (`server/lib/ecosystems/npm/index.ts`) | staged admission | `test/workers/npm-package-claims.test.ts` |
| Admission errors | `server/routes/scans/lifecycle.ts` | manual scan | `test/workers/npm-package-claims.test.ts` |
| Management choice API | `server/routes/npm-package-claims.ts` | session; personal owner + destination owner/admin | `test/workers/npm-package-claim-management.test.ts` |
| Personal automatic-scan consent | `server/routes/npm-connection.ts` | personal workspace owner | — |
| Migration audit tool | `scripts/package-claims-audit.mjs` | operator, offline | `test/package-claims-audit.test.ts` |

Schema: `drizzle/0035_overrated_human_fly.sql` creates an empty `npm_package_claims`; `drizzle/0036_colorful_morlun.sql` adds `management_confirmed_at` and `personal_organization_confirmed_at`.

## Contract

### What establishes a claim

| Event | Establishes a claim? |
| --- | --- |
| First verified staged scan of an unclaimed package | Yes (personal workspace: **provisional**) |
| Organization's own next verified staged scan, when only its own pre-claim history exists | Yes |
| Public package review, public watch, workflow-gate checkpoint | No |
| Registry access failure | No |
| Operator backfill (`approved-claims.sql`) | Yes, for explicitly approved packages |

| Admission outcome | Status |
| --- | --- |
| npm-reported name Drydock cannot review | 422, permanent |
| Identity or stage access cannot be verified | 503, retryable |
| Package claimed elsewhere, reserved, or held by unrelated pre-claim history (discovery) | skipped before any credentialed stage request; counted as `claimBlocked`; redacted `staged_publishes.claim_blocked` event |
| Manual scan blocked while the caller has its own contested pre-claim history | message says support must confirm ownership |

### Pre-claim history

| History holder | Blocks automatic claim by |
| --- | --- |
| Organization A | every other organization, until an operator resolves it; never A itself |
| A member's personal workspace | not a shared organization that holds its own history of the package |
| A shared organization | a member's personal workspace (a team without its own history has no say over a member's personal package) |
| A scan with no recorded registry URL | treated as public npm history: blocks public npm only, never other registries |

The organization holding the history claims with its next verified scan, because npm verifies that scan exactly like a new package's first scan; packages whose only history predates stored registry identity need no backfill evidence to be reviewed again by it.

### Personal workspaces

| State | Manual review | Monitoring and badge | UI offers |
| --- | --- | --- | --- |
| Provisional personal claim | yes | wait for a choice | **Choose where this package is managed** card: Keep + Move (Keep only if no shared destination) |
| Confirmed personal claim (`management_confirmed_at` set) | yes | yes | **Move to organization** only when a shared destination exists |
| Shared-organization claim | yes | yes, immediately | nothing (durable; cannot be moved again from the product) |

- Personal classification comes from the organization's actual owner and id, never a client flag.
- The card appears on the scan page and at the top of the npm package page. **Watch package** in the personal workspace opens it only when the server answers `package_management_required`. The picker prefers a shared organization the caller manages.

### Endpoints

| Method | Path | Auth | Effect |
| --- | --- | --- | --- |
| GET | `/api/v1/npm-package-claims/:name` | session | Active organization's claim and eligible destinations; never identifies another owner |
| POST | `/api/v1/npm-package-claims/:name` `{ targetOrganizationId, registryUrl? }` | session owns the personal workspace + current owner/admin of destination; verified email | Confirm in place, or move to a shared organization |
| POST | `/api/v1/npm-connection/personal-confirmation` | personal workspace owner | Record automatic-scan consent; never contacts npm |

- Registry selector: `registryUrl` (query for GET, body for POST); default public npm.
- POST errors: 400 invalid input, 403 not authorized, 409 stale claim, 409 destination watch budget full (ownership not moved).
- Refused transfers: team to team, team to personal, ownerless reservation.

### Transfer effects

1. Claim update, audit events (`npm_package.management_confirmed` / `npm_package.management_transferred`, recording registry, source, destination), and public-npm destination watch enrollment commit in one D1 batch; the mutation re-checks authorization; competing transfers cannot both win.
2. Confirming or transferring is an explicit enrollment action and clears the destination's watch opt-out.
3. Keep never waits on a watch slot: the claim is confirmed and the badge restored; a full budget only defers the watch, which enrolls once a slot frees.
4. Confirming an already-confirmed claim is a no-op that keeps the original timestamp and audit event.
5. Personal scans, reports, observations, and credentials stay in the personal workspace. Its old watch becomes inactive through the ownership check and stops counting toward its limit.
6. The destination watch starts at the source watch's last check (or its creation if it never checked), so releases published while the source paused are examined there; releases reviewed only in the personal workspace alert there as unreviewed. The last check is a lease taken at check start, so a failed or limit-stopped last check can leave earlier releases unexamined.
7. The destination badge needs its own qualifying review; personal approvals never become team approvals.

### Personal automatic scanning

- Connecting or validating npm in a personal workspace records `personal_organization_confirmed_at` only with explicit `confirmPersonalOrganization: true`. Without it, cron reconciles existing releases but creates no new personal scans. Shared connections need no acknowledgment.
- Every path keeps the first timestamp and writes one `npm_connection.personal_confirmed` audit event; token rotation or revalidation repeats neither.
- The choice never copies an npm token to another organization. Existing personal connections must make it; manual review stays available.
- A pending choice never hides token rotation or disconnect. The dashboard shows a callout; the Settings npm card reads "automatic scans off", not valid.

## Operator runbook: historical ownership backfill

Inventories contain organization and package identifiers. Keep exports, reports, approvals, and SQL outside every repository and PR, in an access-controlled private directory; never paste them into issues or comments. The script never invokes Wrangler, connects to D1, or applies SQL.

1. Drain existing scan jobs, then apply migrations `0035` and `0036` (preparing an apply needs the claims schema; the export itself does not).
2. Create a real private directory (not a symlink: on macOS use `/private/tmp`, not `/tmp`; avoid temp dirs for the durable record):

   ```sh
   umask 077
   mkdir -p /private/operator-audit
   ```

3. Generate the fixed read-only export query and run it (a separate operator action, authorized for reads only):

   ```sh
   node scripts/package-claims-audit.mjs --query > /private/operator-audit/export.sql
   pnpm exec wrangler d1 execute staged-publish-review --remote --json --file /private/operator-audit/export.sql > /private/operator-audit/staged-inventory.json
   ```

4. Build the audit (the output directory must not exist):

   ```sh
   node scripts/package-claims-audit.mjs --input /private/operator-audit/staged-inventory.json --output /private/operator-audit/review-1
   ```

   Only if every historical row is independently confirmed to be public npm, add `--assume-public-npm-registry` here and to step 7.

5. Review `audit.md` and `inventory.json`; decide owners by evidence, not earliest timestamp. Record the decision and evidence privately.
6. Write the approvals file at /private/operator-audit/approvals.json (nothing is preselected; no approve-all switch):

   ```json
   {
     "inventory_sha256": "copy the exact hash from inventory.json",
     "approvals": [
       {
         "registry_url": "https://registry.npmjs.org",
         "package_name": "example-package",
         "organization_id": "reviewed-organization-id",
         "evidence_scan_id": "reviewed-scan-id"
       }
     ]
   }
   ```

7. Generate the SQL:

   ```sh
   node scripts/package-claims-audit.mjs --input /private/operator-audit/staged-inventory.json --approvals /private/operator-audit/approvals.json --output /private/operator-audit/approved-1
   ```

8. Inspect `approved-claims.sql` in the `approved-1` directory. Apply only that artifact, under separate write authorization, near the maintenance window from a fresh export.
9. Verify the selected keys and organizations in `npm_package_claims`; retain the verification privately.
10. Deploy the claim-enforcing Worker only after steps 1–9.

If application aborts, re-export and re-audit (step 3); never remove guards, use `INSERT OR REPLACE`, or delete another claim.

### Audit tool contract

- **Export columns:** identity and lifecycle fields from `scans`, organization names, derived personal classification (id equals `personal:` + owner user id; owner id not exported); no credentials, report contents, errors, or user details.
- **Sources:** npm staged `manual` and `auto_discovery` only; public-diff and workflow-gate records cannot prove stage ownership.
- **Output safety:** refuses paths inside the checkout, symlink ancestors, existing directories, overwrites; modes 0700 / 0600.
- **`audit.md`:** registry/package groups, organizations, duplicate-owner candidates, evidence issues; every group unapproved.
- **`inventory.json`:** inventory SHA-256; per scan: id, stage id, immutable coordinates, observed manifest coordinates, organization, source/status; per-organization counts and first/last timestamps (Unix ms). Missing registry coordinates stay explicitly unknown; a display fallback to a manifest package name is an inventory label, never a claim assignment.
- **Organization labels:** `personal_provisional`, `shared_durable`, `unresolved`: the claim an approval would create, bound to the inventory hash, revalidated at apply. Older exports lacking `organization_is_personal` must be refreshed, never filled from the id prefix.
- **Registry URLs:** canonical URLs and trailing-slash variants share a group; approvals use the canonical URL without a trailing slash; other noncanonical or unsupported URLs are flagged and cannot be approved.
- **`--assume-public-npm-registry`:** assigns only missing registry URLs to `https://registry.npmjs.org`; refuses contradictory recorded registries; keeps the raw null and an assumption marker; never supplies a missing package name or version; stated in report and SQL; included in the inventory hash so approvals do not cross modes; missing-URL issues stay visible; SQL still revalidates the original null registry field; private workflow only, not runtime custom-registry support.
- **Approval requires:** complete immutable registry URL (or the assumption), package name, version; an existing matching organization; no disagreement between immutable and observed package/version. Unfinished or failed scans may supply identity but deserve scrutiny. A collision can be resolved by explicit approval once reviewed.
- **Ownership written:** personal approvals: `management_confirmed_at = NULL`; shared: application timestamp. Reapplying for the same owner preserves claim, stage, timestamps, and any confirmation. The tool never transfers or clears a user's decision.
- **SQL size:** each statement ≤ 90,000 bytes; select fewer packages per artifact if exceeded; a single package with too much history needs a separately reviewed migration strategy.
- **SQL shape:** one atomic seven-column `INSERT` that first revalidates every selected package's inventory rows, organization names, classification, competing organizations, trailing-slash variants, and unknown-registry legacy rows.
- **SQL aborts on:** added/deleted/changed evidence (`malformed JSON` guard error); existing noncanonical claim keys; any conflicting claim, including a deleted organization's reservation or a personal claim moved since review.

## Invariants

1. A claim never stops another organization's public-release monitoring ([publication-monitor.md](./publication-monitor.md)).
2. Names come from npm's stage record, never the manifest, so legacy mixed-case names such as `JSONStream` are accepted and kept case-sensitive.
3. A completed scan whose job row disappeared is discarded, never recreated, so it cannot leave a registry-less reservation.
4. Ownership persists when scans, watches, or credentials disappear. Deleting an organization leaves a reserved claim without an owner.
5. Deleting the last staged history of a name leaves an ownerless reservation: known registry identity uses its canonical key; unknown identity uses internal registry key `*`, which blocks public npm acquisition. While other staged history remains, deletion adds no reservation (it would deactivate the holders' monitoring and block their own next claim).
6. A contest over complete history ends only when one contender deletes its organization. No reservation authorizes an organization.
7. The audit tool cannot invent registry identity from the manifest, a current connection, an unscoped name, or a badge, and refuses existing ownerless reservations; those, shared-organization reassignment, and packages with no usable historical scan need a separately reviewed operator migration. Never populate scan registry fields by guessing.
8. An empty claims table intentionally makes historical npm badges unavailable until a package is assigned by backfill or, when uncontested, claimed by its next verified scan.
9. The backfill does not delete, merge, or reassign existing scans. Neither migration assigns owners or confirms personal management. Generating SQL authorizes no production write; this rollout does not itself authorize applying the migration, assigning owners, or deploying.

## Failure modes

| Symptom | Cause | Fix |
| --- | --- | --- |
| Discovery skips a package (`claimBlocked`) | claimed elsewhere, reserved, or unrelated pre-claim history | operator backfill or the claimant's next verified scan |
| Manual scan says support must confirm ownership | caller's own history is contested | audit and approve via the runbook |
| 409 on move | stale claim, or destination watch budget full | reload; free a watch slot in the destination |
| Badge and monitoring paused in personal workspace | provisional claim | Keep or Move |
| "automatic scans off" on Settings | personal automatic-scan consent pending | confirm via the callout or `POST /api/v1/npm-connection/personal-confirmation` |
| SQL apply aborts | snapshot changed or conflicting claim | fresh export, re-audit |
| Approval refused for a legacy row | missing immutable coordinates or mismatch | recover independent registry evidence first |

## Change checklist

- Claim rule change → `server/db/package-claims.ts`, the tables here, `test/package-claim-model.test.ts`, and [security-model.md](./security-model.md) if admission authority changes.
- Audit tool change → `scripts/package-claims-audit.mjs`, the audit tool table, `test/package-claims-audit.test.ts`.
- New claim column → migration via `pnpm db:generate`, the approval SQL column list, and the runbook.

## Why

- Treating registry-less legacy scans as public npm history stops a deployment from handing a previously reviewed package to a second organization merely because the old scan predates immutable coordinates.
- That history does not block other registries: otherwise an organization pointing its connection at a registry it runs could learn which names other organizations reviewed.
