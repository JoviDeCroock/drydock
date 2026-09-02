import type { ScanInput } from "../../types";
import { getPublishedAdapter } from "../ecosystems";
import { isValidStageId } from "../ecosystems/npm/stage-id";

/** A published `package@version` a caller asked to review, before the registry confirms it. */
export interface PublishedScanRequest {
  ecosystem: string;
  packageName: string;
  version: string;
  baselineVersion: string | null;
}

export type ScanInputParseResult =
  | { ok: true; kind: "staged"; input: ScanInput }
  | { ok: true; kind: "published"; request: PublishedScanRequest }
  | { ok: false; error: string; status: 400 };

export function parseScanInput(
  body: Partial<ScanInput> & Partial<PublishedScanRequest> & { maxBytesPerFile?: unknown },
): ScanInputParseResult {
  // Scan limits are server-controlled. `maxBytesPerFile` no longer exists as a
  // scan knob (the sandbox always scans whole files; see issue #191) but a client
  // could still send the legacy field, so keep rejecting it rather than silently
  // ignoring an attempt to narrow the review window.
  if (body.maxFiles !== undefined || body.maxBytesPerFile !== undefined) {
    return { ok: false, error: "scan limits are controlled by the server", status: 400 };
  }

  // The two input shapes are disjoint: a staged publish is named by the
  // registry's stage id, a published pair by its own coordinates. The presence
  // of either coordinate selects the published path, so a request that means to
  // review a release is never silently read as a malformed stage id.
  if (
    body.ecosystem !== undefined ||
    body.packageName !== undefined ||
    body.version !== undefined
  ) {
    return parsePublishedScanInput(body);
  }

  const stageId = String(body.stageId || "");
  if (!isValidStageId(stageId)) return { ok: false, error: "invalid stageId", status: 400 };

  return { ok: true, kind: "staged", input: { stageId } };
}

function parsePublishedScanInput(body: Partial<PublishedScanRequest>): ScanInputParseResult {
  const ecosystem = typeof body.ecosystem === "string" ? body.ecosystem.trim() : "";
  // The registry decides which ecosystems can be reviewed this way; there is no
  // default, so an unsupported or absent ecosystem fails rather than resolving
  // against one this deployment happens to prefer.
  if (!getPublishedAdapter(ecosystem)) {
    return { ok: false, error: "unsupported ecosystem", status: 400 };
  }
  const packageName = typeof body.packageName === "string" ? body.packageName.trim() : "";
  if (!packageName) return { ok: false, error: "packageName is required", status: 400 };
  const version = typeof body.version === "string" ? body.version.trim() : "";
  if (!version) return { ok: false, error: "version is required", status: 400 };
  const baselineVersion =
    typeof body.baselineVersion === "string" ? body.baselineVersion.trim() || null : null;
  if (body.baselineVersion !== undefined && typeof body.baselineVersion !== "string") {
    return { ok: false, error: "invalid baselineVersion", status: 400 };
  }

  return {
    ok: true,
    kind: "published",
    request: { ecosystem, packageName, version, baselineVersion },
  };
}
