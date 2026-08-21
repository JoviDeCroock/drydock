import { isValidStageId } from "../../server/lib/ecosystems/npm/stage-id";
import type { ScanDecision } from "../models/scan";

export type NpmStagedCommandScan = {
  source?: string | null;
  stageId?: string | null;
};

/**
 * The terminal half of "finish this staged publish": npm CLI 11.15+ completes or
 * removes a stage with `npm stage approve|reject <stage-id>`, the same action the
 * staged-packages web page performs. Drydock only prints it — running it (and the
 * 2FA it prompts for) stays with the maintainer.
 *
 * The string is meant to be pasted into a shell, so the stage id is validated
 * against npm's stage-id shape rather than interpolated raw: registry-supplied
 * text must never reach a command line with shell metacharacters intact.
 */
export function npmStageCommandFor(
  decision: ScanDecision,
  scan: NpmStagedCommandScan,
): string | null {
  if (scan.source === "workflow_gate") return null;
  const stageId = scan.stageId?.trim();
  if (!isValidStageId(stageId)) return null;

  return `npm stage ${decision === "publish" ? "approve" : "reject"} ${stageId}`;
}
