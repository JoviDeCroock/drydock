// Column vocabularies for `schema.ts`. This file imports nothing so the schema
// can type its enum-like `text()` columns without pulling in the modules that
// own the behavior behind each value.

export type ScanStatus = "pending" | "running" | "complete" | "failed";

export const SCAN_SOURCES = ["manual", "auto_discovery", "workflow_gate", "published"] as const;
export type ScanSource = (typeof SCAN_SOURCES)[number];

export const SCAN_DECISIONS = ["publish", "no_publish"] as const;
export type ScanDecision = (typeof SCAN_DECISIONS)[number];

export const SCAN_DECISION_FILTERS = [
  "undecided",
  "published_without_decision",
  "publish",
  "no_publish",
  "all",
] as const;
export type ScanDecisionFilter = (typeof SCAN_DECISION_FILTERS)[number];

export type InvitationStatus = "pending" | "accepted" | "revoked";

export type NpmConnectionValidationStatus = "valid" | "invalid" | "unvalidated";

export type GithubAppInstallationStatus = "active" | "suspended" | "uninstalled";

export type WorkflowGateStatus = "pending" | "approved" | "rejected" | "errored";

export type WorkflowGateDecision = "approved" | "rejected";
