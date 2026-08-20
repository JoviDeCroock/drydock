import { isValidStageId } from "../../server/lib/ecosystems/npm/stage-id";
import { parseAtpmStageId } from "../../server/lib/ecosystems/atpm/stage-ref";
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

  // An atpm review is addressed by the record it read — `atpm:<did>:<rkey>` —
  // which is Drydock's spelling, not one the CLI understands. atpm identifies
  // the same candidate by a uuid derived from the record's URI and CID, and
  // that is carried in the reference precisely so this command can be built
  // without another lookup. A reference minted before that was carried has no
  // usable command, and printing the internal one would be worse than printing
  // nothing.
  const atpm = parseAtpmStageId(stageId);
  if (atpm) {
    if (!atpm.approveId) return null;
    // atpm has no `reject`: a candidate is withdrawn by deleting its record,
    // which the CLI spells `npm stage rm`.
    const verb = decision === "publish" ? "approve" : "rm";
    return `npm stage ${verb} ${atpm.approveId}`;
  }

  return `npm stage ${decision === "publish" ? "approve" : "reject"} ${stageId}`;
}
