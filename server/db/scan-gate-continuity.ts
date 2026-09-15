import { and, desc, eq } from "drizzle-orm";
import type { AppDb } from "./client";
import { githubWorkflowGates, scans } from "./schema";

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
  /** Completed gate reviews of exactly this package version, newest decision first. */
  forVersion: GateReviewRow[];
  /** Whether the organization has ever gated any version of this package. */
  packageHasGateHistory: boolean;
}

const GATE_REVIEW_LIMIT = 10;

/**
 * Load the organization's completed workflow-gate reviews of a package so a
 * registry-staged scan of the same package can be bound to the gate review of
 * the same bytes. Organization-scoped on both tables: a gate in another
 * organization is never evidence for this one.
 */
export async function loadGateReviewHistory(
  db: AppDb,
  input: { organizationId: string; packageName: string; version: string },
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
  const scope = and(
    eq(scans.organizationId, input.organizationId),
    eq(scans.source, "workflow_gate"),
    eq(scans.status, "complete"),
    eq(scans.packageName, input.packageName),
  );
  const [forVersion, anyVersion] = await Promise.all([
    db
      .select(selection)
      .from(scans)
      .leftJoin(
        githubWorkflowGates,
        and(
          eq(githubWorkflowGates.id, scans.gateId),
          eq(githubWorkflowGates.organizationId, input.organizationId),
        ),
      )
      .where(and(scope, eq(scans.stagedVersion, input.version)))
      // An explicit gate decision supersedes scan chronology. Undecided or
      // deleted gate rows fall back to the newest completed scan.
      .orderBy(desc(githubWorkflowGates.decidedAt), desc(scans.completedAt), desc(scans.createdAt))
      .limit(GATE_REVIEW_LIMIT),
    db.select({ id: scans.id }).from(scans).where(scope).limit(1),
  ]);
  return {
    forVersion: forVersion.map((row) => ({
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
    packageHasGateHistory: anyVersion.length > 0,
  };
}
