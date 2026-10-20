import { hexEncode } from "../../platform/crypto-utils";
import { parseContentLength } from "../../platform/bounded-body";
import type { StagedArchiveRequest, StagedArchiveResult } from "../package-adapter";
import { isValidStageId } from "./stage-id";

interface GatewayFactory {
  exports: {
    NpmStageGateway(options: { props: { npmToken?: string; npmRegistry?: string } }): Fetcher;
  };
}

/**
 * Raw staged `.tgz` bytes for the detonation sandbox.
 *
 * The request goes through `NpmStageGateway`, still the only code that
 * attaches the npm token, and the token never leaves this call. A stage is
 * mutable, so the bytes are only returned when their SHA-256 equals the
 * digest of the bytes the scan reviewed: detonation must run what was
 * reviewed, not whatever the stage holds now.
 */
export async function fetchStagedArchive(
  ctx: ExecutionContext,
  credentials: { token: string; registry: string },
  request: StagedArchiveRequest,
): Promise<StagedArchiveResult> {
  if (!isValidStageId(request.stageId)) return { status: "unavailable" };
  const gateway = (ctx as unknown as GatewayFactory).exports.NpmStageGateway({
    props: { npmToken: credentials.token, npmRegistry: credentials.registry },
  });
  const url = `${credentials.registry.replace(/\/$/, "")}/-/stage/${encodeURIComponent(request.stageId)}/tarball`;
  let response: Response;
  try {
    response = await gateway.fetch(url, { headers: { accept: "application/octet-stream" } });
  } catch {
    return { status: "unavailable" };
  }
  if (!response.ok || !response.body) {
    await response.body?.cancel().catch(() => undefined);
    return { status: "unavailable" };
  }
  const declared = parseContentLength(response.headers.get("content-length"));
  if (declared !== null && declared > request.maxBytes) {
    await response.body.cancel().catch(() => undefined);
    return { status: "too_large" };
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > request.maxBytes) {
        await reader.cancel().catch(() => undefined);
        return { status: "too_large" };
      }
      chunks.push(value);
    }
  } catch {
    return { status: "unavailable" };
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  const sha256 = hexEncode(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)));
  if (sha256 !== request.expectedSha256.toLowerCase()) return { status: "digest_mismatch" };
  return { status: "ok", bytes: bytes.buffer, sha256 };
}
