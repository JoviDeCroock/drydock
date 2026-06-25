const NPM_WEB_ORIGIN = "https://www.npmjs.com";

export type NpmStagedScan = {
  source?: string | null;
  packageName?: string | null;
};

export function buildNpmStagedPackagesUrl(packageName: string | null | undefined): string | null {
  const normalized = packageName?.trim();
  if (!normalized) return null;

  const url = new URL("/settings/~/staged-packages/", NPM_WEB_ORIGIN);
  url.searchParams.set("page", "0");
  url.searchParams.set("perPage", "10");
  url.searchParams.set("filterPackage", normalized);
  return url.toString();
}

export function npmStagedPackagesUrlFor(scan: NpmStagedScan): string | null {
  if (scan.source === "workflow_gate" || !scan.packageName) return null;
  return buildNpmStagedPackagesUrl(scan.packageName);
}
