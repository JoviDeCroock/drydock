import { isRecord } from "../platform/guards";
import type { getScan } from "../../db/scans";
import { parsePersistedAiReview } from "../ai-review/contract";
import { displayedAiResult } from "../ai-review/types";
import { normalizeIntentEnvelope } from "../intent-envelope";
import { normalizeReleaseConsistency } from "./release-memory";
import type { ReleaseAuthoritySnapshot } from "../release-authority/snapshot";
import type { ReleaseProvenance, ReleaseProvenanceArtifact } from "../ecosystems/package-adapter";
import { isEcosystemId } from "../ecosystems/labels";
import { parseStagedArtifactIntegrity } from "../ecosystems/artifact-integrity";
import { canonicalJson } from "../platform/canonical-json";

// A persisted scan detail, as returned by getScan (never null at the call site).
type ScanDetail = NonNullable<Awaited<ReturnType<typeof getScan>>>;

interface ReportExportFilenameInput {
  id: string;
  packageName: string | null;
  stagedVersion: string | null;
}

// Schema tag for the exported report document. Bump the suffix when the export
// shape changes in a way consumers must branch on.
//
// v2 drops `releaseConsistency.priorScanId` and `releaseConsistency.decidedAt`
// (see `exportReleaseConsistency`). Those are removals from the authenticated
// `report.json` contract as much as from the public one, so they take the bump
// with them: the export is the signing boundary, and a consumer that pinned v1
// must not silently receive a document missing a field it read.
export const REPORT_EXPORT_SCHEMA = "drydock.report.v2";

// Build a self-contained, archivable view of a completed review from the data
// already persisted for it: provenance metadata, package/baseline identity, the
// risk summary, the manifest and file diffs, and the deterministic findings.
//
// This is the persisted *record*, not a re-derivation of the digested payload —
// the stored report digest is carried through for reference, but reproducing it
// byte-for-byte from the database is deliberately out of scope here.
export function buildReportExport(detail: ScanDetail) {
  const { scan } = detail;
  const summary = isRecord(scan.summaryJson) ? scan.summaryJson : {};
  return {
    schema: REPORT_EXPORT_SCHEMA,
    report: summary.report ?? null,
    scan: {
      id: scan.id,
      stageId: scan.stageId,
      status: scan.status,
      source: scan.source,
      risk: scan.risk,
      decision: scan.decision ?? null,
      createdAt: toIso(scan.createdAt),
      completedAt: toIso(scan.completedAt),
    },
    package: {
      name: scan.packageName ?? null,
      stagedVersion: scan.stagedVersion ?? null,
      previousVersion: scan.previousVersion ?? null,
    },
    // What the registry did with this version after the review, distinct from
    // `scan.decision`, which is what the organization decided about it. Additive
    // and optional: null whenever the lookup never ran, was not supported, or
    // could not be authorized — never as a statement about the release.
    registryStatus: exportRegistryStatus(scan),
    baseline: summary.baseline ?? null,
    safety: summary.safety ?? null,
    // Byte-continuity record: the reviewed artifacts + the digests recomputed
    // from the immutable release bytes, so a consumer can verify the published
    // wheel/sdist/tarball matches what Drydock reviewed. Workflow-gate reviews
    // only; null for staged-publish scans.
    provenance: extractProvenance(summary.stagedPublish),
    // Advisory source-binding tier (attested / declared / absent). Additive and
    // optional: scans persisted before the envelope existed export `null`.
    intentEnvelope: normalizeIntentEnvelope(summary.intentEnvelope),
    // Staged-artifact byte-verification verdict. Null for workflow gates,
    // legacy scans, and malformed persisted data.
    artifactIntegrity: extractArtifactIntegrity(summary.stagedPublish),
    aiReview: extractAiReview(scan.aiJson),
    riskSummary: detail.riskSummary ?? null,
    // Advisory release-memory signal. Additive + optional: scans that predate
    // the field (or persisted a malformed blob) export null.
    releaseConsistency: exportReleaseConsistency(summary.releaseConsistency),
    // Release authority: what was authorized to publish this release, how it
    // differs from the last approved baseline, and the binding between the
    // accepted authority and the exact artifact digests. Workflow-gate reviews
    // only; null everywhere else, and null must be read as "not assessed".
    releaseAuthority: extractReleaseAuthority(detail.releaseAuthority),
    packageJsonDiff: summary.packageJsonDiff ?? null,
    diff: summary.diff ?? null,
    // Deterministic findings only. A completed AI review's findings are carried
    // by `aiReview.findings` above; including the persisted `source: "ai"` rows
    // here too would double-count them in this array and break the invariant
    // that every entry has a ruleId/ruleVersion. Keeps `drydock.report.v2`'s
    // findings[] meaning stable across the persistence change.
    findings: detail.findings
      .filter((finding) => finding.source !== "ai")
      .sort(compareFindings)
      .map((finding) => ({
        severity: finding.severity,
        file: finding.file,
        line: finding.line ?? null,
        ruleId: finding.ruleId ?? null,
        ruleVersion: finding.ruleVersion ?? null,
        source: finding.source,
        diffStatus: finding.diffStatus ?? null,
        releaseDelta: finding.releaseDelta ?? null,
        evidence: finding.evidence,
        reason: finding.reason,
      })),
  };
}

function exportRegistryStatus(scan: ScanDetail["scan"]) {
  const status = scan.registryVersionStatus;
  if (typeof status !== "string" || !status) return null;
  return { status, observedAt: toIso(scan.registryVersionStatusAt) };
}

export type ReportExportDocument = ReturnType<typeof buildReportExport>;

// Serialize the export with stable key ordering so the same evidence always
// produces byte-identical output — the property two report artifacts need to be
// comparable, and a prerequisite for signing later.
export function serializeReportExport(detail: ScanDetail): string {
  return serializeReportExportDocument(buildReportExport(detail));
}

// Serialize an already-built export. The attestation route needs the document
// *and* its bytes: anything it asserts about the report has to be read off the
// same object that produced the digest it signs, or the two can disagree inside
// a signed envelope (they did — `findingCount` counted AI findings the
// document's `findings[]` deliberately excludes).
export function serializeReportExportDocument(document: ReportExportDocument): string {
  return canonicalJson(document);
}

export function reportExportFilename(scan: ReportExportFilenameInput): string {
  const packageName = filenameSegment(scan.packageName);
  const version = filenameSegment(scan.stagedVersion);
  if (packageName && version) return `drydock-${packageName}-${version}.json`;
  return `drydock-report-${filenameSegment(scan.id) || "scan"}.json`;
}

function compareFindings(
  a: ScanDetail["findings"][number],
  b: ScanDetail["findings"][number],
): number {
  return (
    cmp(a.file, b.file) ||
    cmp(a.ruleId ?? "", b.ruleId ?? "") ||
    (a.line ?? 0) - (b.line ?? 0) ||
    cmp(a.severity, b.severity)
  );
}

function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function toIso(value: unknown): string | null {
  if (value == null) return null;
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "number") return new Date(value).toISOString();
  if (typeof value === "string") return value;
  return null;
}

// The export drops `priorScanId` and `decidedAt`: both describe a *prior* scan
// the org never chose to share, and these bytes are served verbatim on the
// public report route. `decidedAt` is the sharper of the two — a precise
// timestamp of an internal review decision on an unshared release. What stays
// (`status`, the finding counts, `newFindings`) describes this scan's delta
// against that history, which is the signal the report is making.
function exportReleaseConsistency(raw: unknown) {
  const consistency = normalizeReleaseConsistency(raw);
  if (!consistency) return null;
  const { priorScanId: _priorScanId, decidedAt: _decidedAt, ...exported } = consistency;
  return exported;
}

// Pull the provenance block out of the persisted, adapter-shaped staged details.
// The shape is re-validated rather than trusted so a malformed or pre-provenance
// record exports as `null` instead of leaking partial data.
function extractProvenance(stagedPublish: unknown): ReleaseProvenance | null {
  if (!isRecord(stagedPublish)) return null;
  const provenance = stagedPublish.provenance;
  if (!isRecord(provenance)) return null;
  const { ecosystem, mode, artifacts } = provenance;
  if (typeof ecosystem !== "string" || !isEcosystemId(ecosystem) || mode !== "workflow_gate") {
    return null;
  }
  if (!Array.isArray(artifacts)) return null;
  const mapped: ReleaseProvenanceArtifact[] = [];
  for (const artifact of artifacts) {
    if (!isRecord(artifact)) return null;
    const { path, kind, sha256 } = artifact;
    if (typeof path !== "string" || typeof sha256 !== "string") return null;
    if (kind === "tarball" || kind === "wheel" || kind === "sdist" || kind === "vsix") {
      mapped.push({ path, kind, sha256 });
      continue;
    }
    return null;
  }
  if (!mapped.length) return null;
  return { ecosystem, mode, artifacts: mapped };
}

function extractArtifactIntegrity(stagedPublish: unknown) {
  if (!isRecord(stagedPublish)) return null;
  return parseStagedArtifactIntegrity(stagedPublish.artifactIntegrity);
}

// The archivable form of the release-authority record. The full snapshot is
// carried, not just the delta: a report has to stand on its own later, and the
// delta is only meaningful next to the authority it was computed from. Both
// halves are re-validated by the tolerant readers on the way in, so a
// pre-feature or malformed row exports as null rather than partial data.
//
// Identity is stripped on the way out. This document has exactly one
// serialization — the authenticated download, the shared `/public/reports/:token`
// body, and the attestation subject digest are all the same bytes — so anything
// in it is public the moment an owner mints a share token, and
// `docs/security-model.md` states that surface carries no org/user identifiers.
// Who approved the release and who triggered the run are answers the dashboard
// gives to an authenticated member; they are not part of the release's evidence.
function extractReleaseAuthority(record: ScanDetail["releaseAuthority"]) {
  if (!record) return null;
  const redactIdentity = releaseAuthorityIdentityRedactor(record.snapshot, record.delta);
  return {
    capturedAt: toIso(record.createdAt),
    runId: record.runId,
    workflowPath: record.workflowPath ? redactIdentity(record.workflowPath) : null,
    headSha: record.headSha,
    // The link between this approval and the exact bytes it accepted.
    artifactBindingDigest: record.artifactBindingDigest,
    approvedAt: toIso(record.approvedAt),
    snapshot: withoutRunIdentity(record.snapshot, redactIdentity),
    delta: exportReleaseAuthorityDelta(record.delta, redactIdentity),
  };
}

// The delta's baseline reference points at a different gate the organization
// may never have shared. Keep the fact that a comparison happened, but do not
// export that private gate's ids, run/commit coordinates, or approval time.
function exportReleaseAuthorityDelta(
  delta: NonNullable<ScanDetail["releaseAuthority"]>["delta"],
  redactIdentity: (value: string) => string,
) {
  if (!delta) return null;
  return {
    ...delta,
    changes: delta.changes.map((change) => {
      let exported = change;
      if (change.subject === "publish command") {
        exported = {
          ...change,
          before: exportCommandEvidence(change.before, "publish command [redacted]"),
          after: exportCommandEvidence(change.after, "publish command [redacted]"),
        };
      } else if (change.kind === "safeguard_added" || change.kind === "safeguard_removed") {
        const fallback = `${change.subject} safeguard`;
        exported = {
          ...change,
          before: exportCommandEvidence(change.before, fallback),
          after: exportCommandEvidence(change.after, fallback),
        };
      }
      return {
        ...exported,
        scope: redactIdentity(exported.scope),
        subject: redactIdentity(exported.subject),
        before: exported.before === null ? null : redactIdentity(exported.before),
        after: exported.after === null ? null : redactIdentity(exported.after),
      };
    }),
    standing: {
      ...delta.standing,
      mutableRefs: delta.standing.mutableRefs.map(redactIdentity),
      unresolved: delta.standing.unresolved.map((item) => ({
        ...item,
        path: redactIdentity(item.path),
      })),
    },
    baseline: delta.baseline ? { present: true as const } : null,
  };
}

// Drop GitHub logins and scrub legacy raw command evidence on export. Snapshots
// captured by current code already persist only command fingerprints, but the
// report boundary must also protect rows written before that invariant existed.
function withoutRunIdentity(
  snapshot: ReleaseAuthoritySnapshot | null,
  redactIdentity: (value: string) => string,
): ReleaseAuthoritySnapshot | null {
  if (!snapshot) return null;
  return {
    ...snapshot,
    run: {
      ...snapshot.run,
      repositoryFullName: redactIdentity(snapshot.run.repositoryFullName),
      workflowPath:
        snapshot.run.workflowPath === null ? null : redactIdentity(snapshot.run.workflowPath),
      actor: null,
      triggeringActor: null,
    },
    workflows: snapshot.workflows.map((workflow) => ({
      ...workflow,
      path: redactIdentity(workflow.path),
      repositoryFullName: redactIdentity(workflow.repositoryFullName),
    })),
    triggers: redactWorkflowFields(snapshot.triggers, redactIdentity),
    permissions: redactWorkflowFields(snapshot.permissions, redactIdentity),
    environments: redactWorkflowFields(snapshot.environments, redactIdentity),
    actions: redactWorkflowFields(snapshot.actions, redactIdentity).map((action) => ({
      ...action,
      uses: redactIdentity(action.uses),
    })),
    publishSteps: snapshot.publishSteps.map((step) => ({
      ...step,
      workflow: redactIdentity(step.workflow),
      detail:
        step.kind === "run"
          ? exportCommandEvidence(step.detail, "publish command [redacted]")!
          : redactIdentity(step.detail),
    })),
    safeguards: snapshot.safeguards.map((safeguard) => ({
      ...safeguard,
      workflow: redactIdentity(safeguard.workflow),
      detail: redactIdentity(
        exportCommandEvidence(safeguard.detail, `${safeguard.kind} safeguard`)!,
      ),
    })),
    artifactFlow: redactWorkflowFields(snapshot.artifactFlow, redactIdentity),
    coverage: {
      ...snapshot.coverage,
      unresolved: snapshot.coverage.unresolved.map((item) => ({
        ...item,
        path: redactIdentity(item.path),
      })),
    },
  };
}

function redactWorkflowFields<T extends { workflow: string }>(
  items: T[],
  redactIdentity: (value: string) => string,
): T[] {
  return items.map((item) => ({ ...item, workflow: redactIdentity(item.workflow) }));
}

function releaseAuthorityIdentityRedactor(
  snapshot: ReleaseAuthoritySnapshot | null,
  delta: NonNullable<ScanDetail["releaseAuthority"]>["delta"],
): (value: string) => string {
  const workflowRepositories = snapshot
    ? [
        snapshot.run.repositoryFullName,
        ...snapshot.workflows.map((workflow) => workflow.repositoryFullName),
      ]
    : [];
  const actionRepositories = snapshot
    ? snapshot.actions
        .map((action) => actionRepositoryFullName(action.uses))
        .filter((repository): repository is string => repository !== null)
    : [];
  for (const change of delta?.changes ?? []) {
    if (!ACTION_AUTHORITY_CHANGE_KINDS.has(change.kind)) continue;
    for (const value of [change.subject, change.before, change.after]) {
      if (typeof value !== "string") continue;
      const repository = actionRepositoryFullName(value);
      if (repository) actionRepositories.push(repository);
    }
  }
  const aliases = new Map<string, string>();
  const releaseRepository = snapshot?.run.repositoryFullName ?? null;
  let referencedIndex = 0;
  for (const repository of [...new Set(workflowRepositories.filter(Boolean))].sort()) {
    if (repository === releaseRepository) {
      aliases.set(repository, "release-repository");
    } else {
      referencedIndex += 1;
      aliases.set(repository, `referenced-repository-${referencedIndex}`);
    }
  }
  let actionIndex = 0;
  for (const repository of [...new Set(actionRepositories)].sort()) {
    if (aliases.has(repository)) continue;
    actionIndex += 1;
    aliases.set(repository, `action-repository-${actionIndex}`);
  }
  const replacements = [...aliases.entries()].sort(([left], [right]) => right.length - left.length);
  return (value: string) => {
    let redacted = value;
    for (const [repository, alias] of replacements) {
      redacted = redacted.replaceAll(repository, alias);
    }
    // A removed baseline workflow may name a repository absent from the
    // current snapshot. Workflow-qualified paths are the only such persisted
    // shape, so redact that prefix conservatively too.
    return redacted
      .replace(
        /(^|[\s,;(])(?:[A-Za-z0-9][A-Za-z0-9-]{0,38})\/(?:[A-Za-z0-9._-]{1,100})\/(?=\.github\/workflows\/)/g,
        "$1referenced-repository/",
      )
      .replace(
        /(^|[\s,;(])(?:[A-Za-z0-9][A-Za-z0-9-]{0,38})\/(?:[A-Za-z0-9._-]{1,100})(?=(?:\/[^@\s,;()]+)?@)/g,
        "$1referenced-action-repository",
      )
      .replace(
        /(^|[\s,;(])(?:[A-Za-z0-9][A-Za-z0-9-]{0,38})\/(?:[A-Za-z0-9._-]{1,100})(?=$|[\s,;)])/g,
        "$1referenced-action-repository",
      );
  };
}

function actionRepositoryFullName(uses: string): string | null {
  const trimmed = uses.trim();
  if (trimmed.startsWith("docker://")) {
    let repository = trimmed.slice("docker://".length).split("@", 1)[0] ?? "";
    const finalSlash = repository.lastIndexOf("/");
    const tagSeparator = repository.lastIndexOf(":");
    if (tagSeparator > finalSlash) repository = repository.slice(0, tagSeparator);
    return /^[A-Za-z0-9._:-]+(?:\/[A-Za-z0-9._-]+)+$/.test(repository) ? repository : null;
  }
  const match = trimmed.match(/^([A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9._-]{1,100})/);
  return match?.[1] ?? null;
}

const ACTION_AUTHORITY_CHANGE_KINDS = new Set([
  "action_added",
  "action_removed",
  "action_ref_changed",
  "action_unpinned",
  "action_pinned",
  "secrets_inherit_added",
  "action_configuration_changed",
]);

const COMMAND_EVIDENCE_RE =
  /^(?:npm publish|pnpm publish|yarn publish|bun publish|twine upload|uv publish|poetry publish|flit publish|hatch publish|maturin publish|cargo publish|vsce publish|ovsx publish|gem push|provenance flag|cosign sign|gpg detached signature|sigstore sign|GitHub attestation verify) \[sha256:[0-9a-f]{64}\]$/;

function exportCommandEvidence(value: string | null, fallback: string): string | null {
  if (value === null) return null;
  return COMMAND_EVIDENCE_RE.test(value) ? value : fallback;
}

// Route through the display helper so invalid/unavailable fallbacks do not
// leak the persisted `low` / `not_assessed` placeholders.
function extractAiReview(aiJson: unknown) {
  const review = parsePersistedAiReview(aiJson);
  if (!review) return null;
  const displayed = displayedAiResult(review);
  if (!displayed) return null;
  if (displayed.kind === "complete") {
    return {
      status: "complete",
      model: displayed.model,
      summary: displayed.summary,
      risk: displayed.risk,
      releaseAssessment: displayed.releaseAssessment,
      requiresManualReview: displayed.requiresManualReview,
      findings: displayed.findings.map((finding) => ({
        severity: finding.severity,
        file: finding.file,
        evidence: finding.evidence,
        reason: finding.reason,
        recommendation: finding.recommendation,
      })),
    };
  }
  return {
    status: displayed.status,
    model: displayed.model,
    summary: displayed.summary,
    risk: null,
    releaseAssessment: null,
    requiresManualReview: false,
    findings: [],
  };
}

function filenameSegment(value: string | null | undefined): string | null {
  const segment = value
    ?.trim()
    .replace(/[/\\]+/g, "-")
    .replace(/[^A-Za-z0-9@._+-]+/g, "-");
  const trimmed = segment?.replace(/-+/g, "-").replace(/^-|-$/g, "");
  return trimmed || null;
}
