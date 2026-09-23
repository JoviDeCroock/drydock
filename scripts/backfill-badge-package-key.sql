-- One-off backfill for the badge columns added by migration 0034, plus a
-- correction to `public_package_key` on already-listed rows. Idempotent: the
-- first statement only ever clears, and the second is guarded by
-- `badge_package_key IS NULL`. New scans get the same values from
-- `badgeReleaseLineKey` / `isDefaultBadgePublic` at persist time, and new
-- listings from `badgeLookupKey`.
--
-- The rule both statements mirror (`scanPublicPackageName`): a staged review
-- (`manual`, `auto_discovery`) is publicly identified by npm's name for the
-- stage, `registry_package_name`, and only while the reviewed manifest's
-- `package_name` equals it. npm resolves names exactly, so equality is
-- SQLite's default case-sensitive `=`. A staged row whose manifest disagrees,
-- or that has no name from npm, has no public identity.
--
-- ASSUMPTIONS, each checkable read-only against prod before running
-- (`wrangler d1 execute staged-publish-review --remote --command "<query>"`):
--
-- 1. `registry_package_name` is npm's name, never the manifest's. It is written
--    by `createScanJob` from npm's stage list or stage record, and reconciled
--    against npm's stage record during acquisition, where a disagreement fails
--    the scan. The persisted stage record in the summary is the same answer,
--    so the two must never disagree. Expect 0:
--
--      SELECT COUNT(*) FROM scans
--      WHERE source IN ('manual', 'auto_discovery')
--        AND registry_package_name IS NOT NULL
--        AND json_extract(summary_json, '$.stagedPublish.packageName') IS NOT NULL
--        AND json_extract(summary_json, '$.stagedPublish.packageName') != registry_package_name;
--
-- 2. A row with a name from npm also has the registry it came from — both are
--    set together, so no NULL `registry_url` is ever read as public npm here.
--    Expect 0:
--
--      SELECT COUNT(*) FROM scans
--      WHERE registry_package_name IS NOT NULL AND registry_url IS NULL;
--
-- 3. `$.stagedPublish.access` is npm's access level from the same stage record,
--    not `publishConfig` from the tarball. It is written only from npm's
--    response (`summarizeDetails`), and `publication-auto-enrollment.ts` gates
--    on the same field.
--
-- 4. Staged rows are npm. Only npm has a staged adapter; the provenance guard
--    below keeps anything else out regardless.
--
-- What statement 1 withdraws — listed staged reviews that will stop answering
-- the badge — is worth reading before running. Rows predating migration 0027
-- have no `registry_package_name` and are among them; their listing and share
-- link are untouched, only the name-keyed badge stops answering for them:
--
--      SELECT COUNT(*),
--             SUM(registry_package_name IS NULL) AS no_npm_name,
--             SUM(registry_package_name IS NOT NULL) AS manifest_disagrees
--      FROM scans
--      WHERE public_package_key IS NOT NULL
--        AND source IN ('manual', 'auto_discovery')
--        AND (registry_package_name IS NULL OR package_name IS NULL
--             OR package_name != registry_package_name);
--
-- Scoped to npm on purpose: the npm key is the name verbatim (`npm:<name>`), so
-- it cannot disagree with `publicPackageLookupKey`, while PyPI and VS Code keys
-- need a normalization SQL would have to reimplement. Only npm has a staged
-- source or a default-on badge; gate rows keep the keys they were given.
--
-- `published` reviews are excluded because they may never occupy the badge at
-- all (an unaffiliated review of someone else's package), the same rule as
-- `isBadgeEligibleSource`.

-- 1. A listed staged review keeps its badge key only under npm's name, on the
--    public npm registry.
UPDATE scans
SET public_package_key = NULL
WHERE public_package_key IS NOT NULL
  AND source IN ('manual', 'auto_discovery')
  AND (
    registry_package_name IS NULL
    OR package_name IS NULL
    OR package_name != registry_package_name
    OR registry_url IS NULL
    OR registry_url NOT IN ('https://registry.npmjs.org', 'https://registry.npmjs.org/')
  );

-- 2. The release line (npm's name, whatever the manifest says) and default-on
--    eligibility (npm's name agrees, npm says public, public npm registry).
UPDATE scans
SET badge_package_key = 'npm:' || registry_package_name,
    badge_public = CASE
      WHEN package_name = registry_package_name
       AND json_extract(summary_json, '$.stagedPublish.access') = 'public'
       -- Exact host, never a prefix: `isDefaultBadgePublic` compares
       -- `new URL(u).host`, and a LIKE prefix would also admit
       -- `https://registry.npmjs.org.internal.corp` — a private registry whose
       -- packages are not public at all. `normalizeRegistryUrl` strips the
       -- trailing slash, so the first form is what is stored.
       AND registry_url IN ('https://registry.npmjs.org', 'https://registry.npmjs.org/')
      THEN 1 ELSE 0
    END
WHERE badge_package_key IS NULL
  AND registry_package_name IS NOT NULL
  AND registry_package_name != ''
  AND source IN ('manual', 'auto_discovery')
  AND (
    json_extract(summary_json, '$.stagedPublish.provenance.ecosystem') IS NULL
    OR json_extract(summary_json, '$.stagedPublish.provenance.ecosystem') = 'npm'
  );
