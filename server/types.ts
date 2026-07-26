import type { Auth, AuthSession } from "./lib/auth";
import type { BaselineInfo } from "./lib/ecosystems/package-adapter";

export type { ReleaseProvenance } from "./lib/ecosystems/package-adapter";
import type { AiReview } from "./lib/ai-review";
import type { ReleaseConsistency } from "./lib/scan/release-memory";
import type { ScanRiskBreakdown } from "./lib/review/risk";
import type {
  DiffEntry,
  Finding,
  PackageJsonDiff,
  PackageJsonSummary,
  RiskLevel,
} from "./lib/review";

export type { PackageJsonDiff, PackageJsonDiffEntry } from "./lib/review";

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
  safety: {
    tokenExposedToSandbox: boolean;
    directSandboxNetwork: boolean;
    outboundPolicy: string;
    aiInputPolicy: string;
    fileExplorerPolicy: string;
  };
}
