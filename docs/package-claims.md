# npm package ownership and migration audit

An npm package claim identifies one organization by the immutable registry URL, `npm` ecosystem, and registry package name. The first verified staged scan can establish a claim for a new package. Public package reviews, public watches, and workflow-gate checkpoints do not establish claims. Registry access failures cannot establish claims. The staged adapter validates and normalizes registry coordinates through `stagedClaimIdentity` before shared admission code can reserve them. Ownership persists when scans, watches, or credentials disappear; deletion of an organization leaves a reserved claim without an owner.

Historical staged scans prevent automatic first claims until an operator resolves their ownership. A scan whose registry URL was never recorded conservatively reserves its observed package name across registries. This prevents deployment from giving a second organization a previously reviewed package merely because the old scan predates immutable registry coordinates. Existing scans remain separate historical evidence; the migration does not delete, merge, or reassign them.

## Build a private inventory

The audit command only reads an exported JSON file. It never invokes Wrangler, connects to D1, or applies SQL. Its fixed export query reads selected identity and lifecycle fields from `scans` and organization names from `organizations`, excluding credentials, report contents, errors, and user details. It includes the npm staged sources `manual` and `auto_discovery`; public-diff and workflow-gate records cannot prove npm stage ownership.

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

Approvals require a scan with complete immutable registry URL (or the explicit public npm assumption above), package name, and version, an existing matching organization, and no disagreement between its immutable coordinates and its observed package/version. A scan need not have completed its content analysis to supply registry identity, but failed or unfinished scans warrant particular scrutiny. A collision can be resolved by an explicit approval once reviewed; the generated SQL also checks all competing scans for changes.

For legacy scans lacking immutable coordinates, or identity mismatches, recover and review independent registry-control-plane evidence first. The tool deliberately cannot invent registry identity from the manifest, a current connection, an unscoped package name, or a badge. An unresolved legacy package remains reserved. Deletion preserves a reservation without an owner: known registry identity uses its canonical registry key; unknown registry identity uses an internal `*` registry key that blocks acquisition across registries. Neither reservation authorizes an organization. This ordinary backfill tool refuses both kinds of existing ownerless reservation; resolving them requires a separately reviewed operator migration. Use a separately reviewed recovery migration when no complete historical scan can serve as evidence; do not populate scan registry fields by guessing merely to satisfy this tool. There is no transfer endpoint or automatic owner release. Reassignment requires a separately reviewed operator migration.

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

`approved-claims.sql` is an artifact for separate operator approval and application. Generation does not authorize or execute a production write. The generator limits each statement to a conservative 90,000 bytes; select fewer packages per artifact if that budget is exceeded. A single package with too much history needs a separately reviewed migration strategy. The schema migration creates an empty claims table; it never backfills owners automatically.

## Rollout prerequisite

Audit and resolve the historical inventory before enabling claim enforcement in production. Apply the schema and reviewed ownership assignments before deploying the new Worker; an empty claims table intentionally makes historical npm badges unavailable and blocks new staged admissions for those names. Unresolved legacy rows block automatic claims; deletion under the new Worker atomically preserves an ownerless reservation. Complete evidence recovery and explicit assignments before activation to avoid interrupting existing scans or badges. Drain existing scan jobs before the final inventory export so their changing status does not invalidate the reviewed snapshot. Assigned claims remain durable after history or organization deletion.

## Apply and verify only after approval

The SQL uses one atomic INSERT statement. Before inserting any selected claims, it revalidates all selected packages' inventory rows and organization names, including competing organizations, equivalent trailing-slash registry URLs, and legacy rows with unknown registries. Existing noncanonical claim keys also abort application until separately resolved. Added, deleted, or changed evidence aborts the whole statement with a `malformed JSON` guard error. A conflicting claim—including a reservation left by a deleted organization—also aborts every insertion. The unique key prevents concurrent acquisition; identical-owner reruns preserve the original claim and timestamp.

Apply only the inspected artifact under separate write authorization. Verify the selected keys and organizations in `npm_package_claims` after application and retain that verification privately. If validation fails, re-export and re-audit the changed state; do not remove guards. Normal scan status changes can invalidate the snapshot, so generate from a fresh export near the approved maintenance window. Never use `INSERT OR REPLACE` or delete another claim to force a backfill through.

The inventory export is read-only. This feature rollout does not itself authorize applying the schema migration, assigning historical owners, or deploying the Worker to production.
