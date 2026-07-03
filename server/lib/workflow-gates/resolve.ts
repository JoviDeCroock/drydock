import { type ResolvedReleaseBundle, WorkflowArtifactError } from "../github-app/artifacts";
import { downloadInSandboxInline } from "../sandbox";
import { AMBIGUOUS_ARCHIVE_ECOSYSTEM, detectArchiveEcosystems } from "./registry";
import type { ParsedGateArtifact } from "./types";

const GATE_ARTIFACT_PARSE_CONCURRENCY = 4;

/**
 * Parse every verified bundle artifact once in the credentials-free sandbox and
 * resolve each one's ecosystem.
 *
 * Parsing is shared across ecosystems: npm tarballs and PyPI sdists are both
 * gzip-compressed tarballs, wheels are zips, and the same tar/zip reader handles
 * all of them. An entry the auto-detect classifier could not disambiguate by
 * extension (tagged `AMBIGUOUS_ARCHIVE_ECOSYSTEM`) is routed by content here —
 * npm if the archive carries a root `package.json`, PyPI if it carries a
 * `PKG-INFO`. An archive no ecosystem recognizes fails the gate closed.
 *
 * Trust boundary: the installation token is already gone. `bundle` holds only
 * artifact bytes whose SHA-256 the control plane recomputed; the sandbox is
 * constructed with no credentials, so even a compromised parser cannot exfil a
 * token (there is none in scope).
 */
export async function resolveBundleArtifacts(
  env: Cloudflare.Env,
  ctx: ExecutionContext,
  bundle: ResolvedReleaseBundle,
): Promise<ParsedGateArtifact[]> {
  return mapWithConcurrency(bundle.artifacts, GATE_ARTIFACT_PARSE_CONCURRENCY, async (file) => {
    const lowerPath = file.path.toLowerCase();
    // Wheels stream through the zip reader; VSIX archives are yazl-packed
    // with data-descriptor entries and must take the buffered CD-first path.
    // Go modules ship as .zip and take the same zip reader.
    const format = lowerPath.endsWith(".vsix")
      ? "vsix"
      : lowerPath.endsWith(".whl") || lowerPath.endsWith(".zip")
        ? "zip"
        : "tgz";
    const parsed = await downloadInSandboxInline(env, ctx, { bytes: file.bytes, format });
    const contents = { files: parsed.files, packageJson: parsed.packageJson ?? null };

    let ecosystem = file.ecosystem;
    let kind = file.kind;
    if (ecosystem === AMBIGUOUS_ARCHIVE_ECOSYSTEM) {
      const claims = detectArchiveEcosystems(contents);
      if (claims.length === 0) {
        throw new WorkflowArtifactError(
          "artifact_identity_missing",
          `${file.path} is not a release artifact any registered ecosystem recognizes`,
        );
      }
      if (claims.length > 1) {
        // The archive presents as several ecosystems (e.g. an npm tarball that
        // also ships a root PKG-INFO). Routing it to one would skip the other's
        // findings, so fail closed and let the maintainer pin the ecosystem.
        throw new WorkflowArtifactError(
          "artifact_identity_inconsistent",
          `${file.path} matches more than one ecosystem (${claims
            .map((claim) => claim.ecosystem)
            .join(", ")}); pin the release target's ecosystem to review it`,
        );
      }
      ecosystem = claims[0].ecosystem;
      kind = claims[0].kind;
    }

    return {
      path: file.path,
      sha256: file.sha256,
      ecosystem,
      kind,
      files: parsed.files,
      packageJson: parsed.packageJson ?? null,
      ...(parsed.suspiciousEntries ? { suspiciousEntries: parsed.suspiciousEntries } : {}),
    };
  });
}

async function mapWithConcurrency<T, U>(
  items: T[],
  concurrency: number,
  worker: (item: T) => Promise<U>,
): Promise<U[]> {
  const results = new Map<number, U>();
  let next = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    for (;;) {
      const index = next;
      next += 1;
      if (index >= items.length) return;
      results.set(index, await worker(items[index]));
    }
  });
  await Promise.all(workers);
  return items.map((_, index) => results.get(index)!);
}
