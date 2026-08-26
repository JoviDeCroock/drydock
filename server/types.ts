import type { Auth, AuthSession } from "./lib/auth";
import type { BaselineInfo } from "./lib/ecosystems/package-adapter";

export type { ReleaseProvenance } from "./lib/ecosystems/package-adapter";
export type { StagedArtifactIntegrity } from "./lib/ecosystems/artifact-integrity";
import type { AiReview } from "./lib/ai-review";
import type { ReleaseConsistency } from "./lib/scan/release-memory";
import type { IntentEnvelope } from "./lib/intent-envelope";
import type { ScanRiskBreakdown } from "./lib/review/risk";
import type {
  CapabilityDelta,
  DiffEntry,
  Finding,
  PackageJsonDiff,
  PackageJsonSummary,
  RiskLevel,
} from "./lib/review";

export type {
  CapabilityDelta,
  CapabilitySet,
  PackageJsonDiff,
  PackageJsonDiffEntry,
} from "./lib/review";
export type { IntentEnvelope, IntentEnvelopeTier } from "./lib/intent-envelope";

export type Bindings = Cloudflare.Env;

export type Variables = {
  auth: Auth;
  authSession: AuthSession;
};

export interface ScanInput {
  stageId: string;
  maxFiles?: number;
}

export interface ScanResult {
  id: string;
  stageId: string;
  package: {
    name: string | null;
    stagedVersion: string | null;
    stagedTag: string | null;
    previousVersion: string | null;
  };
  baseline: BaselineInfo;
  fileCount: number;
  previousFileCount: number;
  packageJson: PackageJsonSummary | null;
  packageJsonDiff: PackageJsonDiff;
  diff: DiffEntry[];
  ruleFindings: Finding[];
  aiFindings: AiReview;
  risk: RiskLevel;
  riskSummary: ScanRiskBreakdown;
  // Advisory prior-release consistency signal (release memory). Display-only:
  // it never feeds risk or findings.
  releaseConsistency: ReleaseConsistency;
  // Advisory source-binding classification; never feeds risk or findings.
  intentEnvelope: IntentEnvelope;
  // Advisory per-side capability projection and delta; never feeds risk or
  // findings.
  capabilities: CapabilityDelta;
  safety: {
    tokenExposedToSandbox: boolean;
    directSandboxNetwork: boolean;
    outboundPolicy: string;
    aiInputPolicy: string;
    fileExplorerPolicy: string;
  };
}
