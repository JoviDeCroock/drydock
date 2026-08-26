import { isValidStageId } from "../../server/lib/ecosystems/npm/stage-id";
import {
  isSafeHttpUrlForShellArgument,
  quotePosixShellArgument,
} from "../../server/lib/platform/shell-command";
import type { ScanDecision } from "../models/scan";
import { canOfferNpmStageFollowUp, type NpmStageFollowUpScan } from "./npm-stage-follow-up";

export type NpmStagedCommandScan = NpmStageFollowUpScan & {
  stageId?: string | null;
  registryUrl?: string | null;
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
  if (!canOfferNpmStageFollowUp(scan)) return null;
  const stageId = scan.stageId?.trim();
  if (!isValidStageId(stageId)) return null;
  const command = `npm stage ${decision === "publish" ? "approve" : "reject"} ${stageId}`;
  const registryUrl = scan.registryUrl?.trim();
  if (!registryUrl) return command;
  if (!isSafeHttpUrlForShellArgument(registryUrl)) return null;
  return `${command} --registry ${quotePosixShellArgument(registryUrl)}`;
}
