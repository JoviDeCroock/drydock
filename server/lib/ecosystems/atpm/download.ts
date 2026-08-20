import type { AtpmRepoIdentity } from "./identity";
import {
  assertAtpmArchiveIntegrity,
  assertAtpmBlobDigest,
  assertAtpmTarballUrl,
  atpmBlobUrl,
} from "./record";
import { publicDiffDownloadError } from "../../public-diff/download";
import { PublicDiffError } from "../../public-diff/error";
import {
  downloadInSandbox,
  SANDBOX_MAX_STREAM_TAR_BYTES,
  type DownloadResult,
} from "../../sandbox";

/**
 * One atpm artifact, whether it is a published version or a staged candidate.
 *
 * The two record shapes differ, but everything that authenticates the bytes is
 * the same: a content-addressed blob, a digest the record declares for it, and
 * an install URL the App View will hand to clients. Reviewing a candidate and
 * reviewing the release it becomes must apply identical checks, or approving
 * would change what was verified.
 */
export interface AtpmArtifactRef {
  cid: string;
  size: number | null;
  declaredTarball: string | null;
  declaredIntegrity: string | null;
}

/**
 * Fetch and parse one atpm artifact in the credentials-free sandbox.
 *
 * The blob URL is rebuilt from the resolved PDS and the CID and pinned as the
 * only allowed egress; `meta.dist.tarball` is never followed, only required to
 * name that same endpoint. Nothing on this path holds a credential of any kind,
 * which is what lets a staged review run without an atpm token.
 */
export async function downloadAtpmArtifact(
  env: Cloudflare.Env,
  ctx: ExecutionContext,
  identity: AtpmRepoIdentity,
  artifact: AtpmArtifactRef,
  options: { maxFiles?: number } = {},
): Promise<DownloadResult> {
  // The record advertises the blob's size, so an oversized release can be
  // refused before a byte is fetched instead of after the sandbox gives up.
  if (artifact.size !== null && artifact.size > SANDBOX_MAX_STREAM_TAR_BYTES) {
    throw new PublicDiffError("release artifact exceeds the review size limit", 413);
  }
  const url = atpmBlobUrl(identity, artifact.cid);
  assertAtpmTarballUrl(artifact, url);

  let archive: DownloadResult;
  try {
    archive = await downloadInSandbox(env, ctx, {
      tarballUrl: url,
      archiveFormat: "tgz",
      publicArtifactUrls: [url],
      // SHA-256 re-derives the blob's content address and SHA-512 checks npm's
      // install integrity and any Sigstore subject digest; SHA-1 is the
      // record's own `dist.shasum` claim. Other adapters do not pay for the
      // extra two.
      archiveDigestAlgorithms: ["SHA-1", "SHA-256", "SHA-512"],
      ...(options.maxFiles === undefined ? {} : { maxFiles: options.maxFiles }),
    });
  } catch (err) {
    throw publicDiffDownloadError(err);
  }
  assertAtpmBlobDigest(artifact.cid, archive.archiveSha256 ?? null);
  assertAtpmArchiveIntegrity(artifact.declaredIntegrity, archive.archiveSha512 ?? null);
  return archive;
}
