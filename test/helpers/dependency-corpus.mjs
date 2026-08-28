import {
  dependencyDeclarationKey,
  dependencyScanFindings,
  parseVersionSpec,
  selectAddedDependencyDeclarations,
} from "../../server/lib/review";

export function dependencyCorpusFindings(fixture, packageJsonDiff) {
  if (!fixture.dependencyArtifacts) return [];
  const selected = selectAddedDependencyDeclarations(packageJsonDiff);
  const selectedNames = new Set(selected.map((entry) => entry.name));
  const suppliedNames = Object.keys(fixture.dependencyArtifacts ?? {});
  for (const name of suppliedNames) {
    if (!selectedNames.has(name)) {
      throw new Error(`${fixture.id}: dependencyArtifacts.${name} is not a gated added dependency`);
    }
  }

  const artifacts = Object.fromEntries(
    selected.flatMap((dependency) => {
      const configured = fixture.dependencyArtifacts?.[dependency.name];
      const candidates = Array.isArray(configured) ? configured : [configured];
      const supplied = candidates.find(
        (candidate) =>
          candidate &&
          (candidate.section === undefined || candidate.section === dependency.section) &&
          (candidate.declaredSpec === undefined ||
            candidate.declaredSpec === dependency.declaredSpec),
      );
      if (!supplied) return [];
      const resolutionKind = parseVersionSpec(
        supplied.declaredSpec ?? dependency.declaredSpec,
      ).kind;
      const version = supplied.resolvedVersion ?? null;
      const outcome = supplied.outcome ?? "inspected";
      const path = `${fixture.stagedPackageJson?.name ?? "parent"}@${fixture.stagedPackageJson?.version ?? "unknown"} → ${dependency.name}@${version ?? "unresolved"}`;
      return [
        [
          dependencyDeclarationKey(
            dependency.name,
            dependency.section,
            supplied.declaredSpec ?? dependency.declaredSpec,
          ),
          {
            name: dependency.name,
            section: dependency.section,
            declaredSpec: supplied.declaredSpec ?? dependency.declaredSpec,
            path,
            outcome,
            outcomeDetail: supplied.outcomeDetail ?? outcome,
            resolution:
              version && outcome !== "unresolved-spec" && outcome !== "not-found"
                ? {
                    kind:
                      resolutionKind === "dist-tag"
                        ? "dist-tag"
                        : resolutionKind === "exact"
                          ? "exact"
                          : "range",
                    version,
                    tarballUrl: `https://registry.npmjs.org/${dependency.name}/-/${dependency.name}-${version}.tgz`,
                    registryIntegrity: null,
                    resolvedAt: "2026-08-28T00:00:00.000Z",
                  }
                : null,
            artifact:
              outcome === "inspected"
                ? {
                    sha256: "fixture-sha256",
                    sha512: "fixture-sha512",
                    fileCount: supplied.files?.length ?? 0,
                    totalBytes: (supplied.files ?? []).reduce((sum, file) => sum + file.size, 0),
                    integrityMatched: null,
                  }
                : null,
            entrypoints:
              outcome === "inspected"
                ? {
                    lifecycleScripts: Object.keys(supplied.packageJson?.scripts ?? {}),
                    hasInstallLifecycle: Object.keys(supplied.packageJson?.scripts ?? {}).some(
                      (name) => ["preinstall", "install", "postinstall"].includes(name),
                    ),
                    gypfile: Boolean(supplied.packageJson?.gypfile),
                    binCount:
                      typeof supplied.packageJson?.bin === "string"
                        ? 1
                        : Object.keys(supplied.packageJson?.bin ?? {}).length,
                  }
                : null,
            findingCount: 0,
            files: supplied.files ?? [],
            packageJson: supplied.packageJson ?? null,
          },
        ],
      ];
    }),
  );
  return dependencyScanFindings(selected, artifacts, {
    name: fixture.stagedPackageJson?.name ?? null,
    version: fixture.stagedPackageJson?.version ?? null,
  });
}
