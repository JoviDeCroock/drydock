import type { getScan } from "../../db/scans";
import type { WorkflowGateRecord } from "../github-app/webhook-gates";
import { sha256Hex } from "../platform/crypto-utils";
import { stableJson } from "../platform/stable-json";
import {
  buildReportExport,
  REPORT_EXPORT_SCHEMA,
  serializeReportExportDocument,
} from "./report-export";

type ScanDetail = NonNullable<Awaited<ReturnType<typeof getScan>>>;
type EvidenceStatus = "complete" | "partial" | "unknown" | "conflicting" | "not_applicable";

const RELEASE_RECEIPT_SCHEMA = "drydock.release-receipt.v1";

export async function buildReleaseReceipt(
  detail: ScanDetail,
  workflowGate: WorkflowGateRecord | null,
) {
  const report = buildReportExport(detail);
  const reportBytes = serializeReportExportDocument(report);
  const mode = detail.scan.source === "workflow_gate" ? "workflow_gate" : "staged_publish";
  const reviewedArtifacts = buildReviewedArtifacts(mode, report);
  const intentBinding = {
    status: report.intentEnvelope ? ("complete" as const) : ("unknown" as const),
    envelope: report.intentEnvelope,
  };
  const gate = buildWorkflowGate(mode, workflowGate);
  const requiredStatuses = [reviewedArtifacts.status, intentBinding.status, gate.status];
  const evidenceStatus = aggregateEvidenceStatus(requiredStatuses);
  const content = {
    report: {
      schema: REPORT_EXPORT_SCHEMA,
      digest: { algorithm: "sha256" as const, value: await sha256Hex(reportBytes) },
    },
    release: {
      scanId: detail.scan.id,
      stageId: detail.scan.stageId,
      mode,
      source: detail.scan.source,
      control: {
        classification:
          mode === "workflow_gate" ? ("workflow_enforced" as const) : ("advisory" as const),
        scope:
          mode === "workflow_gate"
            ? ("configured_publish_workflow" as const)
            : ("registry_stage_observation" as const),
      },
      package: {
        name: detail.scan.packageName ?? null,
        stagedVersion: detail.scan.stagedVersion ?? null,
        previousVersion: detail.scan.previousVersion ?? null,
      },
      risk: detail.scan.risk,
      decision: {
        outcome: detail.scan.decision ?? null,
        decidedAt: toIso(detail.scan.decidedAt),
        reviewer: detail.scan.decidedByUserId
          ? { kind: "drydock_user" as const, id: detail.scan.decidedByUserId }
          : null,
      },
    },
    evidence: {
      status: evidenceStatus,
      report: { status: "complete" as const },
      reviewedArtifacts,
      intentBinding,
      workflowGate: gate,
      registryOutcome: report.registryStatus
        ? { status: "complete" as const, observation: report.registryStatus }
        : { status: "unknown" as const, observation: null },
    },
  };
  const address = {
    algorithm: "sha256" as const,
    value: await sha256Hex(stableJson(content)),
  };
  return { schema: RELEASE_RECEIPT_SCHEMA, address, content };
}

export type ReleaseReceiptDocument = Awaited<ReturnType<typeof buildReleaseReceipt>>;

export function serializeReleaseReceipt(document: ReleaseReceiptDocument): string {
  return stableJson(document);
}

export function releaseReceiptFilename(scanId: string, documentSha256: string): string {
  const id = scanId.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-|-$/g, "") || "scan";
  return `drydock-release-receipt-${id}-${documentSha256}.json`;
}

function buildReviewedArtifacts(
  mode: "workflow_gate" | "staged_publish",
  report: ReturnType<typeof buildReportExport>,
) {
  if (mode === "workflow_gate") {
    return report.provenance
      ? {
          status: "complete" as const,
          provenance: report.provenance,
          stagedArtifactIntegrity: null,
        }
      : { status: "unknown" as const, provenance: null, stagedArtifactIntegrity: null };
  }
  const integrity = report.artifactIntegrity;
  const status: EvidenceStatus =
    integrity?.status === "verified"
      ? "complete"
      : integrity?.status === "mismatch"
        ? "conflicting"
        : integrity
          ? "partial"
          : "unknown";
  return { status, provenance: null, stagedArtifactIntegrity: integrity };
}

function buildWorkflowGate(
  mode: "workflow_gate" | "staged_publish",
  gate: WorkflowGateRecord | null,
) {
  if (mode === "staged_publish") {
    return {
      status: "not_applicable" as const,
      identity: null,
      decision: null,
      callback: null,
    };
  }
  if (!gate) {
    return {
      status: "unknown" as const,
      identity: { repository: null, runId: null, environment: null },
      decision: { status: null, outcome: null, decidedAt: null },
      callback: { outcome: "unknown" as const, observedAt: null },
    };
  }
  return {
    status: "complete" as const,
    identity: {
      repository: gate.repositoryFullName,
      runId: gate.runId,
      environment: gate.environment,
    },
    decision: {
      status: gate.status,
      outcome: gate.decision,
      decidedAt: toIso(gate.decidedAt),
    },
    // Callback delivery is currently observable only in ephemeral operational
    // logs. A durable gate decision is not proof GitHub received it.
    callback: { outcome: "unknown" as const, observedAt: null },
  };
}

function aggregateEvidenceStatus(
  statuses: EvidenceStatus[],
): "complete" | "partial" | "conflicting" {
  if (statuses.includes("conflicting")) return "conflicting";
  if (statuses.every((status) => status === "complete" || status === "not_applicable")) {
    return "complete";
  }
  return "partial";
}

function toIso(value: unknown): string | null {
  if (value == null) return null;
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "number") return new Date(value).toISOString();
  if (typeof value === "string") return value;
  return null;
}
