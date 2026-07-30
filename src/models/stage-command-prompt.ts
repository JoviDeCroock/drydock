import { signal } from "@preact/signals";
import type { ScanDecision } from "./scan";

export interface StageCommandPrompt {
  decision: ScanDecision;
  /** Ready-to-paste `npm stage approve|reject <stage-id>`. */
  command: string;
  packageName: string | null;
  stagedVersion: string | null;
  npmStagedPackagesUrl: string | null;
}

// Module-level store, like the toaster's: the decision dialog raises the prompt
// and then unmounts (the dashboard list drops it as soon as the decision saves),
// so the follow-up cannot live inside that component. A single host per decision
// surface renders whatever is in here.
export const stageCommandPrompt = signal<StageCommandPrompt | null>(null);

export function showStageCommandPrompt(prompt: StageCommandPrompt): void {
  stageCommandPrompt.value = prompt;
}

export function dismissStageCommandPrompt(): void {
  stageCommandPrompt.value = null;
}
