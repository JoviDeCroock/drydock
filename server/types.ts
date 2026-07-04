import type { Auth, AuthSession } from "./lib/auth";
import type { AuthenticatedApiToken } from "./db/api-tokens";
import type { BaselineInfo } from "./lib/adapters/types";

export type {
  ReleaseProvenance,
  ReleaseProvenanceArtifact,
  ReleaseProvenanceArtifactKind,
} from "./lib/adapters/types";
import type { AiReview } from "./lib/ai-review";
import type { ScanRiskBreakdown } from "./lib/risk";
import type {
  DiffEntry,
  Finding,
  PackageJsonDiff,
  PackageJsonSummary,
  RiskLevel,
} from "./lib/review";

export type { PackageJsonDiff } from "./lib/review";

export type Bindings = Cloudflare.Env;

export type Variables = {
  auth: Auth;
  authSession: AuthSession;
  apiToken?: AuthenticatedApiToken;
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
  safety: {
    tokenExposedToSandbox: boolean;
    directSandboxNetwork: boolean;
    outboundPolicy: string;
    aiInputPolicy: string;
    fileExplorerPolicy: string;
  };
}
