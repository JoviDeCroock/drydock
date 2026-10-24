import { and, eq } from "drizzle-orm";
import type { AppDb } from "../../db/client";
import { githubAppInstallations, githubReleaseTargets } from "../../db/schema";
import { processReleaseBundleForGate, WorkflowArtifactError } from "../github-app/artifacts";
import { readGithubAppConfig } from "../github-app/config";
import { getGateForOrganization } from "../github-app/webhook-gates";
import { selectBundleClassifier } from "../workflow-gates/prepare";

export type GateArtifactFetchResult =
  /** `oversized` holds the wanted paths over `maxFileBytes`: verified, not kept. */
  | { status: "ok"; files: Map<string, Uint8Array>; oversized: Set<string> }
  | { status: "digest_mismatch" | "unavailable" };

/** Stops the bundle walk once every wanted file is in hand. */
class CollectedEverything extends Error {}
class DigestMismatch extends Error {}

/**
 * Downloads a workflow gate's GitHub Actions artifacts again and returns the
 * bytes of exactly the files in `wanted` (bundle path → reviewed SHA-256).
 *
 * The installation token is minted and used here, in the parent Worker, by the
 * same `processReleaseBundleForGate` path the review used; only the returned
 * bytes go on to the container. Every file must hash to the digest the scan
 * recorded, or nothing is returned: GitHub artifacts are immutable, so a
 * mismatch means the run would not execute what was reviewed. A file over
 * `maxFileBytes` is reported in `oversized` rather than failing the fetch, so
 * the caller can still run the files that fit.
 *
 * This never writes gate state. The gate may be decided, or still waiting on
 * a maintainer; a detonation must neither hold nor move it.
 */
export async function fetchGateReleaseFiles(
  env: Cloudflare.Env,
  db: AppDb,
  input: {
    organizationId: string;
    gateId: string;
    wanted: ReadonlyMap<string, string>;
    maxFileBytes: number;
  },
): Promise<GateArtifactFetchResult> {
  const { organizationId, gateId, wanted, maxFileBytes } = input;
  if (wanted.size === 0) return { status: "unavailable" };
  let config;
  try {
    config = readGithubAppConfig(env);
  } catch {
    return { status: "unavailable" };
  }
  const gate = await getGateForOrganization(db, organizationId, gateId);
  if (!gate) return { status: "unavailable" };
  const [installation] = await db
    .select()
    .from(githubAppInstallations)
    .where(
      and(
        eq(githubAppInstallations.id, gate.installationRowId),
        eq(githubAppInstallations.organizationId, organizationId),
      ),
    )
    .limit(1);
  if (!installation || installation.status !== "active") return { status: "unavailable" };
  const [releaseTarget] = await db
    .select()
    .from(githubReleaseTargets)
    .where(
      and(
        eq(githubReleaseTargets.id, gate.releaseTargetId),
        eq(githubReleaseTargets.organizationId, organizationId),
      ),
    )
    .limit(1);
  if (!releaseTarget) return { status: "unavailable" };

  const found = new Map<string, Uint8Array>();
  const oversized = new Set<string>();
  try {
    const { classify, artifactName, artifactNamePrefix } = selectBundleClassifier(releaseTarget);
    await processReleaseBundleForGate(
      config,
      {
        installationExternalId: installation.installationId,
        repositoryFullName: gate.repositoryFullName,
        runId: gate.runId,
        ...(artifactName ? { artifactName } : {}),
        ...(artifactNamePrefix ? { artifactNamePrefix } : {}),
      },
      classify,
      async (file) => {
        const expected = wanted.get(file.path);
        if (expected === undefined || found.has(file.path) || oversized.has(file.path)) {
          return null;
        }
        if (file.sha256 !== expected) throw new DigestMismatch();
        if (file.bytes.byteLength > maxFileBytes) oversized.add(file.path);
        else found.set(file.path, file.bytes);
        if (found.size + oversized.size === wanted.size) throw new CollectedEverything();
        return null;
      },
    );
  } catch (err) {
    if (err instanceof DigestMismatch) return { status: "digest_mismatch" };
    if (!(err instanceof CollectedEverything)) {
      // The same path with two different payloads across shards is the one
      // bundle error that says the bytes are not the reviewed ones.
      return err instanceof WorkflowArtifactError && err.code === "artifact_identity_inconsistent"
        ? { status: "digest_mismatch" }
        : { status: "unavailable" };
    }
  }
  return found.size + oversized.size === wanted.size
    ? { status: "ok", files: found, oversized }
    : { status: "unavailable" };
}
