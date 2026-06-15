export const REPORT_EXPORT_SCHEMA = "drydock.report.v1";

export const REPORT_PROVENANCE_LIMITATIONS = [
  "Drydock reviews staged or release-candidate bytes and persisted redacted evidence; it does not execute package code, install dependencies, or run builds.",
  "Deterministic findings are authoritative. AI commentary, when enabled, cannot downgrade deterministic findings.",
  "Raw tarballs and workflow artifacts are not retained by default.",
] as const;

export interface ReportArtifactDigest {
  path: string;
  kind: string | null;
  digestAlgorithm: "sha256" | "sha1";
  digest: string;
  source: "staged_publish" | "workflow_gate";
}

export interface ReportProvenance {
  report: {
    schema: typeof REPORT_EXPORT_SCHEMA;
    version: number | null;
    digestAlgorithm: string | null;
    digest: string | null;
    generatedAt: string | null;
    rulesVersion: string | null;
  };
  scan: {
    id: string;
    source: string | null;
    stageId: string | null;
    workflowGateId: string | null;
    createdAt: string | null;
    completedAt: string | null;
  };
  package: {
    name: string | null;
    stagedVersion: string | null;
    previousVersion: string | null;
    stagedTag: string | null;
  };
  baseline: unknown;
  artifacts: ReportArtifactDigest[];
  ai: {
    status: string | null;
    model: string | null;
  };
  review: {
    limitations: readonly string[];
  };
}

interface ProvenanceScanLike {
  id: string;
  stageId?: string | null;
  source?: string | null;
  gateId?: string | null;
  packageName?: string | null;
  stagedVersion?: string | null;
  previousVersion?: string | null;
  reportVersion?: number | null;
  reportDigest?: string | null;
  summaryJson?: unknown;
  aiJson?: unknown;
  createdAt?: unknown;
  completedAt?: unknown;
}

export function buildReportProvenance(detail: { scan: ProvenanceScanLike }): ReportProvenance {
  const { scan } = detail;
  const summary = asRecord(scan.summaryJson);
  const report = asRecord(summary?.report);
  const summaryProvenance = asRecord(summary?.provenance);
  const stagedPublish = summary?.stagedPublish;
  const stagedPublishSummary = asRecord(stagedPublish);
  const packageSummary = asRecord(summary?.package);
  const ai = asRecord(scan.aiJson);

  return {
    report: {
      schema: REPORT_EXPORT_SCHEMA,
      version: numberOrNull(report?.version) ?? scan.reportVersion ?? null,
      digestAlgorithm: stringOrNull(report?.digestAlgorithm),
      digest: stringOrNull(report?.digest) ?? scan.reportDigest ?? null,
      generatedAt: stringOrNull(report?.generatedAt),
      rulesVersion: stringOrNull(report?.rulesVersion),
    },
    scan: {
      id: scan.id,
      source: scan.source ?? null,
      stageId: scan.stageId ?? null,
      workflowGateId: scan.gateId ?? null,
      createdAt: toIso(scan.createdAt),
      completedAt: toIso(scan.completedAt),
    },
    package: {
      name: scan.packageName ?? null,
      stagedVersion: scan.stagedVersion ?? null,
      previousVersion: scan.previousVersion ?? null,
      stagedTag: stringOrNull(packageSummary?.stagedTag) ?? stringOrNull(stagedPublishSummary?.tag),
    },
    baseline: summary?.baseline ?? null,
    artifacts: normalizeArtifactSources(
      coerceArtifactDigests(summaryProvenance?.artifactDigests) ??
        extractArtifactDigests(stagedPublish),
      scan.source,
    ),
    ai: {
      status: stringOrNull(ai?.status),
      model: stringOrNull(ai?.model),
    },
    review: {
      limitations: coerceReviewLimitations(summaryProvenance?.reviewLimitations),
    },
  };
}

function coerceReviewLimitations(value: unknown): readonly string[] {
  if (!Array.isArray(value)) return REPORT_PROVENANCE_LIMITATIONS;
  const limitations = value.filter((item): item is string => typeof item === "string" && !!item);
  return limitations.length ? limitations : REPORT_PROVENANCE_LIMITATIONS;
}

function coerceArtifactDigests(value: unknown): ReportArtifactDigest[] | null {
  if (!Array.isArray(value)) return null;
  const items = value.flatMap((raw): ReportArtifactDigest[] => {
    const item = asRecord(raw);
    const path = stringOrNull(item?.path);
    const digest = stringOrNull(item?.digest);
    const algorithm = item?.digestAlgorithm;
    const source = item?.source;
    if (
      !path ||
      !digest ||
      (algorithm !== "sha256" && algorithm !== "sha1") ||
      (source !== "staged_publish" && source !== "workflow_gate")
    ) {
      return [];
    }
    return [
      {
        path,
        kind: stringOrNull(item?.kind),
        digestAlgorithm: algorithm,
        digest,
        source,
      },
    ];
  });
  return items;
}

export function extractArtifactDigests(stagedPublish: unknown): ReportArtifactDigest[] {
  const details = asRecord(stagedPublish);
  if (!details) return [];

  const source = details.mode === "workflow_gate" ? "workflow_gate" : "staged_publish";
  const out: ReportArtifactDigest[] = [];
  const manifest = asRecord(details.manifest);
  const ecosystem = stringOrNull(manifest?.ecosystem);
  const artifacts = Array.isArray(manifest?.artifacts) ? manifest.artifacts : [];

  for (const raw of artifacts) {
    const artifact = asRecord(raw);
    const digest = stringOrNull(artifact?.sha256);
    if (!digest || !isHexDigest(digest, 64)) continue;
    const path = stringOrNull(artifact?.path) ?? "release artifact";
    out.push({
      path,
      kind: stringOrNull(artifact?.kind) ?? inferArtifactKind(path, ecosystem),
      digestAlgorithm: "sha256",
      digest: digest.toLowerCase(),
      source,
    });
  }

  const reviewedDigest = stringOrNull(details.digest);
  if (reviewedDigest && isHexDigest(reviewedDigest, 64)) {
    const path = firstArtifactPath(artifacts) ?? "release artifact";
    out.push({
      path,
      kind: inferArtifactKind(path, ecosystem),
      digestAlgorithm: "sha256",
      digest: reviewedDigest.toLowerCase(),
      source,
    });
  }

  const npmShasum = stringOrNull(details.shasum);
  if (npmShasum && isHexDigest(npmShasum, 40)) {
    out.push({
      path: "npm staged tarball",
      kind: "tarball",
      digestAlgorithm: "sha1",
      digest: npmShasum.toLowerCase(),
      source,
    });
  }

  return dedupeDigests(out);
}

function dedupeDigests(items: ReportArtifactDigest[]): ReportArtifactDigest[] {
  const seen = new Set<string>();
  return items.filter((item) => {
    const key = `${item.path}\0${item.digestAlgorithm}\0${item.digest}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function normalizeArtifactSources(
  items: ReportArtifactDigest[],
  scanSource: string | null | undefined,
): ReportArtifactDigest[] {
  if (scanSource !== "workflow_gate") return items;
  return items.map((item) =>
    item.source === "workflow_gate" ? item : { ...item, source: "workflow_gate" },
  );
}

function firstArtifactPath(artifacts: unknown[]): string | null {
  for (const raw of artifacts) {
    const path = stringOrNull(asRecord(raw)?.path);
    if (path) return path;
  }
  return null;
}

function inferArtifactKind(path: string, ecosystem?: string | null): string | null {
  const lower = path.toLowerCase();
  if (lower.endsWith(".whl")) return "wheel";
  if (lower.endsWith(".tar.gz")) return ecosystem === "npm" ? "tarball" : "sdist";
  if (lower.endsWith(".tgz")) return "tarball";
  return null;
}

function isHexDigest(value: string, length: number): boolean {
  return value.length === length && /^[a-f0-9]+$/i.test(value);
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" && value ? value : null;
}

function numberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function toIso(value: unknown): string | null {
  if (value == null) return null;
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "number") return new Date(value).toISOString();
  if (typeof value === "string") return value;
  return null;
}
