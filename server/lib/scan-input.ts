import type { ScanInput } from "../types";
import { isValidStageId } from "./stage-id";

export type ScanInputParseResult =
  | { ok: true; input: ScanInput }
  | { ok: false; error: string; status: 400 };

export function parseScanInput(body: Partial<ScanInput>): ScanInputParseResult {
  if (body.maxFiles !== undefined || body.maxBytesPerFile !== undefined) {
    return { ok: false, error: "scan limits are controlled by the server", status: 400 };
  }

  const stageId = String(body.stageId || "");
  if (!isValidStageId(stageId)) return { ok: false, error: "invalid stageId", status: 400 };

  return { ok: true, input: { stageId } };
}
