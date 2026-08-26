import { isRecord } from "../platform/guards";
import { isEcosystemId } from "./labels";
import type { ReleaseProvenance, ReleaseProvenanceArtifact } from "./package-adapter";

/** Re-validate the adapter snapshot before it becomes registry authority. */
export function extractReleaseProvenance(stagedPublish: unknown): ReleaseProvenance | null {
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
    if (
      typeof path !== "string" ||
      !path ||
      typeof sha256 !== "string" ||
      !/^[a-f0-9]{64}$/i.test(sha256)
    ) {
      return null;
    }
    if (kind === "tarball" || kind === "wheel" || kind === "sdist" || kind === "vsix") {
      mapped.push({ path, kind, sha256: sha256.toLowerCase() });
      continue;
    }
    return null;
  }
  if (!mapped.length) return null;
  return { ecosystem, mode, artifacts: mapped };
}
