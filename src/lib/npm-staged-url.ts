const NPM_WEB_ORIGIN = "https://www.npmjs.com";

export type NpmStagedConnection = {
  registryUrl?: string | null;
  capabilities?: unknown;
  capabilitiesJson?: unknown;
} | null;

export type NpmStagedScan = {
  source?: string | null;
  packageName?: string | null;
};

export function buildNpmStagedPackagesUrl(account: string | null | undefined): string | null {
  const normalized = account?.trim();
  if (!normalized) return null;
  return `${NPM_WEB_ORIGIN}/settings/${encodeURIComponent(normalized)}/staged-packages`;
}

export function npmStagedPackagesUrlFor(
  scan: NpmStagedScan,
  connection: NpmStagedConnection,
): string | null {
  if (scan.source === "workflow_gate" || !scan.packageName) return null;
  if (connection?.registryUrl && !isNpmjsRegistry(connection.registryUrl)) return null;
  return buildNpmStagedPackagesUrl(packageScope(scan.packageName) ?? readWhoami(connection));
}

function packageScope(packageName: string): string | null {
  if (!packageName.startsWith("@")) return null;
  const slash = packageName.indexOf("/");
  if (slash <= 1) return null;
  return packageName.slice(1, slash).trim() || null;
}

function readWhoami(connection: NpmStagedConnection): string | null {
  const capabilities = connection?.capabilitiesJson ?? connection?.capabilities;
  if (!hasWhoami(capabilities) || typeof capabilities.whoami !== "string") return null;
  return capabilities.whoami;
}

function hasWhoami(value: unknown): value is { whoami?: unknown } {
  return value !== null && typeof value === "object" && "whoami" in value;
}

function isNpmjsRegistry(registryUrl: string): boolean {
  try {
    return new URL(registryUrl).hostname.toLowerCase() === "registry.npmjs.org";
  } catch {
    return false;
  }
}
