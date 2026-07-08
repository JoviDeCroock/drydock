import type { Finding } from "./review";

// Control-plane wiring for the detonation service (ambition proposal #7).
//
// TRUST BOUNDARY: the Worker never executes package code — the Workers isolate
// cannot spawn processes anyway. Detonation runs in a SEPARATE Cloudflare
// Container (the sacrificial environment), reachable from the Worker as a
// Fetcher binding. This module only:
//   1. dispatches the already-reviewed package file bytes (credential-free) to
//      that container,
//   2. validates the returned `drydock.detonation.v1` report, and
//   3. maps it to ADVISORY findings.
//
// The container is fed package bytes only — never npm/registry credentials,
// tokens, or anything that would let it reach a protected resource. Its output
// is advisory: like the AI reviewer, detonation findings annotate a review; they
// never downgrade or gate deterministic findings.

export const DETONATION_REPORT_SCHEMA = "drydock.detonation.v1";
export const DETONATION_RULES_VERSION = "detonation.v1";

export type DetonationVerdict = "clean" | "low" | "medium" | "high" | "critical";

export interface DetonationReportFinding {
  source: string;
  severity: string;
  ruleId: string;
  evidence: string;
  reason: string;
  observedCount?: number;
}

export interface DetonationReport {
  schema: string;
  verdict: DetonationVerdict;
  behaviorCount: number;
  findings: DetonationReportFinding[];
}

export interface DetonationPackageInput {
  name: string | null;
  version: string | null;
  ecosystem: string;
  // path -> reviewed file contents. Package bytes only; no credentials.
  files: Record<string, string>;
}

export interface DetonationInput {
  package: DetonationPackageInput;
}

export interface DetonationDispatcher {
  detonate(input: DetonationInput): Promise<unknown>;
}

const DISPATCH_URL = "https://detonation.internal/detonate";
const DISPATCH_TIMEOUT_MS = 60_000;

// A Cloudflare Container is exposed to the calling Worker as a Fetcher (via its
// Durable Object stub). This adapts that binding to the dispatcher interface so
// route code and tests depend on the small interface, not the platform binding.
export function bindingDispatcher(binding: Fetcher): DetonationDispatcher {
  return {
    async detonate(input) {
      const response = await binding.fetch(DISPATCH_URL, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(input),
        signal: AbortSignal.timeout(DISPATCH_TIMEOUT_MS),
      });
      if (!response.ok) {
        throw new Error(`detonation container returned ${response.status}`);
      }
      return response.json();
    },
  };
}

// Detonation is gated by the Cloudflare Flagship `detonation` flag, evaluated
// per-organization, default-off — the same posture as `ai-review`.
export async function isDetonationEnabled(
  env: { FLAGS?: Flagship },
  organizationId: string,
): Promise<boolean> {
  if (!env.FLAGS) return false;
  return env.FLAGS.getBooleanValue("detonation", false, {
    targetingKey: organizationId,
    organizationId,
  });
}

const VALID_VERDICTS = new Set<DetonationVerdict>(["clean", "low", "medium", "high", "critical"]);
const VALID_SEVERITIES = new Set(["info", "low", "medium", "high", "critical"]);

// Re-validate the container's response before trusting any of it: the detonation
// environment runs hostile code, so its output is untrusted input to the Worker.
export function parseDetonationReport(value: unknown): DetonationReport | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (record.schema !== DETONATION_REPORT_SCHEMA) return null;
  if (
    typeof record.verdict !== "string" ||
    !VALID_VERDICTS.has(record.verdict as DetonationVerdict)
  ) {
    return null;
  }
  if (!Array.isArray(record.findings)) return null;

  const findings: DetonationReportFinding[] = [];
  for (const entry of record.findings) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return null;
    const item = entry as Record<string, unknown>;
    if (
      typeof item.severity !== "string" ||
      !VALID_SEVERITIES.has(item.severity) ||
      typeof item.ruleId !== "string" ||
      typeof item.evidence !== "string" ||
      typeof item.reason !== "string"
    ) {
      return null;
    }
    findings.push({
      source: "detonation",
      severity: item.severity,
      ruleId: item.ruleId,
      evidence: String(item.evidence).slice(0, 2000),
      reason: String(item.reason).slice(0, 500),
      observedCount: typeof item.observedCount === "number" ? item.observedCount : undefined,
    });
  }

  return {
    schema: DETONATION_REPORT_SCHEMA,
    verdict: record.verdict as DetonationVerdict,
    behaviorCount:
      typeof record.behaviorCount === "number" ? record.behaviorCount : findings.length,
    findings,
  };
}

// Advisory finding shape returned to the client. `source: "detonation"` keeps
// these distinguishable from deterministic rule findings; they are their own
// list and never merge into the deterministic risk roll-up.
export interface DetonationAdvisoryFinding {
  severity: Finding["severity"];
  file: string;
  evidence: string;
  reason: string;
  source: "detonation";
  ruleId: string;
  ruleVersion: string;
  observedCount?: number;
}

export function detonationFindings(report: DetonationReport): DetonationAdvisoryFinding[] {
  return report.findings.map((finding) => ({
    severity: normalizeSeverity(finding.severity),
    file: "(install lifecycle)",
    evidence: finding.evidence,
    reason: finding.reason,
    source: "detonation",
    ruleId: finding.ruleId,
    ruleVersion: DETONATION_RULES_VERSION,
    observedCount: finding.observedCount,
  }));
}

function normalizeSeverity(value: string): Finding["severity"] {
  return VALID_SEVERITIES.has(value) ? (value as Finding["severity"]) : "info";
}

// Build the credential-free dispatch payload from a scan's reviewed file
// samples. Returns null when no package.json text is available (the container
// needs a manifest to know which lifecycle scripts to run).
export function detonationInputFromFiles(
  packageInfo: { name: string | null; version: string | null; ecosystem: string },
  files: Array<{ path: string; textSample: string | null }>,
): DetonationInput | null {
  const map: Record<string, string> = {};
  for (const file of files) {
    if (typeof file.textSample === "string") map[file.path] = file.textSample;
  }
  if (!map["package.json"]) return null;
  return { package: { ...packageInfo, files: map } };
}
