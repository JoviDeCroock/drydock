// Registry that turns raw `scan_events` rows into the organization audit log
// the settings UI renders. It is the single source of truth for:
//   - which event `type`s are surfaced to owners/admins (the visible allowlist),
//   - their human label, category, and severity,
//   - a short, redaction-safe detail line derived from event metadata.
//
// Anything not listed here is intentionally hidden from the audit view — scan
// lifecycle churn is no longer recorded at all, and notification-delivery and
// internal gate-processing events are persisted but excluded here as noise.

type AuditCategory = "release_decision" | "member" | "security" | "integration" | "organization";

type AuditSeverity = "info" | "notice" | "security";

interface AuditEventDef {
  category: AuditCategory;
  label: string;
  severity: AuditSeverity;
  // Pure, redaction-safe: only reads known non-sensitive metadata keys. Returns
  // a short human string or null when there is nothing extra worth showing.
  summarize?: (metadata: Record<string, unknown>) => string | null;
}

function str(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

function summarizePackageVersion(m: Record<string, unknown>): string | null {
  const pkg = str(m.packageName);
  const version = str(m.stagedVersion);
  if (pkg && version) return `${pkg}@${version}`;
  return pkg ?? version;
}

const REGISTRY: Record<string, AuditEventDef> = {
  // ── Release decisions ────────────────────────────────────────────────────
  "scan.decided": {
    category: "release_decision",
    label: "Release decision recorded",
    severity: "notice",
    summarize: (m) => {
      const decision = m.decision === "publish" ? "approved publish" : "blocked publish";
      const reason = str(m.reason);
      return reason ? `${decision} · ${reason}` : decision;
    },
  },
  "github_workflow_gate.requested": {
    category: "release_decision",
    label: "Release gate opened",
    severity: "info",
    summarize: (m) => str(m.repositoryFullName) ?? str(m.environment),
  },
  "github_workflow_gate.reviewed": {
    category: "release_decision",
    label: "Release gate reviewed",
    severity: "notice",
    summarize: (m) => str(m.recommendation),
  },
  "github_workflow_gate.approved": {
    category: "release_decision",
    label: "Release gate approved",
    severity: "notice",
    summarize: (m) => str(m.decidedBy),
  },
  "github_workflow_gate.rejected": {
    category: "release_decision",
    label: "Release gate rejected",
    severity: "notice",
    summarize: (m) => str(m.decidedBy),
  },
  "github_workflow_gate.timeout_missed": {
    category: "release_decision",
    label: "Release gate expired without a decision",
    severity: "security",
  },
  "ci_release_set.sealed": {
    category: "release_decision",
    label: "CI release uploaded for review",
    severity: "info",
    summarize: (m) => {
      const count = typeof m.artifactCount === "number" ? `${m.artifactCount} artifacts` : null;
      return count;
    },
  },
  // A publish job whose bytes drifted from what was reviewed is exactly the
  // failure the push path exists to catch, so it is surfaced as security-grade
  // rather than filed with routine release churn.
  "ci_release_set.verify_failed": {
    category: "release_decision",
    label: "Publish-time bytes did not match the reviewed release",
    severity: "security",
    summarize: (m) =>
      typeof m.mismatchCount === "number" ? `${m.mismatchCount} artifact(s) differ` : null,
  },

  // ── Members ──────────────────────────────────────────────────────────────
  "organization.member_invited": {
    category: "member",
    label: "Member invited",
    severity: "notice",
    summarize: (m) => str(m.invitedEmail),
  },
  "organization.member_joined": {
    category: "member",
    label: "Member joined",
    severity: "notice",
    summarize: (m) => {
      const email = str(m.email);
      const role = str(m.role);
      return email && role ? `${email} as ${role}` : (email ?? role);
    },
  },
  "organization.member_removed": {
    category: "member",
    label: "Member removed",
    severity: "notice",
    summarize: (m) => str(m.email),
  },
  "organization.member_invitation_revoked": {
    category: "member",
    label: "Invitation revoked",
    severity: "info",
  },

  // ── Security / policy ────────────────────────────────────────────────────
  "scan.share_enabled": {
    category: "security",
    label: "Public report link created",
    severity: "security",
    summarize: summarizePackageVersion,
  },
  "scan.share_revoked": {
    category: "security",
    label: "Public report link revoked",
    severity: "notice",
    summarize: summarizePackageVersion,
  },
  "scan.feed_listed": {
    category: "security",
    label: "Report listed in public threat feed",
    severity: "security",
    summarize: summarizePackageVersion,
  },
  "scan.feed_unlisted": {
    category: "security",
    label: "Report removed from public threat feed",
    severity: "notice",
    summarize: summarizePackageVersion,
  },
  "organization.release_two_factor_changed": {
    category: "security",
    label: "Release two-factor policy changed",
    severity: "security",
    summarize: (m) => (m.enabled ? "required" : "not required"),
  },
  "npm_connection.token_expired": {
    category: "security",
    label: "npm token stopped working",
    severity: "security",
    summarize: (m) => str(m.registryUrl),
  },

  // ── Integrations ─────────────────────────────────────────────────────────
  "npm_connection.upserted": {
    category: "integration",
    label: "npm connection saved",
    severity: "notice",
    summarize: (m) => str(m.label) ?? str(m.registryUrl),
  },
  "npm_connection.validated": {
    category: "integration",
    label: "npm connection validated",
    severity: "info",
    summarize: (m) => str(m.registryUrl),
  },
  "npm_connection.deleted": {
    category: "integration",
    label: "npm connection removed",
    severity: "notice",
    summarize: (m) => str(m.label) ?? str(m.registryUrl),
  },
  "github_app_installation.linked": {
    category: "integration",
    label: "GitHub App installed",
    severity: "notice",
    summarize: (m) => str(m.accountLogin),
  },
  "github_app_release_target.created": {
    category: "integration",
    label: "Release target added",
    severity: "notice",
    summarize: (m) => str(m.artifactName) ?? str(m.repositoryFullName),
  },
  "github_app_release_target.deleted": {
    category: "integration",
    label: "Release target removed",
    severity: "notice",
  },
  "organization.slack_connected": {
    category: "integration",
    label: "Slack connected",
    severity: "notice",
    summarize: (m) => str(m.teamName),
  },
  "organization.slack_channel_set": {
    category: "integration",
    label: "Slack channel set",
    severity: "info",
    summarize: (m) => str(m.channelName),
  },
  "organization.slack_enabled": {
    category: "integration",
    label: "Slack notifications enabled",
    severity: "info",
  },
  "organization.slack_disabled": {
    category: "integration",
    label: "Slack notifications disabled",
    severity: "info",
  },
  "organization.slack_disconnected": {
    category: "integration",
    label: "Slack disconnected",
    severity: "notice",
  },

  // ── Organization ─────────────────────────────────────────────────────────
  "organization.created": {
    category: "organization",
    label: "Organization created",
    severity: "info",
    summarize: (m) => str(m.name),
  },
  "organization.renamed": {
    category: "organization",
    label: "Organization renamed",
    severity: "info",
    summarize: (m) => str(m.name),
  },
  "organization.notification_recipient_added": {
    category: "organization",
    label: "Notification recipient added",
    severity: "info",
    summarize: (m) => str(m.recipient),
  },
  "organization.notification_recipient_removed": {
    category: "organization",
    label: "Notification recipient removed",
    severity: "info",
    summarize: (m) => str(m.recipient),
  },
};

// The allowlist of event types the audit log surfaces. Used to scope the query
// so hidden/operational events never leave the Worker.
export const AUDIT_VISIBLE_TYPES: readonly string[] = Object.keys(REGISTRY);

export interface AuditEventDescriptor {
  category: AuditCategory;
  label: string;
  severity: AuditSeverity;
  detail: string | null;
}

// Returns the display descriptor for a visible event, or null when the type is
// not part of the audit view (defense-in-depth against a type slipping through).
export function describeAuditEvent(type: string, metadata: unknown): AuditEventDescriptor | null {
  const def = REGISTRY[type];
  if (!def) return null;
  const bag =
    metadata && typeof metadata === "object" && !Array.isArray(metadata)
      ? (metadata as Record<string, unknown>)
      : {};
  let detail: string | null = null;
  if (def.summarize) {
    try {
      detail = def.summarize(bag);
    } catch {
      detail = null;
    }
  }
  return { category: def.category, label: def.label, severity: def.severity, detail };
}
