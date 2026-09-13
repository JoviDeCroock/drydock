import type { NpmStagedDetails } from "./staged-publishes";
import type { PackageAdapter } from "../package-adapter";
import { acquireBaselineNpm, acquireStagedNpm, type NpmAdapterInput } from "./acquire";
import { createNpmBroker, type NpmBroker } from "./broker";
import { buildNpmFindings } from "./findings";
import { lookupStagedReleaseFate } from "./release-outcome";
import { isTerminalNpmVersionStatus } from "./version-status";

const STAGE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{5,160}$/;

export const npmAdapter: PackageAdapter<NpmAdapterInput, NpmBroker> = {
  id: "npm",
  // Detection scans every file of an npm package with the JavaScript set, so
  // diff annotation must re-match findings with it too. Left undefined,
  // annotation falls back to Python patterns for a `.py` file (a node-gyp
  // script), which is not the set that produced the finding.
  codePatternSet: "javascript",

  parseInput(raw: unknown): NpmAdapterInput {
    if (!raw || typeof raw !== "object") {
      throw new Error("npm adapter input must be an object with a stageId");
    }
    const value = raw as Record<string, unknown>;
    const stageId = typeof value.stageId === "string" ? value.stageId.trim() : "";
    if (!STAGE_ID_RE.test(stageId)) {
      throw new Error("invalid stageId");
    }
    const maxFiles = typeof value.maxFiles === "number" ? value.maxFiles : undefined;
    return { stageId, maxFiles };
  },

  createBroker(ctx, ref) {
    return createNpmBroker(ctx, ref);
  },

  acquireStaged(ctx, input, broker) {
    return acquireStagedNpm(ctx, input, broker);
  },

  acquireBaseline(ctx, input, broker, staged) {
    return acquireBaselineNpm(ctx, input, broker, staged);
  },

  runFindings(args) {
    return buildNpmFindings({
      staged: args.staged,
      previousFiles: args.baseline?.files,
      details: args.details as NpmStagedDetails | null,
      fileDiff: args.fileDiff,
      manifestDiff: args.manifestDiff,
      stagedManifestText: args.stagedManifestText,
    });
  },

  describe({ staged, details, previous }) {
    const stagedDetails = details as NpmStagedDetails | null;
    return {
      name: staged.manifest?.name ?? null,
      stagedVersion: staged.manifest?.version ?? null,
      stagedTag: stagedDetails?.tag ?? null,
      previousVersion: previous?.manifest?.version ?? null,
    };
  },

  summarizeDetails(details) {
    if (!details) return null;
    const d = details as NpmStagedDetails;
    return {
      id: d.id,
      packageName: d.packageName,
      version: d.version,
      tag: d.tag,
      access: d.access,
      actor: d.actor,
      actorType: d.actorType,
      createdAt: d.createdAt,
      shasum: d.shasum,
      // Byte-verification verdict for the reviewed artifact. Persisted with the
      // report so a reviewer reading "file removed" months later can tell
      // whether the scan proved it was reading the staged bytes.
      artifactIntegrity: d.artifactIntegrity ?? null,
      artifactSha256: d.artifactSha256 ?? null,
    };
  },

  stagedArtifactSha256(details) {
    const d = details as NpmStagedDetails | null;
    return d?.artifactSha256 ?? null;
  },

  registryReleaseIdentity(details) {
    const d = details as NpmStagedDetails | null;
    return d?.packageName && d.version ? { packageName: d.packageName, version: d.version } : null;
  },

  // Only an unreadable staged tarball has a registry-side explanation: npm may
  // have published, deleted, or blocked the version since the scan was queued.
  async refineAcquisitionFailure(ctx, failure) {
    if (failure.code !== "staged_tarball_unavailable") return null;
    const fate = await lookupStagedReleaseFate(ctx.env, ctx.db, ctx.scanId, ctx.organizationId);
    if (!fate) return null;
    return {
      failure: fate.failure,
      registryStatus: fate.status,
      registryStatusTerminal: isTerminalNpmVersionStatus(fate.status),
    };
  },
};

export type { NpmAdapterInput, NpmBroker };
export { NpmAdapterBroker } from "./broker";
