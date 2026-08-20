import type { FileRecord, PackageJsonSummary } from "../../review";
import type { TarSuspiciousEntry } from "../../tar-parser.js";
import type {
  AcquiredArtifact,
  AdapterContext,
  PackageAdapter,
  ReleaseProvenance,
  StagedDetails,
} from "../package-adapter";
import { acquireBaselineNpm } from "./acquire";
import { createNpmBroker, type NpmBroker } from "./broker";
import { buildNpmFindings } from "./findings";
import {
  buildNpmReleaseManifest,
  isRecord,
  parseNpmReleaseManifest,
  type NpmReleaseManifest,
} from "./manifest";

/**
 * One npm tarball that the shared workflow-gate router already downloaded,
 * digested, and parsed in the credentials-free sandbox. `files`/`packageJson`
 * are the parsed contents; `sha256` is the reviewed tarball digest.
 */
interface NpmGateArtifactInput {
  path: string;
  sha256: string;
  files: FileRecord[];
  packageJson: PackageJsonSummary | null;
  suspiciousEntries?: TarSuspiciousEntry[];
}

export interface NpmGateAdapterInput {
  manifest: NpmReleaseManifest;
  artifact: NpmGateArtifactInput;
  maxFiles?: number;
}

/** Persisted, opaque snapshot of the reviewed artifact for the report/UI. */
export interface NpmGateDetails {
  mode: "workflow_gate";
  manifest: NpmReleaseManifest;
  /** SHA-256 of the reviewed `.tgz`, recomputed from the immutable artifact. */
  digest: string;
}

/**
 * npm workflow-gate review adapter.
 *
 * Distinct from the staged-publish `npmAdapter` (which downloads from the npm
 * staging registry by `stageId`), this adapter reviews a tarball that arrived as
 * an immutable GitHub Actions artifact: the bytes are already parsed, so
 * `acquireStaged` is a synchronous reassembly with no broker or sandbox call.
 * Everything downstream is shared with the staged adapter — baseline selection
 * (`acquireBaselineNpm`, through the org npm connection), deterministic findings
 * (`buildNpmFindings`), the package diff, and the risk model — so npm review
 * behaves identically whether it arrives via staged publish or workflow gate.
 */
export const npmGateAdapter: PackageAdapter<NpmGateAdapterInput, NpmBroker> = {
  id: "npm",

  // Candidates arrive as GitHub Actions artifacts; only the published npm
  // baseline is fetched, and that needs no credential.
  requiresConnection: false,

  parseInput(raw: unknown): NpmGateAdapterInput {
    if (!isRecord(raw)) throw new Error("npm gate adapter input must be an object");
    const manifest = parseNpmReleaseManifest(raw.manifest);
    const artifact = parseGateArtifact(raw.artifact);
    return {
      manifest,
      artifact,
      ...(typeof raw.maxFiles === "number" ? { maxFiles: raw.maxFiles } : {}),
    };
  },

  createBroker(ctx, ref) {
    return createNpmBroker(ctx, ref);
  },

  acquireStaged(
    _ctx: AdapterContext,
    input: NpmGateAdapterInput,
    _broker: NpmBroker,
  ): Promise<{ artifact: AcquiredArtifact; details: StagedDetails }> {
    // The bytes were already parsed by the shared router; the manifest carries
    // the reviewed digest. There is no staged-registry metadata to merge.
    return Promise.resolve({
      artifact: {
        files: input.artifact.files,
        manifest: input.artifact.packageJson,
        ...(input.artifact.suspiciousEntries
          ? { suspiciousTarEntries: input.artifact.suspiciousEntries }
          : {}),
      },
      details: {
        mode: "workflow_gate",
        manifest: input.manifest,
        digest: input.artifact.sha256,
      } satisfies NpmGateDetails,
    });
  },

  async acquireBaseline(ctx, input, broker, staged) {
    try {
      return await acquireBaselineNpm(ctx, { maxFiles: input.maxFiles }, broker, staged);
    } catch {
      // The baseline is a best-effort diff aid, not a security control. Unlike a
      // staged publish, a workflow gate does not require an org npm token, so a
      // missing/invalid connection (or a transient registry error) must degrade
      // to a full-tree review — every file reads as added, which is the more
      // conservative outcome — rather than fail the gate closed.
      return {
        artifact: null,
        baseline: {
          version: null,
          tag: null,
          source: "none",
          distTagVersion: null,
          reason: "baseline-unavailable",
        },
      };
    }
  },

  runFindings(args) {
    // No staged-registry metadata exists for a gated publish, so there is no
    // metadata-vs-tarball mismatch rule to run; `details: null` skips it.
    return buildNpmFindings({
      staged: args.staged,
      details: null,
      fileDiff: args.fileDiff,
      manifestDiff: args.manifestDiff,
      stagedManifestText: args.stagedManifestText,
    });
  },

  describe({ staged, details, previous }) {
    const d = details as NpmGateDetails;
    return {
      name: staged.manifest?.name ?? d.manifest.package,
      stagedVersion: staged.manifest?.version ?? d.manifest.version,
      stagedTag: null,
      previousVersion: previous?.manifest?.version ?? null,
    };
  },

  summarizeDetails(details) {
    const d = details as NpmGateDetails;
    return {
      mode: d.mode,
      ecosystem: "npm",
      digest: d.digest,
      manifest: d.manifest,
      provenance: {
        ecosystem: "npm",
        mode: d.mode,
        // An npm release version is exactly one tarball; the recomputed digest
        // is the bytes the publish job downloads and runs `npm publish` on.
        artifacts: d.manifest.artifacts.map((artifact) => ({
          path: artifact.path,
          kind: "tarball" as const,
          sha256: artifact.sha256,
        })),
      } satisfies ReleaseProvenance,
    };
  },
};

function parseGateArtifact(raw: unknown): NpmGateArtifactInput {
  if (!isRecord(raw)) throw new Error("npm gate adapter input must include an artifact");
  const path = typeof raw.path === "string" ? raw.path : "";
  if (!path) throw new Error("npm gate artifact path is required");
  const sha256 = typeof raw.sha256 === "string" ? raw.sha256 : "";
  if (!/^[a-f0-9]{64}$/i.test(sha256)) throw new Error("npm gate artifact sha256 is invalid");
  if (!Array.isArray(raw.files)) throw new Error("npm gate artifact files must be an array");
  const packageJson = isRecord(raw.packageJson) ? (raw.packageJson as PackageJsonSummary) : null;
  return {
    path,
    sha256: sha256.toLowerCase(),
    files: raw.files as FileRecord[],
    packageJson,
    ...(Array.isArray(raw.suspiciousEntries)
      ? { suspiciousEntries: raw.suspiciousEntries as TarSuspiciousEntry[] }
      : {}),
  };
}
export { buildNpmReleaseManifest };
