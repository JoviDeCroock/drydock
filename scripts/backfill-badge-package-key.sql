-- One-off backfill for the two badge columns added by migration
-- 0034_fancy_moira_mactaggert.sql. Idempotent: `badge_package_key IS NULL` is the guard, and
-- new scans get both values from `badgeLookupKey` / `isDefaultBadgePublic` at
-- persist time.
--
-- `badge_package_key` is the release line a scan belongs to, which is what lets
-- the badge notice a package has released again since the review it quotes.
-- `badge_public` is whether the review may answer the badge with no opt-in.
--
-- Publicness is npm's own `access` from the staged-publish record it returns,
-- the same field `isDefaultBadgePublic` and #687's watch auto-enrollment gate
-- on. Not the name shape, and not `publishConfig` out of the tarball, which is
-- package bytes.
--
-- Scoped to npm on purpose, and not as a shortcut: the npm key is the package
-- name verbatim (`npm:<name>`), so this cannot disagree with the TypeScript
-- rule it mirrors, while the PyPI key needs a lowercase-and-collapse
-- normalization that SQL would have to reimplement — a second copy of a naming
-- rule is exactly the kind of drift that produces a badge answering under the
-- wrong key. Nothing is lost: only npm has a default-on badge at all, and the
-- staleness check only considers releases npm reports as published, which is
-- written for npm alone. Other rows acquire their key when next persisted.
--
-- `published` reviews are excluded because they may never occupy the badge at
-- all (an unaffiliated review of someone else's package), which is the same
-- rule `isBadgeEligibleSource` applies.
--
-- THE ONE ASSERTION THIS MAKES: rows with a NULL `registry_url` predate the
-- column and are treated as the public npm registry. That is the whole risk in
-- this script — a NULL row from an organization on a private registry would be
-- marked public, and its unscoped approvals would become anonymously readable.
--
-- Verify before running, and do not run it if this returns anything but
-- https://registry.npmjs.org:
--
--   SELECT COALESCE(registry_url,'(none)'), COUNT(*) FROM npm_connections
--   GROUP BY 1;
--
-- Read that check honestly: it describes connections as they are *now*, and
-- says nothing about what a NULL row was scanned against. It is sound only
-- while no organization has ever used a private registry. If one has — or if
-- you cannot tell — drop the `badge_public` assignment from this script and
-- let the column populate forward-only from `isDefaultBadgePublic`, which
-- needs no assertion because it reads the registry the scan actually used.

UPDATE scans
SET badge_package_key = 'npm:' || package_name,
    badge_public = CASE
      WHEN json_extract(summary_json, '$.stagedPublish.access') = 'public'
       AND (
         registry_url IS NULL
         -- Exact host, never a prefix: `isDefaultBadgePublic` compares
         -- `new URL(u).host`, and a LIKE prefix would also admit
         -- `https://registry.npmjs.org.internal.corp` and
         -- `https://registry.npmjs.org-mirror.example` — private registries
         -- whose unscoped packages are not public at all. `normalizeRegistryUrl`
         -- strips the trailing slash, so the first form is what is stored.
         OR registry_url IN ('https://registry.npmjs.org', 'https://registry.npmjs.org/')
       )
      THEN 1 ELSE 0
    END
WHERE badge_package_key IS NULL
  AND package_name IS NOT NULL
  AND package_name != ''
  AND source IN ('manual', 'auto_discovery')
  AND (
    json_extract(summary_json, '$.stagedPublish.provenance.ecosystem') IS NULL
    OR json_extract(summary_json, '$.stagedPublish.provenance.ecosystem') = 'npm'
  );
