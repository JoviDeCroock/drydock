import type { BadgeTone } from "../components/Badge";

/** npm's lifecycle state as presented by the workbench. */
export type RegistryStatusVariant =
  | "blocked"
  | "awaiting_approval"
  | "validating"
  | "published"
  | "deleted";

export interface RegistryStatusScan {
  registryVersionStatus?: string | null;
  registryVersionStatusAt?: string | number | Date | null;
  decision?: string | null;
  source?: string | null;
  stageId?: string | null;
  registryUrl?: string | null;
  registryStatusSupersededAt?: string | number | Date | null;
}

/**
 * Plain `staged` with no decision recorded is the normal resting state of a
 * release under review. It becomes actionable only after approval here.
 */
export function registryStatusVariant(scan: RegistryStatusScan): RegistryStatusVariant | null {
  if (scan.registryStatusSupersededAt != null) return null;
  switch (scan.registryVersionStatus) {
    case "blocked":
      return "blocked";
    case "validating":
      return "validating";
    case "published":
      return "published";
    case "deleted":
      return "deleted";
    case "staged":
      return scan.decision === "publish" ? "awaiting_approval" : null;
    default:
      return null;
  }
}

const BADGE_LABELS: Record<RegistryStatusVariant, { label: string; tone: BadgeTone }> = {
  blocked: { label: "npm blocked", tone: "critical" },
  awaiting_approval: { label: "npm awaiting approval", tone: "medium" },
  validating: { label: "npm validating", tone: "info" },
  published: { label: "npm published", tone: "ok" },
  deleted: { label: "npm removed", tone: "unchanged" },
};

export function registryStatusBadge(
  scan: RegistryStatusScan,
): { label: string; tone: BadgeTone } | null {
  const variant = registryStatusVariant(scan);
  return variant ? BADGE_LABELS[variant] : null;
}
