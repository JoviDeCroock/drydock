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
  "decided",
  "publish",
  "no_publish",
  "all",
] as const;
export type ScanDecisionFilter = (typeof SCAN_DECISION_FILTERS)[number];

/**
 * What an organization API key may do, each level including the one before it.
 * `read` reaches only `API_KEY_ROUTES`; `scan` also starts reviews
 * (`API_KEY_SCAN_ROUTES`); `decide_staged` also records the advisory decision
 * on a staged-publish review (`API_KEY_DECIDE_ROUTES`). No level decides a
 * workflow gate.
 */
export const API_KEY_ACCESS_LEVELS = ["read", "scan", "decide_staged"] as const;
export type ApiKeyAccess = (typeof API_KEY_ACCESS_LEVELS)[number];

export type InvitationStatus = "pending" | "accepted" | "revoked";

export type NpmConnectionValidationStatus = "valid" | "invalid" | "unvalidated";

export type GithubAppInstallationStatus = "active" | "suspended" | "uninstalled";

export type WorkflowGateStatus = "pending" | "approved" | "rejected" | "errored";

export type WorkflowGateDecision = "approved" | "rejected";
