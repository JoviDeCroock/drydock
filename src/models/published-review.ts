import { signal, createModel } from "@preact/signals";
import { errorMessage } from "./api";
import { getPublicDiffVersions } from "./package-diff";
import { createPublishedScan } from "./scan-api";
import type { DiffEcosystem } from "../lib/package-diff-path";

export interface PackageSpec {
  packageName: string;
  version: string | null;
}

/**
 * Split `name@version` without breaking a scoped name.
 *
 * A leading `@` is part of the scope, so the separator is the last `@` after
 * index 0. A bare name is legal and means "the latest published version",
 * which `startPublishedReview` resolves.
 */
export function parsePackageSpec(raw: string): PackageSpec | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const separator = trimmed.lastIndexOf("@");
  if (separator <= 0) return { packageName: trimmed, version: null };
  const packageName = trimmed.slice(0, separator).trim();
  const version = trimmed.slice(separator + 1).trim();
  if (!packageName) return null;
  return { packageName, version: version || null };
}

/**
 * Start a review of an already-published release and hand back its scan id.
 *
 * This is the account's first-value path: it needs no registry credential and
 * no staged release, so it works from the moment an organization exists. The
 * caller navigates to the scan detail page, which polls the same way a staged
 * scan does.
 */
export const PublishedReviewModel = createModel(() => {
  const busy = signal(false);
  const error = signal<string | null>(null);

  return {
    busy,
    error,

    async start(
      ecosystem: DiffEcosystem,
      input: { packageName: string; version: string | null; baselineVersion?: string },
    ): Promise<string | null> {
      if (this.busy.peek()) return null;
      this.busy.value = true;
      this.error.value = null;
      try {
        const version =
          input.version ?? (await latestPublishedVersion(ecosystem, input.packageName));
        if (!version) {
          this.error.value = "This package has no published version to review.";
          return null;
        }
        const created = await createPublishedScan({
          ecosystem,
          packageName: input.packageName,
          version,
          ...(input.baselineVersion ? { baselineVersion: input.baselineVersion } : {}),
        });
        return created.scan.id;
      } catch (err) {
        this.error.value = errorMessage(err);
        return null;
      } finally {
        this.busy.value = false;
      }
    },
  };
});

// The anonymous version listing already backs the /diff landing form, so a bare
// package name resolves the same way in both places.
async function latestPublishedVersion(
  ecosystem: DiffEcosystem,
  packageName: string,
): Promise<string | null> {
  const listing = await getPublicDiffVersions(ecosystem, packageName);
  return listing.suggested?.to ?? listing.versions[0]?.version ?? null;
}
