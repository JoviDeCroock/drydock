# npm package ownership and migration audit

An npm package claim identifies one organization by the immutable registry URL, `npm` ecosystem, and registry package name. The first verified staged scan can establish a claim for a new package. Public package reviews, public watches, and workflow-gate checkpoints do not establish claims, and a claim never stops another organization's public-release monitoring (see `publication-monitor.md`). Registry access failures cannot establish claims. The staged adapter validates and normalizes registry coordinates through `stagedClaimIdentity` before shared admission code can reserve them. Names come from npm's stage record, so legacy mixed-case names such as `JSONStream` are accepted and kept case-sensitive. A stage whose npm-reported name Drydock cannot review is refused permanently (422); an unverifiable identity remains a retryable 503. A completed scan whose job row disappeared is discarded rather than recreated, so it cannot leave a registry-less reservation. Ownership persists when scans, watches, or credentials disappear; deletion of an organization leaves a reserved claim without an owner.

Historical staged scans prevent automatic first claims until an operator resolves their ownership. Discovery skips stages whose package is claimed elsewhere, reserved, or held by pre-claim history before making any credentialed stage-access request, and reports them as `claimBlocked` plus a redacted `staged_publishes.claim_blocked` operational event. A manual scan blocked only by the caller's own pre-claim history says that support must confirm ownership. A scan whose registry URL was never recorded conservatively reserves its observed package name across registries. This prevents deployment from giving a second organization a previously reviewed package merely because the old scan predates immutable registry coordinates. Existing scans remain separate historical evidence; the migration does not delete, merge, or reassign them.

## Personal workspaces and organization choice

A personal workspace's first verified stage creates a **provisional** claim. It permits manual review immediately, but its monitoring and public badge wait for an explicit management choice. **Keep in personal workspace** sets `management_confirmed_at`; the personal claim remains transferable. Shared-organization claims are durable and can manage the package immediately. Personal classification comes from the organization's actual owner and ID, not a client flag.

The scan and package pages offer **Move to organization** for a package managed in the caller's personal workspace. The organization picker prefers a shared organization the caller manages. The session must own the actual personal workspace and hold a current owner/admin membership in the destination. `GET /api/v1/npm-package-claims/:name` returns only the selected organization's claim and eligible destinations; it never identifies another package owner. `POST` with `targetOrganizationId` confirms the current personal workspace or moves its claim to a shared organization. Both accept a registry selector; public npm is the default.

The claim update, audit events, and public-npm destination watch enrollment happen in one D1 batch. Authorization is checked again by the mutation. Competing transfers cannot both win; a full destination watch budget or stale claim returns 409 without moving ownership. Team-to-team, team-to-personal, and ownerless-reservation transfers are refused. Confirming or transferring management is an explicit enrollment action and clears the destination's watch opt-out. Existing personal scans, reports, observations, and credentials stay in the personal workspace. Its old watch becomes inactive through the ownership check (the workspace keeps staged reviews of a package another organization now manages) and stops counting toward its watch limit, while the destination starts with its own monitoring history. The move is permanent from the product: shared claims cannot be moved again. Confirming a claim that is already confirmed is a no-op that keeps the original timestamp and audit event. Transfer audit events record the registry, source, and destination organization. Its badge requires its own qualifying review; old personal approvals do not become team approvals.

Personal automatic scanning has a separate workspace choice when connecting or validating npm. Only an explicit `confirmPersonalOrganization: true` records `personal_organization_confirmed_at` on that connection. Without it, cron reconciles existing releases but creates no new scans in the personal workspace. Shared connections need no personal acknowledgment. This choice never copies an npm token into another organization. Existing personal connections must make the choice after rollout; manual review remains available.

## Build a private inventory

The audit command only reads an exported JSON file. It never invokes Wrangler, connects to D1, or applies SQL. Its fixed export query reads selected identity and lifecycle fields from `scans`, organization names, and a derived personal-workspace classification from `organizations`, excluding credentials, report contents, errors, and user details. The classification checks whether the organization's ID equals `personal:` plus its actual owner user ID; the owner's ID is not exported. It includes the npm staged sources `manual` and `auto_discovery`; public-diff and workflow-gate records cannot prove npm stage ownership.

Production inventories contain organization and package identifiers. Keep raw exports, reports, approvals, and generated SQL outside every repository and PR. Use an access-controlled private directory with `umask 077`. Do not paste their contents into public issues or comments. The command refuses output paths within this checkout, symlink ancestors, existing output directories, and overwrites; newly created directories and files use modes 0700 and 0600. Choose an actual directory path rather than a symlink such as `/tmp` on macOS (`/private/tmp` is the actual path). Avoid a temporary directory for the durable audit record.

```sh
umask 077
node scripts/package-claims-audit.mjs --query > /private/operator-audit/export.sql
pnpm exec wrangler d1 execute staged-publish-review --remote --json --file /private/operator-audit/export.sql > /private/operator-audit/staged-inventory.json
node scripts/package-claims-audit.mjs --input /private/operator-audit/staged-inventory.json --output /private/operator-audit/review-1
```

Create the private parent directory first; `review-1` must not exist. The Wrangler invocation is a separate operator action, authorized for reads only. Export after installing the code's schema migration when preparing an eventual apply; inventory export itself does not need the claims table.

`audit.md` summarizes observed registry/package groups, organizations, duplicate ownership candidates, and evidence issues. `inventory.json` includes the inventory SHA-256, each scan's ID, stage ID, immutable coordinates, observed manifest coordinates, organization identity, source/status, and per-organization counts and first/last timestamps (Unix milliseconds). Every group is unapproved, including groups with only one organization. Missing registry coordinates remain explicitly unknown. Canonical registry URLs and their historical trailing-slash variants share one audit group; each evidence row retains its original URL for revalidation. Approvals use the canonical URL without a trailing slash. Other noncanonical or unsupported URLs are flagged and cannot be approved by this tool; they require separate investigation rather than implicit repairs. A display fallback to a manifest package name is an inventory label, never a claim assignment.

## Explicit public npm registry assumption

When the operator has independently confirmed that every historical row belongs to public npm, add `--assume-public-npm-registry` to the report command and to any later SQL-generation command. The option assigns only missing registry URLs to `https://registry.npmjs.org` for grouping and approvals. It refuses contradictory recorded registries, retains the raw null URL and an assumption marker on each affected evidence row, and never supplies a missing immutable package name or version. Missing raw URL issues remain visible even when the approved assumption resolves their namespace.

```sh
node scripts/package-claims-audit.mjs --input /private/operator-audit/staged-inventory.json --output /private/operator-audit/public-npm-review --assume-public-npm-registry
```

The report and generated SQL state the assumption explicitly. The inventory hash includes it, so approval files from a strict audit cannot be reused under the assumption or vice versa. A row missing only its registry URL can then support an explicitly selected owner; rows missing immutable package names or versions still require independent evidence recovery. SQL continues to revalidate the original null registry field and all competing history before assigning anything. This option changes only the private audit workflow, not runtime support for custom registries.

## Audit and explicitly select owners

Review competing organizations, historical migrations, and whether the proposed organization is the actual continuing owner. The earliest timestamp is evidence, not an automatic ownership rule. Record the human decision and supporting evidence in a private audit record.

Each organization is labeled `personal_provisional`, `shared_durable`, or `unresolved` in the report. These describe the claim that an explicit approval would create, not a preselected owner or an existing confirmation. The classification is bound to the inventory hash and revalidated against the actual organization owner at application time. Older exports without `organization_is_personal` must be refreshed; do not fill it from the ID prefix alone.

New approved personal claims receive `management_confirmed_at = NULL`, leaving the personal workspace decision to its user. New approved shared-organization claims receive the application timestamp. Reapplying an approval for the same owner preserves the original claim, stage, timestamps, and any personal management confirmation already made. Personal claims remain eligible for the supported move to a shared organization even after confirmation; this backfill tool never performs that transfer or clears a user's decision.

Approvals require a scan with complete immutable registry URL (or the explicit public npm assumption above), package name, and version, an existing matching organization, and no disagreement between its immutable coordinates and its observed package/version. A scan need not have completed its content analysis to supply registry identity, but failed or unfinished scans warrant particular scrutiny. A collision can be resolved by an explicit approval once reviewed; the generated SQL also checks all competing scans for changes.

For legacy scans lacking immutable coordinates, or identity mismatches, recover and review independent registry-control-plane evidence first. The tool deliberately cannot invent registry identity from the manifest, a current connection, an unscoped package name, or a badge. An unresolved legacy package remains reserved. Deletion preserves a reservation without an owner: known registry identity uses its canonical registry key; unknown registry identity uses an internal `*` registry key that blocks acquisition across registries. Neither reservation authorizes an organization. This ordinary backfill tool refuses both kinds of existing ownerless reservation; resolving them requires a separately reviewed operator migration. Use a separately reviewed recovery migration when no complete historical scan can serve as evidence; do not populate scan registry fields by guessing merely to satisfy this tool. The audit tool cannot release or reassign ownership. Shared-organization reassignment requires a separately reviewed operator migration; the supported personal-to-shared move uses the authenticated product workflow.

Create an approval JSON file outside the repository. Nothing is preselected, and there is no approve-all switch:

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

Generate, inspect, and retain the resulting SQL privately:

```sh
node scripts/package-claims-audit.mjs --input /private/operator-audit/staged-inventory.json --approvals /private/operator-audit/approvals.json --output /private/operator-audit/approved-1
```

`approved-claims.sql` is an artifact for separate operator approval and application. Generation does not authorize or execute a production write. The generator limits each statement to a conservative 90,000 bytes; select fewer packages per artifact if that budget is exceeded. A single package with too much history needs a separately reviewed migration strategy. Migration `0035` creates an empty claims table; additive migration `0036` adds the nullable claim-management and personal-connection confirmation timestamps. Neither migration assigns owners or confirms personal management, and both must precede application of the seven-column approval SQL.

## Rollout prerequisite

Audit and resolve the historical inventory before enabling claim enforcement in production. Apply the schema and reviewed ownership assignments before deploying the new Worker; an empty claims table intentionally makes historical npm badges unavailable and blocks new staged admissions for those names. Unresolved legacy rows block automatic claims; deletion under the new Worker atomically preserves an ownerless reservation. Complete evidence recovery and explicit assignments before activation to avoid interrupting existing scans or badges. Drain existing scan jobs before the final inventory export so their changing status does not invalidate the reviewed snapshot. Assigned claims remain durable after history or organization deletion.

## Apply and verify only after approval

The SQL uses one atomic INSERT statement. Before inserting any selected claims, it revalidates all selected packages' inventory rows, organization names, and personal-workspace classification, including competing organizations, equivalent trailing-slash registry URLs, and legacy rows with unknown registries. Existing noncanonical claim keys also abort application until separately resolved. Added, deleted, or changed evidence aborts the whole statement with a `malformed JSON` guard error. A conflicting claim—including a reservation left by a deleted organization or a personal claim moved to a shared organization since review—also aborts every insertion. The unique key prevents concurrent acquisition; identical-owner reruns preserve the original claim and confirmation timestamps.

Apply only the inspected artifact under separate write authorization. Verify the selected keys and organizations in `npm_package_claims` after application and retain that verification privately. If validation fails, re-export and re-audit the changed state; do not remove guards. Normal scan status changes can invalidate the snapshot, so generate from a fresh export near the approved maintenance window. Never use `INSERT OR REPLACE` or delete another claim to force a backfill through.

The inventory export is read-only. This feature rollout does not itself authorize applying the schema migration, assigning historical owners, or deploying the Worker to production.
