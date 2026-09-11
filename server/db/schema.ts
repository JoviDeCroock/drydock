import {
  sqliteTable,
  text,
  integer,
  index,
  uniqueIndex,
  type AnySQLiteColumn,
} from "drizzle-orm/sqlite-core";

export const user = sqliteTable("user", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  email: text("email").notNull().unique(),
  emailVerified: integer("email_verified", { mode: "boolean" }).notNull().default(false),
  image: text("image"),
  twoFactorEnabled: integer("two_factor_enabled", { mode: "boolean" }),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
});

export const organizations = sqliteTable(
  "organizations",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    ownerUserId: text("owner_user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    // When true, every member must prove a fresh second factor before deciding a
    // release gate — and a member who has not enrolled in 2FA cannot decide one
    // at all. Off by default so existing orgs keep today's per-user step-up
    // behavior (enrolled members step up; others decide without a code).
    requireTwoFactorForReleaseDecisions: integer("require_two_factor_for_release_decisions", {
      mode: "boolean",
    })
      .notNull()
      .default(false),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
  },
  (table) => ({
    ownerIdx: index("organizations_owner_idx").on(table.ownerUserId),
  }),
);

export const organizationMembers = sqliteTable(
  "organization_members",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    role: text("role").notNull().default("owner"),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
  },
  (table) => ({
    userIdx: index("organization_members_user_idx").on(table.userId),
    memberUniqueIdx: uniqueIndex("organization_members_org_user_unique_idx").on(
      table.organizationId,
      table.userId,
    ),
  }),
);

export const organizationInvitations = sqliteTable(
  "organization_invitations",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    email: text("email").notNull(),
    role: text("role").notNull().default("member"),
    tokenHash: text("token_hash").notNull(),
    status: text("status").notNull().default("pending"),
    invitedByUserId: text("invited_by_user_id").references(() => user.id, { onDelete: "set null" }),
    acceptedByUserId: text("accepted_by_user_id").references(() => user.id, {
      onDelete: "set null",
    }),
    acceptedAt: integer("accepted_at", { mode: "timestamp_ms" }),
    expiresAt: integer("expires_at", { mode: "timestamp_ms" }).notNull(),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
  },
  (table) => ({
    tokenHashUniqueIdx: uniqueIndex("organization_invitations_token_hash_unique_idx").on(
      table.tokenHash,
    ),
    orgStatusIdx: index("organization_invitations_org_status_idx").on(
      table.organizationId,
      table.status,
    ),
    orgEmailIdx: index("organization_invitations_org_email_idx").on(
      table.organizationId,
      table.email,
    ),
  }),
);

export const organizationNotificationRecipients = sqliteTable(
  "organization_notification_recipients",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    email: text("email").notNull(),
    createdByUserId: text("created_by_user_id").references(() => user.id, { onDelete: "set null" }),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
  },
  (table) => ({
    orgEmailUniqueIdx: uniqueIndex("organization_notification_recipients_org_email_unique_idx").on(
      table.organizationId,
      table.email,
    ),
  }),
);

export const scans = sqliteTable(
  "scans",
  {
    id: text("id").primaryKey(),
    stageId: text("stage_id").notNull(),
    organizationId: text("organization_id").references(() => organizations.id, {
      onDelete: "cascade",
    }),
    ownerUserId: text("owner_user_id").references(() => user.id, { onDelete: "set null" }),
    // Workflow-gate reviews link each per-package scan back to its gate. A
    // monorepo release bundle produces several `workflow_gate` scans that share
    // one `gate_id`; the gate decision aggregates across them. Null for ordinary
    // (npm/manual) scans.
    gateId: text("gate_id").references((): AnySQLiteColumn => githubWorkflowGates.id, {
      onDelete: "set null",
    }),
    packageName: text("package_name"),
    stagedVersion: text("staged_version"),
    // Registry base URL captured when this staged release was discovered. npm
    // package coordinates are registry-local, so later connection edits must
    // never make an old scan query a different registry for the same name and
    // version.
    registryUrl: text("registry_url"),
    // Immutable registry-control-plane coordinates captured alongside
    // `registryUrl`. `packageName` / `stagedVersion` are intentionally replaced
    // with the inspected tarball manifest after a successful scan, and hostile
    // bytes must never be allowed to retarget a credentialed registry lookup.
    registryPackageName: text("registry_package_name"),
    registryVersion: text("registry_version"),
    previousVersion: text("previous_version"),
    risk: text("risk").notNull().default("unknown"),
    status: text("status").notNull().default("pending"),
    source: text("source").notNull().default("manual"),
    decision: text("decision"),
    decisionReason: text("decision_reason"),
    decidedByUserId: text("decided_by_user_id").references(() => user.id, {
      onDelete: "set null",
    }),
    decidedAt: integer("decided_at", { mode: "timestamp_ms" }),
    summaryJson: text("summary_json", { mode: "json" }),
    aiJson: text("ai_json", { mode: "json" }),
    errorJson: text("error_json", { mode: "json" }),
    changedFileCount: integer("changed_file_count"),
    findingCount: integer("finding_count"),
    riskSummaryJson: text("risk_summary_json", { mode: "json" }),
    reportVersion: integer("report_version"),
    reportDigest: text("report_digest"),
    artifactStorageVersion: integer("artifact_storage_version"),
    artifactManifestKey: text("artifact_manifest_key"),
    artifactManifestDigest: text("artifact_manifest_digest"),
    artifactManifestSize: integer("artifact_manifest_size"),
    reportArtifactKey: text("report_artifact_key"),
    fileSamplesArtifactKey: text("file_samples_artifact_key"),
    diffArtifactKey: text("diff_artifact_key"),
    // Public share link. A non-null token makes the completed scan's canonical
    // report export readable (unauthenticated) at /public/reports/:token.
    // Revoking or superseding the registry stage sets the token back to null;
    // the token itself is the only capability — there is no separate "enabled"
    // flag to drift out of sync.
    publicShareToken: text("public_share_token"),
    publicSharedAt: integer("public_shared_at", { mode: "timestamp_ms" }),
    publicSharedByUserId: text("public_shared_by_user_id").references(() => user.id, {
      onDelete: "set null",
    }),
    // Existing share tokens predate file-sample disclosure. Default false keeps
    // those capabilities evidence-only until an owner/admin deliberately
    // re-shares; newly created shares opt in when their token is minted.
    publicShareIncludesFiles: integer("public_share_includes_files", { mode: "boolean" })
      .notNull()
      .default(false),
    // Public threat-feed listing is a second, separate opt-in on top of the
    // share link: a shared report is reachable by anyone holding the link,
    // but only feed-listed scans appear in the discoverable
    // /public/threat-feed.json index. Cleared whenever the share is revoked or
    // the registry stage is superseded.
    publicFeedListedAt: integer("public_feed_listed_at", { mode: "timestamp_ms" }),
    // Set only after a post-publish registry check proves that every artifact
    // digest recorded by a workflow-gate review matches the published release.
    // Null means the gate's package identity is still manifest-claimed.
    registryVerifiedAt: integer("registry_verified_at", { mode: "timestamp_ms" }),
    // Ecosystem-prefixed canonical package identity used by the public badge.
    // Populated only while feed-listed, so private shares stay unqueryable by
    // package name and PyPI/VS Code aliases resolve through one indexed key.
    publicPackageKey: text("public_package_key"),
    // npm's own lifecycle status for this exact package version, as reported by
    // `GET /-/package/{name}/version/{version}/status`. This is the registry's
    // view of the release, never Drydock's: `decision` records what the
    // organization decided, this records what npm did with it afterwards.
    // Null means "not known" — the lookup is best-effort and npm answers 404
    // for both an unknown version and an unauthorized one, so absence can never
    // be read as a negative signal.
    registryVersionStatus: text("registry_version_status"),
    // When npm last returned the status above. Kept separate from the attempt
    // clock so a transient failure never makes a known status look freshly
    // observed or erases it from the workbench/report export.
    registryVersionStatusAt: integer("registry_version_status_at", { mode: "timestamp_ms" }),
    // When the lookup last ran, whether or not it produced a status. This is
    // the throttle and overlap fence: an unresolvable scan costs one call per
    // interval, and an older in-flight sweep cannot overwrite a newer result.
    registryVersionStatusAttemptedAt: integer("registry_version_status_attempted_at", {
      mode: "timestamp_ms",
    }),
    // Durable release-target tombstone. Creating a newer review for the same
    // registry/package/version stamps every older scan, so deleting a failed
    // newer scan can never make historical stage ids eligible again.
    registryStatusSupersededAt: integer("registry_status_superseded_at", {
      mode: "timestamp_ms",
    }),
    // Send-once stamp for the "you approved this, npm is still waiting" nudge.
    // A separate column rather than an event lookup because the sweep decides
    // whether to send while holding only this row.
    registryPublishReminderAt: integer("registry_publish_reminder_at", { mode: "timestamp_ms" }),
    startedAt: integer("started_at", { mode: "timestamp_ms" }),
    completedAt: integer("completed_at", { mode: "timestamp_ms" }),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
  },
  (table) => ({
    orgIdx: index("scans_org_idx").on(table.organizationId),
    ownerIdx: index("scans_owner_idx").on(table.ownerUserId),
    stageIdx: index("scans_stage_id_idx").on(table.stageId),
    packageIdx: index("scans_package_idx").on(table.packageName),
    // Serves the badge lookup, which filters on the canonical public key (not
    // package_name) and orders by completed_at. Keyed on the wrong column this
    // index covered nothing and taxed every write to the busiest table.
    publicPackageKeyCompletedIdx: index("scans_public_package_key_completed_idx").on(
      table.publicPackageKey,
      table.completedAt,
    ),
    gateIdx: index("scans_gate_org_idx").on(table.gateId, table.organizationId),
    artifactBackfillIdx: index("scans_artifact_backfill_idx").on(
      table.organizationId,
      table.status,
      table.artifactStorageVersion,
      table.id,
    ),
    orgDecisionCreatedIdx: index("scans_org_decision_created_idx").on(
      table.organizationId,
      table.decision,
      table.createdAt,
    ),
    orgCreatedIdx: index("scans_org_created_idx").on(
      table.organizationId,
      table.createdAt,
      table.id,
    ),
    // Serves the discovery sweep's "which reviewed releases still need a
    // registry status?" scan, which filters by organization and orders by the
    // last attempt. Without it that query walks every scan the org has ever
    // run, every 15 minutes.
    orgRegistryStatusIdx: index("scans_org_registry_status_idx").on(
      table.organizationId,
      table.registryUrl,
      table.registryStatusSupersededAt,
      table.registryVersionStatus,
      table.registryVersionStatusAttemptedAt,
    ),
    // Supports the correlated newest-incarnation guard in the registry-status
    // sweep. A package version can be rejected and staged again under a new
    // stage id, and duplicate manual reviews can also exist for one stage.
    orgRegistryReleaseIdx: index("scans_org_registry_release_idx").on(
      table.organizationId,
      table.registryUrl,
      table.registryPackageName,
      table.registryVersion,
      table.createdAt,
      table.id,
    ),
    // Account deletion nulls decided_by_user_id by user id, and D1 enforces the
    // user FK on delete; without this index both walk the whole table.
    decidedByIdx: index("scans_decided_by_idx").on(table.decidedByUserId),
    // Same reasoning for the share attribution column: account deletion nulls it
    // by user id, and the FK is checked on every user delete.
    publicSharedByIdx: index("scans_public_shared_by_idx").on(table.publicSharedByUserId),
    publicShareTokenUniqueIdx: uniqueIndex("scans_public_share_token_unique_idx").on(
      table.publicShareToken,
    ),
    publicFeedListedIdx: index("scans_public_feed_listed_idx").on(table.publicFeedListedAt),
    // No standalone public_package_key index: the composite above has it as a
    // leading column, so it already serves an equality lookup on the key alone.
  }),
);

export const scanEvents = sqliteTable(
  "scan_events",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    actorUserId: text("actor_user_id").references(() => user.id, { onDelete: "set null" }),
    scanId: text("scan_id").references(() => scans.id, { onDelete: "cascade" }),
    type: text("type").notNull(),
    metadataJson: text("metadata_json", { mode: "json" }),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  },
  (table) => ({
    orgCreatedIdx: index("scan_events_org_created_idx").on(table.organizationId, table.createdAt),
    scanIdx: index("scan_events_scan_idx").on(table.scanId),
    // The retention sweep deletes by bare created_at; the (org, created_at)
    // index cannot serve that, so without this it scans the whole audit table.
    createdIdx: index("scan_events_created_idx").on(table.createdAt),
    // Account deletion nulls actor_user_id by user id, and D1 enforces the user
    // FK on delete; both need a direct index on the column.
    actorIdx: index("scan_events_actor_idx").on(table.actorUserId),
  }),
);

export const rateLimits = sqliteTable(
  "rate_limits",
  {
    key: text("key").primaryKey(),
    count: integer("count").notNull().default(0),
    expiresAt: integer("expires_at", { mode: "timestamp_ms" }).notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
  },
  (table) => ({
    expiresIdx: index("rate_limits_expires_idx").on(table.expiresAt),
  }),
);

export const npmConnections = sqliteTable(
  "npm_connections",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    registryUrl: text("registry_url").notNull(),
    label: text("label").notNull(),
    tokenCiphertext: text("token_ciphertext").notNull(),
    tokenNonce: text("token_nonce").notNull(),
    tokenFingerprint: text("token_fingerprint").notNull(),
    tokenLast4: text("token_last4"),
    validationStatus: text("validation_status").notNull().default("unvalidated"),
    capabilitiesJson: text("capabilities_json", { mode: "json" }),
    validatedAt: integer("validated_at", { mode: "timestamp_ms" }),
    lastUsedAt: integer("last_used_at", { mode: "timestamp_ms" }),
    createdByUserId: text("created_by_user_id").references(() => user.id, { onDelete: "set null" }),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
  },
  (table) => ({
    orgUniqueIdx: uniqueIndex("npm_connections_org_unique_idx").on(table.organizationId),
    fingerprintIdx: index("npm_connections_fingerprint_idx").on(table.tokenFingerprint),
  }),
);

// One Slack workspace connection per organization, established through the
// "Add to Slack" OAuth flow. The bot token is encrypted at rest; only the single
// chosen public channel receives release alerts (channelId is null until the
// owner/admin picks one). `enabled` pauses delivery without dropping the token.
export const organizationSlackConnections = sqliteTable(
  "organization_slack_connections",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    teamId: text("team_id").notNull(),
    teamName: text("team_name"),
    botUserId: text("bot_user_id"),
    scope: text("scope"),
    botTokenCiphertext: text("bot_token_ciphertext").notNull(),
    botTokenNonce: text("bot_token_nonce").notNull(),
    channelId: text("channel_id"),
    channelName: text("channel_name"),
    enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
    createdByUserId: text("created_by_user_id").references(() => user.id, { onDelete: "set null" }),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
  },
  (table) => ({
    orgUniqueIdx: uniqueIndex("organization_slack_connections_org_unique_idx").on(
      table.organizationId,
    ),
  }),
);

export const githubAppInstallations = sqliteTable(
  "github_app_installations",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    installationId: text("installation_id").notNull(),
    accountLogin: text("account_login").notNull(),
    accountType: text("account_type").notNull(),
    targetType: text("target_type").notNull().default("Organization"),
    status: text("status").notNull().default("active"),
    suspendedAt: integer("suspended_at", { mode: "timestamp_ms" }),
    uninstalledAt: integer("uninstalled_at", { mode: "timestamp_ms" }),
    createdByUserId: text("created_by_user_id").references(() => user.id, { onDelete: "set null" }),
    installedAt: integer("installed_at", { mode: "timestamp_ms" }).notNull(),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
  },
  (table) => ({
    installationUniqueIdx: uniqueIndex("github_app_installations_installation_unique_idx").on(
      table.installationId,
    ),
    orgIdx: index("github_app_installations_org_idx").on(table.organizationId),
  }),
);

export const githubReleaseTargets = sqliteTable(
  "github_release_targets",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    installationRowId: text("installation_row_id")
      .notNull()
      .references(() => githubAppInstallations.id, { onDelete: "cascade" }),
    // Null means "auto-detect the ecosystem from the uploaded artifacts" (one
    // gate covers every package a monorepo publishes from the environment). A
    // non-null value pins detection + the default artifact name to one ecosystem
    // (the legacy single-ecosystem behavior).
    ecosystem: text("ecosystem"),
    // Optional override for the GitHub Actions artifact the release bundle is
    // downloaded from. Null falls back to the ecosystem default.
    artifactName: text("artifact_name"),
    repositoryId: integer("repository_id").notNull(),
    repositoryFullName: text("repository_full_name").notNull(),
    environment: text("environment").notNull(),
    createdByUserId: text("created_by_user_id").references(() => user.id, { onDelete: "set null" }),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
  },
  (table) => ({
    orgRepoEnvUniqueIdx: uniqueIndex("github_release_targets_org_repo_env_unique_idx").on(
      table.organizationId,
      table.repositoryId,
      table.environment,
    ),
    installationIdx: index("github_release_targets_installation_idx").on(table.installationRowId),
  }),
);

export const githubWorkflowGates = sqliteTable(
  "github_workflow_gates",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    installationRowId: text("installation_row_id")
      .notNull()
      .references(() => githubAppInstallations.id, { onDelete: "cascade" }),
    releaseTargetId: text("release_target_id")
      .notNull()
      .references(() => githubReleaseTargets.id, { onDelete: "cascade" }),
    deliveryId: text("delivery_id").notNull(),
    repositoryId: integer("repository_id").notNull(),
    repositoryFullName: text("repository_full_name").notNull(),
    environment: text("environment").notNull(),
    runId: integer("run_id").notNull(),
    deploymentId: integer("deployment_id"),
    deploymentCallbackUrl: text("deployment_callback_url").notNull(),
    eventAction: text("event_action").notNull(),
    status: text("status").notNull().default("pending"),
    decision: text("decision"),
    decisionComment: text("decision_comment"),
    reportUrl: text("report_url"),
    // Representative (highest-risk) package scan for the gate. The full set of
    // per-package scans is found via `scans.gate_id = github_workflow_gates.id`.
    scanId: text("scan_id").references(() => scans.id, { onDelete: "set null" }),
    // CAS claim so concurrent webhook re-deliveries don't double-run the review
    // batch. Set once when a delivery starts reviewing; a later delivery retries
    // only when the batch is incomplete.
    reviewStartedAt: integer("review_started_at", { mode: "timestamp_ms" }),
    failureReason: text("failure_reason"),
    requestedAt: integer("requested_at", { mode: "timestamp_ms" }).notNull(),
    decidedAt: integer("decided_at", { mode: "timestamp_ms" }),
    // Fairness cursor for the bounded post-publish verification sweep. Null
    // gates run first; retries then rotate by their oldest attempted timestamp.
    registryVerificationAttemptedAt: integer("registry_verification_attempted_at", {
      mode: "timestamp_ms",
    }),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
  },
  (table) => ({
    deliveryUniqueIdx: uniqueIndex("github_workflow_gates_delivery_unique_idx").on(
      table.deliveryId,
    ),
    orgStatusIdx: index("github_workflow_gates_org_status_idx").on(
      table.organizationId,
      table.status,
    ),
    releaseTargetIdx: index("github_workflow_gates_release_target_idx").on(table.releaseTargetId),
    scanIdx: index("github_workflow_gates_scan_idx").on(table.scanId),
  }),
);

export const session = sqliteTable(
  "session",
  {
    id: text("id").primaryKey(),
    expiresAt: integer("expires_at", { mode: "timestamp_ms" }).notNull(),
    token: text("token").notNull().unique(),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
    ipAddress: text("ip_address"),
    userAgent: text("user_agent"),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
  },
  (table) => ({
    userIdx: index("session_user_idx").on(table.userId),
  }),
);

export const account = sqliteTable(
  "account",
  {
    id: text("id").primaryKey(),
    accountId: text("account_id").notNull(),
    providerId: text("provider_id").notNull(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    accessToken: text("access_token"),
    refreshToken: text("refresh_token"),
    idToken: text("id_token"),
    accessTokenExpiresAt: integer("access_token_expires_at", { mode: "timestamp_ms" }),
    refreshTokenExpiresAt: integer("refresh_token_expires_at", { mode: "timestamp_ms" }),
    scope: text("scope"),
    password: text("password"),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
  },
  (table) => ({
    userIdx: index("account_user_idx").on(table.userId),
  }),
);

export const verification = sqliteTable(
  "verification",
  {
    id: text("id").primaryKey(),
    identifier: text("identifier").notNull(),
    value: text("value").notNull(),
    expiresAt: integer("expires_at", { mode: "timestamp_ms" }).notNull(),
    createdAt: integer("created_at", { mode: "timestamp_ms" }),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }),
  },
  (table) => ({
    // Better Auth resolves verification values by identifier on every
    // email-verification / password-reset / step-up flow.
    identifierIdx: index("verification_identifier_idx").on(table.identifier),
  }),
);

export const twoFactor = sqliteTable(
  "two_factor",
  {
    id: text("id").primaryKey(),
    secret: text("secret").notNull(),
    backupCodes: text("backup_codes").notNull(),
    verified: integer("verified", { mode: "boolean" }),
    failedVerificationCount: integer("failed_verification_count").default(0),
    lockedUntil: integer("locked_until", { mode: "timestamp_ms" }),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
  },
  (table) => ({
    userIdx: index("two_factor_user_idx").on(table.userId),
  }),
);
