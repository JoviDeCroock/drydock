import { sqliteTable, text, integer, index } from "drizzle-orm/sqlite-core";

export const scans = sqliteTable("scans", {
  id: text("id").primaryKey(),
  stageId: text("stage_id").notNull(),
  packageName: text("package_name"),
  stagedVersion: text("staged_version"),
  previousVersion: text("previous_version"),
  risk: text("risk").notNull().default("unknown"),
  status: text("status").notNull().default("pending"),
  summaryJson: text("summary_json", { mode: "json" }),
  aiJson: text("ai_json", { mode: "json" }),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
}, (table) => ({
  stageIdx: index("scans_stage_id_idx").on(table.stageId),
  packageIdx: index("scans_package_idx").on(table.packageName),
}));

export const scanFiles = sqliteTable("scan_files", {
  id: text("id").primaryKey(),
  scanId: text("scan_id").notNull().references(() => scans.id, { onDelete: "cascade" }),
  path: text("path").notNull(),
  status: text("status").notNull(),
  size: integer("size"),
  sha256: text("sha256"),
  flagsJson: text("flags_json", { mode: "json" }).notNull(),
  textSample: text("text_sample"),
}, (table) => ({
  scanPathIdx: index("scan_files_scan_path_idx").on(table.scanId, table.path),
}));

export const scanFindings = sqliteTable("scan_findings", {
  id: text("id").primaryKey(),
  scanId: text("scan_id").notNull().references(() => scans.id, { onDelete: "cascade" }),
  severity: text("severity").notNull(),
  file: text("file").notNull(),
  evidence: text("evidence").notNull(),
  reason: text("reason").notNull(),
  source: text("source").notNull().default("rule"),
});

export const user = sqliteTable("user", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  email: text("email").notNull().unique(),
  emailVerified: integer("email_verified", { mode: "boolean" }).notNull().default(false),
  image: text("image"),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
});

export const session = sqliteTable("session", {
  id: text("id").primaryKey(),
  expiresAt: integer("expires_at", { mode: "timestamp_ms" }).notNull(),
  token: text("token").notNull().unique(),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
  ipAddress: text("ip_address"),
  userAgent: text("user_agent"),
  userId: text("user_id").notNull().references(() => user.id, { onDelete: "cascade" }),
});

export const account = sqliteTable("account", {
  id: text("id").primaryKey(),
  accountId: text("account_id").notNull(),
  providerId: text("provider_id").notNull(),
  userId: text("user_id").notNull().references(() => user.id, { onDelete: "cascade" }),
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
