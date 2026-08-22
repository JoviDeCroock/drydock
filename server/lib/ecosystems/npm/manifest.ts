/**
 * npm workflow-gate release manifest.
 *
 * Like the PyPI gate, the manifest is **synthesized server-side** from the
 * parsed `package.json` plus the SHA-256 the control plane recomputed from the
 * immutable GitHub Actions artifact bytes — maintainers do not upload a manifest
 * or checksum file (see the example workflow in `docs/npm-workflow-gate.md`).
 * Integrity rests on GitHub artifact immutability: the bytes Drydock reviews are
 * the bytes the publish job downloads and runs `npm publish` on.
 *
 * The shape is shared with PyPI (`drydock.release-artifacts.v1`) so the report
 * and UI can render a digest + package/version uniformly across ecosystems.
 */
import { isRecord } from "../../platform/guards";
import { isSafeManifestPath } from "../../platform/path-safety";
export const NPM_RELEASE_MANIFEST_SCHEMA = "drydock.release-artifacts.v1";

// npm versions are semver; keep the charset tight so a hostile version string
// cannot smuggle path or control characters into report/UI surfaces.
const SAFE_VERSION_RE = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,127}$/;
// npm only enforces lowercase for *new* names; legacy packages (e.g. `JSONStream`)
// keep uppercase names and still publish, so the registration-time validator
// (`isValidNpmPackageName`) would fail their gate closed. Accept any name the
// registry still serves while blocking the path/control characters that could
// poison report/UI surfaces — the same concern the version charset guards against.
const SAFE_PACKAGE_NAME_RE = /^(?:@[A-Za-z0-9][A-Za-z0-9._~-]*\/)?[A-Za-z0-9][A-Za-z0-9._~-]*$/;
const SHA256_RE = /^[a-f0-9]{64}$/i;
// A single npm package version is exactly one tarball; keep a small bound to
// guard against a degenerate group somehow accumulating many artifacts.
const NPM_ARTIFACT_LIMIT = 4;

export interface NpmReleaseManifestArtifact {
  path: string;
  sha256: string;
}

export interface NpmReleaseManifest {
  schema: typeof NPM_RELEASE_MANIFEST_SCHEMA;
  ecosystem: "npm";
  package: string;
  version: string;
  artifacts: NpmReleaseManifestArtifact[];
}

/** Synthesize + validate a manifest from a package's resolved identity + artifacts. */
export function buildNpmReleaseManifest(
  name: string,
  version: string,
  artifacts: NpmReleaseManifestArtifact[],
): NpmReleaseManifest {
  return parseNpmReleaseManifest({
    schema: NPM_RELEASE_MANIFEST_SCHEMA,
    ecosystem: "npm",
    package: name,
    version,
    artifacts,
  });
}

export function parseNpmReleaseManifest(value: unknown): NpmReleaseManifest {
  if (!isRecord(value)) throw new Error("manifest must be an object");
  if (value.schema !== NPM_RELEASE_MANIFEST_SCHEMA) {
    throw new Error(`manifest schema must be ${NPM_RELEASE_MANIFEST_SCHEMA}`);
  }
  if (value.ecosystem !== "npm") throw new Error("manifest ecosystem must be npm");
  const packageName = String(value.package || "");
  const version = String(value.version || "");
  if (!isSafeManifestPackageName(packageName)) {
    throw new Error("manifest package is not a valid npm package name");
  }
  if (!SAFE_VERSION_RE.test(version)) {
    throw new Error("manifest version is not a safe npm version string");
  }
  if (!Array.isArray(value.artifacts) || !value.artifacts.length) {
    throw new Error("manifest must include at least one artifact");
  }
  if (value.artifacts.length > NPM_ARTIFACT_LIMIT) {
    throw new Error(`manifest must include no more than ${NPM_ARTIFACT_LIMIT} artifacts`);
  }

  const artifacts = value.artifacts.map((artifact, index) => {
    if (!isRecord(artifact)) throw new Error(`artifact ${index + 1} must be an object`);
    const path = String(artifact.path || "");
    if (!isSafeManifestPath(path)) throw new Error(`artifact ${index + 1} path is not safe`);
    const sha256 = String(artifact.sha256 || "");
    if (!SHA256_RE.test(sha256)) {
      throw new Error(`artifact ${index + 1} sha256 must be a hex SHA-256 digest`);
    }
    return { path, sha256: sha256.toLowerCase() };
  });

  return {
    schema: NPM_RELEASE_MANIFEST_SCHEMA,
    ecosystem: "npm",
    package: packageName,
    version,
    artifacts,
  };
}

function isSafeManifestPackageName(name: string): boolean {
  return name.length >= 1 && name.length <= 214 && SAFE_PACKAGE_NAME_RE.test(name);
}
