/**
 * R2 storage for release-set artifact bytes.
 *
 * These objects are deliberately short-lived. The push path stores uploaded
 * package bytes only for the window between "CI uploaded them" and "Drydock
 * finished reviewing them", then deletes them: the review's durable output is
 * the scan evidence and the recomputed digests, not the tarball. Keeping the
 * bytes any longer would turn Drydock into a private-package mirror, which is a
 * materially different security and retention obligation than the one the
 * pull-based gate has today (where bytes are never persisted at all).
 */

/** One artifact must fit the same envelope a gate bundle entry does today. */
export const MAX_RELEASE_ARTIFACT_BYTES = 25 * 1024 * 1024;

/** Matches the streamed gate bundle's artifact ceiling. */
export const MAX_RELEASE_SET_ARTIFACTS = 128;

/** Whole-release ceiling, so one run cannot fill the bucket. */
export const MAX_RELEASE_SET_BYTES = 256 * 1024 * 1024;

export function releaseArtifactKey(
  organizationId: string,
  releaseSetId: string,
  artifactId: string,
): string {
  return `orgs/${safeSegment(organizationId)}/ci-releases/${safeSegment(releaseSetId)}/${safeSegment(artifactId)}`;
}

function releaseSetPrefix(organizationId: string, releaseSetId: string): string {
  return `orgs/${safeSegment(organizationId)}/ci-releases/${safeSegment(releaseSetId)}/`;
}

export async function putReleaseArtifact(
  bucket: R2Bucket,
  key: string,
  bytes: Uint8Array,
): Promise<void> {
  await bucket.put(key, bytes as unknown as ArrayBuffer, {
    httpMetadata: { contentType: "application/octet-stream" },
  });
}

export async function readReleaseArtifact(
  bucket: R2Bucket,
  key: string,
): Promise<Uint8Array | null> {
  const object = await bucket.get(key);
  if (!object) return null;
  return new Uint8Array(await object.arrayBuffer());
}

/**
 * Delete every stored byte for a release set. Best effort by design: a failed
 * cleanup must never fail the review that just succeeded, and the next call
 * (or a lifecycle rule on the bucket) will catch the leftovers.
 */
export async function deleteReleaseArtifacts(
  bucket: R2Bucket,
  organizationId: string,
  releaseSetId: string,
): Promise<void> {
  const prefix = releaseSetPrefix(organizationId, releaseSetId);
  let cursor: string | undefined;
  do {
    const listing = await bucket.list({ prefix, cursor, limit: 200 });
    const keys = listing.objects.map((object) => object.key);
    if (keys.length > 0) await bucket.delete(keys);
    cursor = listing.truncated ? listing.cursor : undefined;
  } while (cursor);
}

function safeSegment(value: string): string {
  return encodeURIComponent(value).replace(/%/g, "~");
}
