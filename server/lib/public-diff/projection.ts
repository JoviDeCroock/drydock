import { extractDeclaredRepository, normalizeRepositoryUrl } from "../intent-envelope";
import {
  diffCapabilities,
  projectCapabilities,
  type CapabilityDelta,
  type CodePatternSet,
} from "../review";
import type { PublicDiffAcquiredSide, PublicDiffAcquiredSources } from "./types";

export function projectPublicDiffCapabilities(
  sources: Pick<PublicDiffAcquiredSources, "from" | "to">,
  codePatternSet?: CodePatternSet,
): CapabilityDelta {
  const projectSide = (side: PublicDiffAcquiredSide) => {
    const projected = projectCapabilities(side.files, side.packageJson, codePatternSet);
    return side.capabilityCoverageComplete === false
      ? { ...projected, complete: false }
      : projected;
  };
  return diffCapabilities(
    sources.from.comparable === false ? null : projectSide(sources.from),
    projectSide(sources.to),
  );
}

export function projectPublicDiffSourceBinding(
  fromSide: PublicDiffAcquiredSide,
  toSide: PublicDiffAcquiredSide,
) {
  const from = declaredSideRepository(fromSide);
  const to = declaredSideRepository(toSide);
  return { from, to, changed: from !== to };
}

// Declared-tier source binding for one side: the repository the package's own
// manifest (or PyPI core metadata) claims, normalized to a bounded canonical
// URL. Read off the raw acquired files — the sample-retention pass may later
// drop the manifest's text from the cached payload, so this cannot be
// projected on demand.
function declaredSideRepository(side: PublicDiffAcquiredSide): string | null {
  const manifestText = side.files.find((file) => file.path === "package.json")?.textSample ?? null;
  return normalizeRepositoryUrl(extractDeclaredRepository({ manifestText, files: side.files }));
}
