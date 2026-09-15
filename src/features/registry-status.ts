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

/**
 * One vocabulary for npm's documented per-version statuses, shared by the
 * dashboard badge and the scan-detail timeline so the same state never reads
 * two ways on one page. `staged` is "awaiting approval": npm allows the
 * approval, and whether Drydock recommended it is the decision row's job.
 * Undocumented statuses have no phrase and render nothing.
 */
const REGISTRY_STATUS_PHRASE: Readonly<Record<string, string>> = {
  validating: "validating",
  staged: "awaiting approval",
  published: "published",
  blocked: "blocked",
  deleted: "removed",
};

export function registryStatusPhrase(status: string | null | undefined): string | null {
  // Registry-supplied string; hasOwn keeps prototype keys from phrasing.
  return status && Object.hasOwn(REGISTRY_STATUS_PHRASE, status)
    ? REGISTRY_STATUS_PHRASE[status]
    : null;
}

const BADGE_LABELS: Record<RegistryStatusVariant, { label: string; tone: BadgeTone }> = {
  blocked: { label: `npm ${REGISTRY_STATUS_PHRASE.blocked}`, tone: "critical" },
  awaiting_approval: { label: `npm ${REGISTRY_STATUS_PHRASE.staged}`, tone: "medium" },
  validating: { label: `npm ${REGISTRY_STATUS_PHRASE.validating}`, tone: "info" },
  published: { label: `npm ${REGISTRY_STATUS_PHRASE.published}`, tone: "ok" },
  deleted: { label: `npm ${REGISTRY_STATUS_PHRASE.deleted}`, tone: "unchanged" },
};

export function registryStatusBadge(
  scan: RegistryStatusScan,
): { label: string; tone: BadgeTone } | null {
  const variant = registryStatusVariant(scan);
  return variant ? BADGE_LABELS[variant] : null;
}
