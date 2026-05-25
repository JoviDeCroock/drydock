import { sqliteTable, text, integer, index, uniqueIndex } from "drizzle-orm/sqlite-core";

export const user = sqliteTable("user", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  email: text("email").notNull().unique(),
  emailVerified: integer("email_verified", { mode: "boolean" }).notNull().default(false),
  image: text("image"),
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

export const scans = sqliteTable(
  "scans",
  {
    id: text("id").primaryKey(),
    stageId: text("stage_id").notNull(),
    organizationId: text("organization_id").references(() => organizations.id, {
      onDelete: "cascade",
    }),
    ownerUserId: text("owner_user_id").references(() => user.id, { onDelete: "set null" }),
    packageName: text("package_name"),
    stagedVersion: text("staged_version"),
    previousVersion: text("previous_version"),
    risk: text("risk").notNull().default("unknown"),
    status: text("status").notNull().default("pending"),
    decision: text("decision"),
    decisionReason: text("decision_reason"),
    decidedByUserId: text("decided_by_user_id").references(() => user.id, {
      onDelete: "set null",
    }),
    decidedAt: integer("decided_at", { mode: "timestamp_ms" }),
    summaryJson: text("summary_json", { mode: "json" }),
    aiJson: text("ai_json", { mode: "json" }),
    errorJson: text("error_json", { mode: "json" }),
    reportVersion: integer("report_version"),
    reportDigest: text("report_digest"),
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
    orgDecisionCreatedIdx: index("scans_org_decision_created_idx").on(
      table.organizationId,
      table.decision,
      table.createdAt,
    ),
  }),
);

export const scanFiles = sqliteTable(
  "scan_files",
  {
    id: text("id").primaryKey(),
    scanId: text("scan_id")
      .notNull()
      .references(() => scans.id, { onDelete: "cascade" }),
    path: text("path").notNull(),
    status: text("status").notNull(),
    size: integer("size"),
    sha256: text("sha256"),
    flagsJson: text("flags_json", { mode: "json" }).notNull(),
    textSample: text("text_sample"),
  },
  (table) => ({
    scanPathIdx: index("scan_files_scan_path_idx").on(table.scanId, table.path),
  }),
);

export const scanFindings = sqliteTable("scan_findings", {
  id: text("id").primaryKey(),
  scanId: text("scan_id")
    .notNull()
    .references(() => scans.id, { onDelete: "cascade" }),
  severity: text("severity").notNull(),
  file: text("file").notNull(),
  evidence: text("evidence").notNull(),
  reason: text("reason").notNull(),
  line: integer("line"),
  source: text("source").notNull().default("rule"),
  ruleId: text("rule_id"),
  ruleVersion: text("rule_version"),
});

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

export const session = sqliteTable("session", {
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
});

export const account = sqliteTable("account", {
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
});

export const verification = sqliteTable("verification", {
  id: text("id").primaryKey(),
  identifier: text("identifier").notNull(),
  value: text("value").notNull(),
  expiresAt: integer("expires_at", { mode: "timestamp_ms" }).notNull(),
  createdAt: integer("created_at", { mode: "timestamp_ms" }),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }),
});
