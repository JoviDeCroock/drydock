import { z } from "zod";
import { SCAN_DECISION_FILTERS, SCAN_DECISIONS, SCAN_SOURCES } from "../../db/enums";

// Response contracts for the API-key surface and the anonymous package diff,
// written once and used twice: `document.ts` renders them into the OpenAPI
// document, and the worker conformance suite parses real responses with them.
// Objects are loose on purpose: they pin the fields scripts may rely on, and
// any field not listed here is not part of the public contract.

const isoDateTime = z.string().describe("ISO 8601 timestamp");
const nullableIsoDateTime = isoDateTime.nullable();

const riskLevel = z
  .string()
  .describe("`low`, `medium`, `high`, or `critical`; `pending` until a review completes");
const severity = z.enum(["info", "low", "medium", "high", "critical"]);
const scanStatus = z.enum(["pending", "running", "complete", "failed"]);
const scanSource = z.enum(SCAN_SOURCES);
const scanDecision = z.enum(SCAN_DECISIONS).nullable();

const riskSummary = z
  .looseObject({
    artifactRisk: z.string(),
    releaseRisk: z.string(),
    contextRisk: z.string(),
    releaseFindingCount: z.number().int(),
    contextFindingCount: z.number().int(),
    unknownFindingCount: z.number().int(),
  })
  .describe("Risk split into the release delta and pre-existing package context");

const scanIdentity = {
  id: z.string(),
  stageId: z.string(),
  source: scanSource,
  packageName: z.string().nullable(),
  stagedVersion: z.string().nullable(),
  previousVersion: z.string().nullable(),
  risk: riskLevel,
  status: scanStatus,
  decision: scanDecision,
  decisionReason: z.string().nullable(),
  decidedAt: nullableIsoDateTime,
  changedFileCount: z.number().int(),
  findingCount: z.number().int(),
  reportDigest: z.string().nullable(),
  startedAt: nullableIsoDateTime,
  completedAt: nullableIsoDateTime,
  createdAt: isoDateTime,
  updatedAt: isoDateTime,
};

const finding = z.looseObject({
  severity,
  file: z.string(),
  line: z.number().int().nullable().optional(),
  ruleId: z.string().nullable().optional(),
  ruleVersion: z.string().nullable().optional(),
  source: z.enum(["rule", "ai"]).optional(),
  diffStatus: z.string().nullable().optional(),
  releaseDelta: z.boolean().nullable().optional(),
  evidence: z.string(),
  reason: z.string(),
});

export const ErrorResponse = z
  .looseObject({
    error: z.string(),
    code: z.string().optional().describe("Stable reason a client can act on"),
  })
  .meta({ id: "Error" });

export const ApiKeyIdentity = z
  .object({
    organization: z.object({ id: z.string(), name: z.string() }),
    key: z.object({
      id: z.string(),
      name: z.string(),
      prefix: z.string().describe("Non-secret head of the key, as shown in settings"),
      expiresAt: isoDateTime,
    }),
    access: z.literal("read"),
  })
  .meta({ id: "ApiKeyIdentity" });

export const ScanList = z
  .looseObject({
    scans: z.array(
      z.looseObject({
        ...scanIdentity,
        ecosystem: z.string().nullable(),
        riskSummary: riskSummary.nullable(),
      }),
    ),
    nextCursor: z.string().nullable().describe("Pass as `cursor` for the next page"),
    filter: z.enum(SCAN_DECISION_FILTERS),
    limit: z.number().int(),
  })
  .meta({ id: "ScanList" });

export const ScanOverview = z
  .looseObject({
    totalScans: z.number().int(),
    windowDays: z.number().int(),
    waiting: z.looseObject({ count: z.number().int(), oldestCompletedAt: nullableIsoDateTime }),
    validating: z.looseObject({ count: z.number().int(), reviewReady: z.number().int() }),
    publishedWithoutDecision: z.looseObject({ count: z.number().int() }),
    decided: z.looseObject({
      count: z.number().int(),
      approved: z.number().int(),
      rejected: z.number().int(),
      medianDecisionMs: z.number().nullable(),
    }),
  })
  .meta({ id: "ScanOverview" });

export const ScanDetail = z
  .looseObject({
    scan: z.looseObject({ ...scanIdentity, decidedByName: z.string().nullable() }),
    files: z.array(z.looseObject({ path: z.string() })),
    findings: z.array(finding),
    riskSummary: riskSummary.nullable(),
  })
  .meta({ id: "ScanDetail" });

export const ScanStatus = z
  .object({ scan: z.looseObject(scanIdentity) })
  .meta({ id: "ScanStatus" });

export const ReportExport = z
  .looseObject({
    schema: z.literal("drydock.report.v2"),
    scan: z.looseObject({
      id: z.string(),
      stageId: z.string(),
      status: scanStatus,
      source: scanSource,
      risk: riskLevel,
      decision: scanDecision,
      createdAt: nullableIsoDateTime,
      completedAt: nullableIsoDateTime,
    }),
    package: z.looseObject({
      name: z.string().nullable(),
      stagedVersion: z.string().nullable(),
      previousVersion: z.string().nullable(),
    }),
    riskSummary: riskSummary.nullable(),
    findings: z.array(finding),
  })
  .describe("Canonical, stable-ordered export of a completed review (`drydock.report.v2`)")
  .meta({ id: "ReportExport" });

export const ReleaseReceipt = z
  .looseObject({
    schema: z.literal("drydock.release-receipt.v1"),
    address: z.object({ algorithm: z.literal("sha256"), value: z.string() }),
    content: z.looseObject({
      report: z.looseObject({
        schema: z.literal("drydock.report.v2"),
        digest: z.object({ algorithm: z.literal("sha256"), value: z.string() }),
      }),
      release: z.looseObject({
        scanId: z.string(),
        stageId: z.string(),
        mode: z.enum(["workflow_gate", "staged_publish"]),
        source: scanSource,
        package: z.looseObject({
          name: z.string().nullable(),
          stagedVersion: z.string().nullable(),
          previousVersion: z.string().nullable(),
        }),
        risk: riskLevel,
      }),
      evidence: z.looseObject({
        status: z.string().describe("`complete`, `partial`, `conflicting`, or `unknown`"),
      }),
    }),
  })
  .describe("Release Receipt v1; see docs/release-receipts.md")
  .meta({ id: "ReleaseReceipt" });

export const PackageReleases = z
  .looseObject({
    package: z.object({ name: z.string(), ecosystem: z.string() }),
    summary: z.looseObject({
      totalReviews: z.number().int(),
      publishedWithoutDecision: z.number().int(),
      publishedDespiteBlock: z.number().int(),
    }),
    releases: z.array(
      z.looseObject({
        id: z.string(),
        stageId: z.string(),
        source: scanSource,
        status: scanStatus,
        stagedVersion: z.string().nullable(),
        previousVersion: z.string().nullable(),
        tag: z.string().nullable(),
        risk: riskLevel,
        riskSummary: riskSummary.nullable(),
        decision: scanDecision,
        decisionReason: z.string().nullable(),
        decidedByName: z.string().nullable(),
        decidedAt: nullableIsoDateTime,
        createdAt: isoDateTime,
        completedAt: nullableIsoDateTime,
      }),
    ),
    nextCursor: z.string().nullable(),
    limit: z.number().int(),
  })
  .meta({ id: "PackageReleases" });

export const WorkflowGate = z
  .object({
    gate: z.looseObject({
      id: z.string(),
      repositoryFullName: z.string(),
      environment: z.string(),
      runId: z.number().nullable(),
      status: z.string().describe("`pending` until every package is decided"),
      decision: z.string().nullable(),
      scanId: z.string().nullable(),
      packages: z.array(
        z.looseObject({
          scanId: z.string(),
          packageName: z.string().nullable(),
          version: z.string().nullable(),
          status: z.string(),
          releaseRisk: z.string().nullable(),
          decision: z.string().nullable(),
        }),
      ),
      requestedAt: isoDateTime,
      decidedAt: nullableIsoDateTime,
    }),
  })
  .meta({ id: "WorkflowGate" });

export const PublicPackageVersions = z
  .looseObject({
    ecosystem: z.string(),
    packageName: z.string(),
    displayName: z.string().nullable(),
    versions: z.array(z.unknown()),
    suggested: z.unknown(),
  })
  .meta({ id: "PublicPackageVersions" });

export const PublicPackageDiff = z
  .looseObject({
    ecosystem: z.string(),
    packageName: z.string(),
    fromVersion: z.string(),
    toVersion: z.string(),
    diff: z.array(z.looseObject({ path: z.string(), status: z.string() })),
    findings: z.array(finding),
    risk: z.looseObject({ artifactRisk: z.string(), releaseRisk: z.string() }),
    notices: z.array(z.string()),
    cachedAt: isoDateTime,
  })
  .meta({ id: "PublicPackageDiff" });

export const OpenApiDocument = z
  .looseObject({ openapi: z.string(), info: z.looseObject({}), paths: z.looseObject({}) })
  .meta({ id: "OpenApiDocument" });
