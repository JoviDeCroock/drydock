const NPM_WEB_ORIGIN = "https://www.npmjs.com";
const PUBLIC_NPM_REGISTRY_URL = "https://registry.npmjs.org";

export type NpmStagedScan = {
  source?: string | null;
  packageName?: string | null;
  registryUrl?: string | null;
  registryStatusSupersededAt?: string | number | Date | null;
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
  if (
    scan.source === "workflow_gate" ||
    !scan.packageName ||
    scan.registryStatusSupersededAt != null ||
    !usesPublicNpmRegistry(scan.registryUrl)
  ) {
    return null;
  }
  return buildNpmStagedPackagesUrl(scan.packageName);
}

function usesPublicNpmRegistry(value: string | null | undefined): boolean {
  if (!value) return true;
  try {
    const url = new URL(value);
    return (
      url.origin === PUBLIC_NPM_REGISTRY_URL &&
      (url.pathname === "/" || url.pathname === "") &&
      !url.username &&
      !url.password
    );
  } catch {
    return false;
  }
}
