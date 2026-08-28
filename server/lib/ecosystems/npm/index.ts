import type { NpmStagedDetails } from "./staged-publishes";
import type { PackageAdapter } from "../package-adapter";
import { acquireBaselineNpm, acquireStagedNpm, type NpmAdapterInput } from "./acquire";
import { createNpmBroker, type NpmBroker } from "./broker";
import {
  inspectAddedNpmDependenciesForAdapter,
  inspectBundledNpmDependenciesForAdapter,
} from "./dependency-artifacts";
import { buildNpmFindings } from "./findings";

const STAGE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{5,160}$/;

export const npmAdapter: PackageAdapter<NpmAdapterInput, NpmBroker> = {
  id: "npm",

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

  inspectAddedDependencies(ctx, args) {
    return inspectAddedNpmDependenciesForAdapter(ctx, args);
  },

  inspectEmbeddedAddedDependencies(args) {
    return inspectBundledNpmDependenciesForAdapter(args);
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
    };
  },

  registryReleaseIdentity(details) {
    const d = details as NpmStagedDetails | null;
    return d?.packageName && d.version ? { packageName: d.packageName, version: d.version } : null;
  },
};

export type { NpmAdapterInput, NpmBroker };
export { NpmAdapterBroker } from "./broker";
