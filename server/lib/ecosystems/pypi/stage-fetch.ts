import { readBoundedBytes, readBoundedText } from "../../platform/bounded-body";
import { reliableFetch } from "../../platform/reliable-fetch";
import {
  PyPiStageError,
  STAGE_INDEX_ACCEPT,
  parseStageProjectPage,
  stageFileOrigins,
  stageProjectUrl,
  type StageProjectPage,
} from "./stage";

/**
 * Credential-free reads of a PEP 694 stage: the project page and the staged
 * files. Runs in the parent Worker, not the sandbox, so the capability URLs
 * never enter the isolate that parses hostile bytes; the bytes are parsed
 * there afterwards from memory.
 *
 * Every hop, including redirects, must stay on the allowlisted origins for the
 * stage's index. Errors carry no URL: the URL is the secret.
 */

const STAGE_TIMEOUT_MS = 15_000;
const STAGE_FILE_TIMEOUT_MS = 60_000;
const MAX_STAGE_REDIRECTS = 3;
// A stage view lists one session's files, but an index may overlay published
// releases too; numpy's full simple page is a few MiB.
export const MAX_STAGE_PAGE_BYTES = 8 * 1024 * 1024;
// Matches the per-distribution cap on GitHub artifact entries, so a release
// the artifact path can review is one the stage path can review.
export const MAX_STAGED_FILE_BYTES = 25 * 1024 * 1024;
const USER_AGENT = "drydock-pep694-stage/0.1";

export async function fetchStageProjectPage(
  stageUrl: URL,
  project: string,
): Promise<StageProjectPage> {
  const pageUrl = stageProjectUrl(stageUrl, project);
  const response = await fetchWithinOrigins(pageUrl, [stageUrl.origin], {
    accept: STAGE_INDEX_ACCEPT,
    timeoutMs: STAGE_TIMEOUT_MS,
    what: `stage index page for ${project}`,
  });
  const deadlineMs = Date.now() + STAGE_TIMEOUT_MS;
  const body = await readBoundedText(response.response, {
    maxBytes: MAX_STAGE_PAGE_BYTES,
    deadlineMs,
  });
  if (body === null) {
    throw unavailable(`stage index page for ${project} is too large or could not be read`);
  }
  return parseStageProjectPage(body, response.response.headers.get("content-type"), response.url);
}

/**
 * Download one staged file. `maxBytes` lets the caller spend a release-wide
 * byte budget; it never exceeds the per-file cap. The body read has its own
 * deadline, because the fetch timeout stops at headers.
 */
export async function downloadStagedFile(
  url: URL,
  indexOrigin: string,
  filename: string,
  maxBytes: number = MAX_STAGED_FILE_BYTES,
): Promise<Uint8Array> {
  const { response } = await fetchWithinOrigins(url, stageFileOrigins(indexOrigin), {
    accept: "application/octet-stream",
    timeoutMs: STAGE_FILE_TIMEOUT_MS,
    what: `staged file ${filename}`,
  });
  const bytes = await readBoundedBytes(response, {
    maxBytes: Math.min(maxBytes, MAX_STAGED_FILE_BYTES),
    deadlineMs: Date.now() + STAGE_FILE_TIMEOUT_MS,
  });
  if (bytes === null) {
    throw unavailable(`staged file ${filename} is too large, too slow, or could not be read`);
  }
  return bytes;
}

/**
 * GET `url`, following redirects by hand only while every hop is https on one
 * of `allowedOrigins`. A refused hop, transport failure, or non-2xx answer is
 * a `stage_unavailable` error naming `what`, never the URL.
 */
async function fetchWithinOrigins(
  url: URL,
  allowedOrigins: readonly string[],
  options: { accept: string; timeoutMs: number; what: string },
): Promise<{ response: Response; url: URL }> {
  let target = url;
  for (let hop = 0; hop <= MAX_STAGE_REDIRECTS; hop += 1) {
    if (!isAllowedHop(target, allowedOrigins)) {
      throw unavailable(
        hop === 0
          ? `${options.what} is not on an allowed index origin`
          : `${options.what} redirected off the allowed index origins`,
      );
    }
    let response: Response;
    try {
      response = await reliableFetch(target.toString(), {
        headers: { accept: options.accept, "user-agent": USER_AGENT },
        redirect: "manual",
        timeoutMs: options.timeoutMs,
        attempts: 2,
      });
    } catch {
      throw unavailable(`${options.what} could not be reached`);
    }
    if (response.status >= 300 && response.status < 400) {
      await response.body?.cancel().catch(() => undefined);
      const location = response.headers.get("location");
      if (!location) throw unavailable(`${options.what} redirected without a Location`);
      try {
        target = new URL(location, target);
      } catch {
        throw unavailable(`${options.what} redirected to an invalid URL`);
      }
      continue;
    }
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      throw unavailable(`${options.what} answered HTTP ${response.status}`);
    }
    return { response, url: target };
  }
  throw unavailable(`${options.what} redirected too many times`);
}

function isAllowedHop(url: URL, allowedOrigins: readonly string[]): boolean {
  return (
    url.protocol === "https:" &&
    !url.username &&
    !url.password &&
    allowedOrigins.includes(url.origin)
  );
}

function unavailable(message: string): PyPiStageError {
  return new PyPiStageError("stage_unavailable", message);
}
