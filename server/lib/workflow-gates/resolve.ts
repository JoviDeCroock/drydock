import { mapWithConcurrency } from "../platform/concurrency";
import {
  type ResolvedReleaseBundle,
  type ResolvedReleaseFile,
  WorkflowArtifactError,
} from "../github-app/artifacts";
import { downloadInSandboxInline } from "../sandbox";
import { AMBIGUOUS_ARCHIVE_ECOSYSTEM, detectArchiveEcosystems, getEcosystem } from "../ecosystems";
import type { ParsedGateArtifact } from "./types";

const GATE_ARTIFACT_PARSE_CONCURRENCY = 4;

export async function resolveBundleArtifacts(
  env: Cloudflare.Env,
  ctx: ExecutionContext,
  bundle: ResolvedReleaseBundle,
): Promise<ParsedGateArtifact[]> {
  return mapWithConcurrency(bundle.artifacts, GATE_ARTIFACT_PARSE_CONCURRENCY, (file) =>
    resolveBundleArtifact(env, ctx, file),
  );
}

export async function resolveBundleArtifact(
  env: Cloudflare.Env,
  ctx: ExecutionContext,
  file: ResolvedReleaseFile,
): Promise<ParsedGateArtifact> {
  const format = getEcosystem(file.ecosystem)?.gate?.sandboxFormat?.(file.kind) ?? "tgz";
  const parsed = await downloadInSandboxInline(env, ctx, { bytes: file.bytes, format });
  const contents = { files: parsed.files, packageJson: parsed.packageJson ?? null };

  let ecosystem = file.ecosystem;
  let kind = file.kind;
  if (ecosystem === AMBIGUOUS_ARCHIVE_ECOSYSTEM) {
    const claims = detectArchiveEcosystems(contents);
    if (claims.length === 0) {
      throw new WorkflowArtifactError(
        "artifact_identity_missing",
        `${file.path} is not a recognizable npm or PyPI release artifact`,
      );
    }
    if (claims.length > 1) {
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
}

export function compactDuplicateTextSamples(
  artifact: ParsedGateArtifact,
  retainedSamples: Map<string, string>,
  scope: string,
): ParsedGateArtifact {
  for (const file of artifact.files) {
    if (!file.textSample) continue;
    const key = `${scope}\0${artifact.kind}\0${file.path}\0${file.sha256}`;
    const retained = retainedSamples.get(key);
    if (retained !== undefined) {
      file.textSample = retained;
    } else {
      retainedSamples.set(key, file.textSample);
    }
  }
  return artifact;
}
