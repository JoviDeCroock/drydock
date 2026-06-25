const NPM_WEB_ORIGIN = "https://www.npmjs.com";

export type NpmStagedConnection = {
  capabilities?: unknown;
  capabilitiesJson?: unknown;
} | null;

export type NpmStagedScan = {
  source?: string | null;
  packageName?: string | null;
};

export function buildNpmStagedPackagesUrl(username: string | null | undefined): string | null {
  const normalized = username?.trim();
  if (!normalized) return null;
  return `${NPM_WEB_ORIGIN}/settings/${encodeURIComponent(normalized)}/staged-packages`;
}

export function npmStagedPackagesUrlFor(
  scan: NpmStagedScan,
  connection: NpmStagedConnection,
): string | null {
  if (scan.source === "workflow_gate" || !scan.packageName) return null;
  return buildNpmStagedPackagesUrl(readWhoami(connection));
}

function readWhoami(connection: NpmStagedConnection): string | null {
  const capabilities = connection?.capabilitiesJson ?? connection?.capabilities;
  if (!capabilities || typeof capabilities !== "object") return null;
  const { whoami } = capabilities as { whoami?: unknown };
  return typeof whoami === "string" ? whoami : null;
}
import type { PublicNpmConnection } from "../models/npm-connection";

type NpmStageConnection = Pick<PublicNpmConnection, "registryUrl" | "capabilitiesJson">;

export function npmStagedPackagesUrl(
  packageName: string | null | undefined,
  connection: NpmStageConnection | null | undefined,
): string | null {
  if (!connection || !isNpmjsRegistry(connection.registryUrl)) return null;
  const account = npmStagedPackagesAccount(packageName, connection.capabilitiesJson);
  if (!account) return null;
  return `https://www.npmjs.com/settings/${encodeURIComponent(account)}/staged-packages`;
}

export function npmStagedPackagesAccount(
  packageName: string | null | undefined,
  capabilitiesJson: unknown,
): string | null {
  return packageScope(packageName) ?? npmWhoami(capabilitiesJson);
}

function packageScope(packageName: string | null | undefined): string | null {
  if (!packageName?.startsWith("@")) return null;
  const slash = packageName.indexOf("/");
  if (slash <= 1) return null;
  const scope = packageName.slice(1, slash).trim();
  return scope || null;
}

function npmWhoami(capabilitiesJson: unknown): string | null {
  if (!capabilitiesJson || typeof capabilitiesJson !== "object") return null;
  const whoami = (capabilitiesJson as { whoami?: unknown }).whoami;
  if (typeof whoami !== "string") return null;
  const trimmed = whoami.trim();
  return trimmed || null;
}

function isNpmjsRegistry(registryUrl: string): boolean {
  try {
    const hostname = new URL(registryUrl).hostname.toLowerCase();
    return hostname === "registry.npmjs.org";
  } catch {
    return false;
  }
}
