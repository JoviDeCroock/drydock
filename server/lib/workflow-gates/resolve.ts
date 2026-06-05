import { type ResolvedReleaseBundle, WorkflowArtifactError } from "../github-app";
import { downloadInSandboxInline } from "../sandbox";
import { AMBIGUOUS_ARCHIVE_ECOSYSTEM, detectArchiveEcosystem } from "./registry";
import type { ParsedGateArtifact } from "./types";

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
  const resolved: ParsedGateArtifact[] = [];
  for (const file of bundle.artifacts) {
    const format = file.path.toLowerCase().endsWith(".whl") ? "zip" : "tgz";
    const parsed = await downloadInSandboxInline(env, ctx, { bytes: file.bytes, format });
    const contents = { files: parsed.files, packageJson: parsed.packageJson ?? null };

    let ecosystem = file.ecosystem;
    let kind = file.kind;
    if (ecosystem === AMBIGUOUS_ARCHIVE_ECOSYSTEM) {
      const detected = detectArchiveEcosystem(contents);
      if (!detected) {
        throw new WorkflowArtifactError(
          "artifact_identity_missing",
          `${file.path} is not a recognizable npm or PyPI release artifact`,
        );
      }
      ecosystem = detected.ecosystem;
      kind = detected.kind;
    }

    resolved.push({
      path: file.path,
      sha256: file.sha256,
      ecosystem,
      kind,
      files: parsed.files,
      packageJson: parsed.packageJson ?? null,
      ...(parsed.suspiciousEntries ? { suspiciousEntries: parsed.suspiciousEntries } : {}),
    });
  }
  return resolved;
}
