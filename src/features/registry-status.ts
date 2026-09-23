import type { BadgeTone } from "../components/Badge";

/** npm's lifecycle state as presented by the workbench. */
export type RegistryStatusVariant =
  | "blocked"
  | "awaiting_approval"
  | "validating"
  | "published"
  | "deleted";

export type RegistryStatusNoticeVariant = Exclude<RegistryStatusVariant, "published" | "deleted">;

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
 * Quiet terminal outcomes fit in the header badge. A separate notice is
 * reserved for states that add actionable context to the review.
 */
export function registryStatusNoticeVariant(
  scan: RegistryStatusScan,
): RegistryStatusNoticeVariant | null {
  const variant = registryStatusVariant(scan);
  return variant === "blocked" || variant === "awaiting_approval" || variant === "validating"
    ? variant
    : null;
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

/**
 * npm's state for a reviewed version, as the review surfaces print it. Every
 * label names npm so it is never read as Drydock's verdict.
 *
 * `tone` is set only when the state asks something of the reader: npm blocked
 * the version, still holds one approved here, or published one nobody here
 * approved. Everything else — validating, removed, published after approval —
 * is `null` and renders as plain text: a green chip on the expected ending, or
 * on a release that went live undecided, read as "fine" on rows where nothing
 * else was colored.
 */
export function registryStatusBadge(
  scan: RegistryStatusScan,
): { label: string; tone: BadgeTone | null } | null {
  switch (registryStatusVariant(scan)) {
    case null:
      return null;
    case "blocked":
      return { label: `npm ${REGISTRY_STATUS_PHRASE.blocked}`, tone: "critical" };
    case "awaiting_approval":
      return { label: `npm ${REGISTRY_STATUS_PHRASE.staged}`, tone: "medium" };
    case "validating":
      return { label: `npm ${REGISTRY_STATUS_PHRASE.validating}`, tone: null };
    case "deleted":
      return { label: `npm ${REGISTRY_STATUS_PHRASE.deleted}`, tone: null };
    case "published":
      if (scan.decision === "no_publish") {
        return { label: `npm ${REGISTRY_STATUS_PHRASE.published} over a block`, tone: "critical" };
      }
      if (!scan.decision) {
        return { label: `npm ${REGISTRY_STATUS_PHRASE.published}, no decision`, tone: "medium" };
      }
      return { label: `npm ${REGISTRY_STATUS_PHRASE.published}`, tone: null };
  }
}
