import { and, desc, eq, isNull, ne, or, sql } from "drizzle-orm";
import type { AppDb } from "./client";
import { githubAppInstallations, githubReleaseTargets, githubWorkflowGates, scans } from "./schema";

/**
 * One completed workflow-gate review of a package inside an organization,
 * joined with the durable gate row it belongs to. `summaryJson` is the raw
 * persisted adapter snapshot; the caller re-validates the provenance digests
 * out of it rather than trusting the shape.
 */
interface GateReviewRow {
  scanId: string;
  stagedVersion: string | null;
  summaryJson: unknown;
  completedAt: Date | null;
  gate: {
    id: string;
    repositoryFullName: string;
    environment: string;
    runId: number;
    status: string;
    decision: string | null;
    decidedAt: Date | null;
  } | null;
}

export interface GateReviewHistory {
  /**
   * The ecosystem the history was read for: the staged review's own. Only a
   * gate provenance naming it is a match candidate, however alike the names.
   */
  ecosystem: string;
  /** Completed gate reviews of exactly this package version, newest decision first. */
  forVersion: GateReviewRow[];
  /**
   * Whether the organization gates this package today: a completed gate
   * review of it ran through a release target that is still configured — or
   * through a repository some live target still gates — on a GitHub App installation that is
   * still active, and that target is not pinned to another ecosystem. Gate
   * history alone is not enough — an organization that ran one test gate and
   * deleted the target, or uninstalled the app, is no longer gating the
   * package, and a stage of it did not skip a gate that exists.
   */
  packageHasLiveGate: boolean;
  /**
   * Whether more completed reviews of this version exist than were read. A
   * truncated window is an absence of evidence: the approved review may be the
   * one left outside it, so a non-match cannot be reported as a mismatch.
   */
  truncated: boolean;
  /**
   * Whether a gate scan of this version exists that did not complete.
   * Such a scan is still a gate review a maintainer can decide, so its presence
   * rules out the claim that this version never went through the gate.
   */
  versionHasIncompleteGateScan: boolean;
}

const GATE_REVIEW_LIMIT = 10;

/**
 * Whether a workflow-gate scan reviewed an artifact of `ecosystem`. `scans`
 * has no ecosystem column, and a PyPI gate stores its project name in the same
 * `package_name` an npm stage is looked up by, so without this a PyPI
 * `acme-sdk` gate would be read as the gate history of npm `acme-sdk`.
 *
 * A completed review's provenance names its registry. A gate scan that never
 * completed has no report, so it falls back to the ecosystem the gate job wrote
 * into the stage id when it opened the row
 * (`workflow-gate:<gate id>:<ecosystem>:<package>`). Gate ids are UUIDs, so the
 * segment sits at a fixed offset and a package name cannot forge it. (`substr`
 * rather than `LIKE`: D1 caps LIKE patterns at 50 bytes.)
 */
const provenanceEcosystem = sql`json_extract(${scans.summaryJson}, '$.stagedPublish.provenance.ecosystem')`;
const GATE_STAGE_ID_PREFIX = "workflow-gate:";
const GATE_ID_LENGTH = 36;
function isGateScanOf(ecosystem: string) {
  const segment = `:${ecosystem}:`;
  return or(
    sql`${provenanceEcosystem} = ${ecosystem}`,
    and(
      sql`${provenanceEcosystem} is null`,
      sql`substr(${scans.stageId}, 1, ${GATE_STAGE_ID_PREFIX.length}) = ${GATE_STAGE_ID_PREFIX}`,
      sql`substr(${scans.stageId}, ${GATE_STAGE_ID_PREFIX.length + GATE_ID_LENGTH + 1}, ${segment.length}) = ${segment}`,
    ),
  );
}

/** A release target that can still gate `ecosystem`: unpinned or pinned to it. */
function releaseTargetFor(organizationId: string, ecosystem: string) {
  return and(
    eq(githubReleaseTargets.organizationId, organizationId),
    or(isNull(githubReleaseTargets.ecosystem), eq(githubReleaseTargets.ecosystem, ecosystem)),
  );
}

function activeInstallation(organizationId: string) {
  return and(
    eq(githubAppInstallations.id, githubReleaseTargets.installationRowId),
    eq(githubAppInstallations.organizationId, organizationId),
    eq(githubAppInstallations.status, "active"),
  );
}

/**
 * Load the organization's completed workflow-gate reviews of a package in one
 * ecosystem so a registry-staged scan of the same package can be bound to the
 * gate review of the same bytes. Organization-scoped on every table: a gate in another
 * organization is never evidence for this one.
 */
export async function loadGateReviewHistory(
  db: AppDb,
  input: { organizationId: string; ecosystem: string; packageName: string; version: string },
): Promise<GateReviewHistory> {
  const selection = {
    scanId: scans.id,
    stagedVersion: scans.stagedVersion,
    summaryJson: scans.summaryJson,
    completedAt: scans.completedAt,
    gateId: githubWorkflowGates.id,
    repositoryFullName: githubWorkflowGates.repositoryFullName,
    environment: githubWorkflowGates.environment,
    runId: githubWorkflowGates.runId,
    gateStatus: githubWorkflowGates.status,
    gateDecision: githubWorkflowGates.decision,
    gateDecidedAt: githubWorkflowGates.decidedAt,
  };
  const gateScansOfPackage = and(
    eq(scans.organizationId, input.organizationId),
    eq(scans.source, "workflow_gate"),
    eq(scans.packageName, input.packageName),
    isGateScanOf(input.ecosystem),
  );
  const completed = and(gateScansOfPackage, eq(scans.status, "complete"));
  const gateRowOfScan = and(
    eq(githubWorkflowGates.id, scans.gateId),
    eq(githubWorkflowGates.organizationId, input.organizationId),
  );
  const [forVersion, liveGate, incompleteForVersion] = await Promise.all([
    db
      .select(selection)
      .from(scans)
      .leftJoin(githubWorkflowGates, gateRowOfScan)
      .where(and(completed, eq(scans.stagedVersion, input.version)))
      // An explicit gate decision supersedes scan chronology. Undecided or
      // deleted gate rows fall back to the newest completed scan.
      .orderBy(desc(githubWorkflowGates.decidedAt), desc(scans.completedAt), desc(scans.createdAt))
      // One past the window, so a truncated read is detectable rather than
      // silently indistinguishable from a complete one.
      .limit(GATE_REVIEW_LIMIT + 1),
    db
      .select({ id: scans.id })
      .from(scans)
      .leftJoin(githubWorkflowGates, gateRowOfScan)
      .innerJoin(
        githubReleaseTargets,
        and(
          releaseTargetFor(input.organizationId, input.ecosystem),
          or(
            eq(githubReleaseTargets.id, githubWorkflowGates.releaseTargetId),
            // A target cannot be edited, only deleted and recreated, and the
            // delete cascades to its gate rows and unlinks their scans. The
            // scan's intent-envelope repository survives, so any live target
            // for that repository counts; without this, `ungated` would go
            // quiet until the next gate review. The envelope is normally the
            // gate-attested repository (it falls back to the manifest's only
            // when that fails to normalize), and a repository renamed before
            // the target was recreated no longer matches. Either way the
            // looser match can only add `ungated`, never hide it.
            sql`lower(json_extract(${scans.summaryJson}, '$.intentEnvelope.repository')) = lower('https://github.com/' || ${githubReleaseTargets.repositoryFullName})`,
          ),
        ),
      )
      .innerJoin(githubAppInstallations, activeInstallation(input.organizationId))
      .where(completed)
      .limit(1),
    db
      .select({ id: scans.id })
      .from(scans)
      .where(
        and(
          gateScansOfPackage,
          ne(scans.status, "complete"),
          eq(scans.stagedVersion, input.version),
        ),
      )
      .limit(1),
  ]);
  const truncated = forVersion.length > GATE_REVIEW_LIMIT;
  return {
    ecosystem: input.ecosystem,
    forVersion: forVersion.slice(0, GATE_REVIEW_LIMIT).map((row) => ({
      scanId: row.scanId,
      stagedVersion: row.stagedVersion,
      summaryJson: row.summaryJson,
      completedAt: row.completedAt,
      gate: row.gateId
        ? {
            id: row.gateId,
            repositoryFullName: row.repositoryFullName ?? "",
            environment: row.environment ?? "",
            runId: row.runId ?? 0,
            status: row.gateStatus ?? "pending",
            decision: row.gateDecision ?? null,
            decidedAt: row.gateDecidedAt ?? null,
          }
        : null,
    })),
    packageHasLiveGate: liveGate.length > 0,
    truncated,
    versionHasIncompleteGateScan: incompleteForVersion.length > 0,
  };
}

/**
 * Whether the organization has any release target that could gate a release
 * of `ecosystem` right now. Used when the registry's stage record was
 * unavailable, so there is no trustworthy package name to look up: with no
 * live target for the ecosystem there is nothing the stage could have gone
 * around.
 */
export async function hasLiveReleaseTarget(
  db: AppDb,
  organizationId: string,
  ecosystem: string,
): Promise<boolean> {
  const rows = await db
    .select({ id: githubReleaseTargets.id })
    .from(githubReleaseTargets)
    .innerJoin(githubAppInstallations, activeInstallation(organizationId))
    .where(releaseTargetFor(organizationId, ecosystem))
    .limit(1);
  return rows.length > 0;
}
