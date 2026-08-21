import {
  ARTIFACT_CONTENT_TYPE,
  SCAN_ARTIFACT_STORAGE_VERSION,
  type ScanArtifactDescriptor,
  type ScanArtifactScanRow,
} from "./types";
/**
 * Digest-verified JSON over R2.
 *
 * Every artifact is written with the SHA-256 the manifest records, and every
 * read recomputes it before the bytes are parsed. A silently truncated or
 * swapped object therefore fails closed rather than being handed to a reviewer
 * as if it were the reviewed release.
 */
import {} from "../../review";
import { describeOperationalError, emitOperationalEvent } from "../../platform/observability";
import { sha256Hex } from "../../platform/crypto-utils";
import { utf8Size } from "../../platform/stable-json";

export async function putVerifiedJson(
  bucket: R2Bucket,
  key: string,
  body: string,
  digest: string,
  customMetadata: Record<string, string>,
): Promise<ScanArtifactDescriptor> {
  const size = utf8Size(body);
  await bucket.put(key, body, {
    httpMetadata: { contentType: ARTIFACT_CONTENT_TYPE },
    customMetadata: {
      ...customMetadata,
      digest,
      storageVersion: String(SCAN_ARTIFACT_STORAGE_VERSION),
    },
  });
  await readVerifiedJsonText(bucket, {
    key,
    digest,
    size,
    scanId: customMetadata.scanId,
    kind: customMetadata.artifactKind,
  });
  return { key, digest, size, contentType: ARTIFACT_CONTENT_TYPE };
}

export async function readDigestVerifiedJsonText(
  bucket: R2Bucket,
  descriptor: {
    key: string;
    digest: string;
    scanId: string;
    kind: string;
  },
): Promise<string> {
  const object = await bucket.get(descriptor.key);
  if (!object) {
    throw new Error(`missing ${descriptor.kind} artifact`);
  }
  const bytes = await object.arrayBuffer();
  const actualDigest = await sha256Hex(bytes);
  if (actualDigest !== descriptor.digest) {
    throw new Error(`${descriptor.kind} artifact digest mismatch`);
  }
  return new TextDecoder().decode(bytes);
}

export async function readVerifiedJsonText(
  bucket: R2Bucket,
  descriptor: {
    key: string;
    digest: string;
    size: number;
    scanId: string;
    kind: string;
  },
): Promise<string> {
  const object = await bucket.get(descriptor.key);
  if (!object) {
    throw new Error(`missing ${descriptor.kind} artifact`);
  }
  const bytes = await object.arrayBuffer();
  const actualSize = bytes.byteLength;
  if (actualSize !== descriptor.size) {
    throw new Error(
      `${descriptor.kind} artifact size mismatch: expected ${descriptor.size}, got ${actualSize}`,
    );
  }
  const actualDigest = await sha256Hex(bytes);
  if (actualDigest !== descriptor.digest) {
    throw new Error(`${descriptor.kind} artifact digest mismatch`);
  }
  return new TextDecoder().decode(bytes);
}

const ARTIFACT_LIST_PAGE = 1000;

export async function deleteArtifactsByPrefix(
  bucket: R2Bucket,
  prefix: string,
  logFields: Record<string, unknown>,
): Promise<void> {
  try {
    let deleted = 0;
    let cursor: string | undefined;
    do {
      const listed = await bucket.list({ prefix, limit: ARTIFACT_LIST_PAGE, cursor });
      const keys = listed.objects.map((object) => object.key);
      if (keys.length > 0) {
        await bucket.delete(keys);
        deleted += keys.length;
      }
      cursor = listed.truncated ? listed.cursor : undefined;
    } while (cursor);
    if (deleted > 0) {
      emitOperationalEvent("info", "scan.artifacts.deleted", {
        ...logFields,
        objectsDeleted: deleted,
      });
    }
  } catch (err) {
    emitOperationalEvent("error", "scan.artifacts.delete_failed", {
      ...logFields,
      error: describeOperationalError(err),
    });
  }
}

export function emitArtifactFallback(
  reason: string,
  scan: Pick<ScanArtifactScanRow, "id" | "organizationId">,
  extra: Record<string, unknown> = {},
) {
  emitOperationalEvent("warn", "scan.artifacts.fallback_read", {
    scanId: scan.id,
    organizationId: scan.organizationId,
    reason,
    ...extra,
  });
}
