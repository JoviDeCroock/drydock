import type { ScanInput } from "../../types";
import { isValidStageId } from "../ecosystems/npm/stage-id";
import { isAtpmStageId, parseAtpmStageId } from "../ecosystems/atpm/stage-ref";

export type ScanInputParseResult =
  | { ok: true; input: ScanInput }
  | { ok: false; error: string; status: 400 };

/**
 * Which ecosystem a staged reference belongs to.
 *
 * Every ecosystem's reference has to fit the one `stage_id` column, so the
 * spelling has to say which kind it is. npm's is the registry's own opaque id
 * and predates the column having more than one meaning, so it stays the
 * unprefixed default; anything else declares itself with a prefix. Adding a
 * third staged ecosystem means adding a prefix here, not a branch downstream.
 */
function ecosystemForStageId(stageId: string): string {
  return isAtpmStageId(stageId) ? "atpm" : "npm";
}

/**
 * Syntax only. This runs at the request boundary, so it deliberately imports
 * the two reference parsers rather than the ecosystem registry: pulling the
 * registry in would drag every adapter — and the sandbox entrypoint — into a
 * function whose whole job is to reject a malformed string. The adapter parses
 * the same value again when the pipeline runs, which is where semantics belong.
 */
function isKnownStageReference(ecosystem: string, stageId: string): boolean {
  return ecosystem === "atpm" ? parseAtpmStageId(stageId) !== null : true;
}

export function parseScanInput(
  body: Partial<ScanInput> & { maxBytesPerFile?: unknown },
): ScanInputParseResult {
  // Scan limits are server-controlled. `maxBytesPerFile` no longer exists as a
  // scan knob (the sandbox always scans whole files; see issue #191) but a client
  // could still send the legacy field, so keep rejecting it rather than silently
  // ignoring an attempt to narrow the review window.
  if (body.maxFiles !== undefined || body.maxBytesPerFile !== undefined) {
    return { ok: false, error: "scan limits are controlled by the server", status: 400 };
  }

  const stageId = String(body.stageId || "");
  // The shared grammar bounds what may reach the column and every consumer of
  // it; the adapter then decides whether the value is a reference it can read.
  if (!isValidStageId(stageId)) return { ok: false, error: "invalid stageId", status: 400 };

  const ecosystem = ecosystemForStageId(stageId);
  if (!isKnownStageReference(ecosystem, stageId)) {
    return { ok: false, error: `invalid ${ecosystem} stageId`, status: 400 };
  }

  return { ok: true, input: { stageId, ecosystem } };
}
