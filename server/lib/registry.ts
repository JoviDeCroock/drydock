export interface RegistryMetadata {
  versions?: Record<string, { dist?: { tarball?: string } }>;
  "dist-tags"?: Record<string, string>;
  time?: Record<string, string>;
}

const NPM_PACKAGE_NAME_RE = /^(?:@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*$/;

export function isValidNpmPackageName(name: string): boolean {
  if (typeof name !== "string") return false;
  if (name.length === 0 || name.length > 214) return false;
  return NPM_PACKAGE_NAME_RE.test(name);
}

export async function fetchPackageMetadata(
  env: Cloudflare.Env,
  name: string,
  options: { npmToken?: string; npmRegistry?: string } = {},
): Promise<RegistryMetadata> {
  if (!isValidNpmPackageName(name)) {
    throw new Error("invalid package name");
  }
  const registry = (
    options.npmRegistry ||
    env.NPM_REGISTRY ||
    "https://registry.npmjs.org"
  ).replace(/\/$/, "");
  const headers = new Headers({ accept: "application/json" });
  if (options.npmToken) headers.set("authorization", `Bearer ${options.npmToken}`);
  const res = await fetch(`${registry}/${encodeURIComponent(name).replace(/^%40/, "@")}`, {
    headers,
  });
  if (!res.ok) throw new Error(`metadata fetch failed: ${res.status}`);
  return (await res.json()) as RegistryMetadata;
}

export function pickPreviousVersion(
  metadata: { versions?: Record<string, unknown> },
  stagedVersion: string,
) {
  const versions = Object.keys(metadata.versions || {}).filter(
    (version) => version !== stagedVersion && /^\d+\.\d+\.\d+/.test(version),
  );
  versions.sort(compareSemver);
  return versions.at(-1) || null;
}

export function compareSemver(a: string, b: string) {
  const pa = a.split(/[.-]/).map((part) => Number(part) || 0);
  const pb = b.split(/[.-]/).map((part) => Number(part) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const diff = (pa[i] || 0) - (pb[i] || 0);
    if (diff) return diff;
  }
  return 0;
}
