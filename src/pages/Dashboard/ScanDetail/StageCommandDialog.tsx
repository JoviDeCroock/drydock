import { useEffect } from "preact/hooks";
import { useSignal } from "@preact/signals";
import { Show } from "@preact/signals/utils";
import {
  dismissStageCommandPrompt,
  stageCommandPrompt,
  type StageCommandPrompt,
} from "../../../models/stage-command-prompt";
import { Button, LinkButton } from "../../../components/Button";
import { Dialog } from "../../../components/Dialog";

/**
 * Shown after a decision is recorded for a reviewer who is not finishing the
 * publish in npm's web UI. Drydock never runs the command — it only saves the
 * reviewer a trip to the docs to look up the stage id and subcommand.
 *
 * Mounted by every surface that hosts the decision dialog; it renders nothing
 * until `stageCommandPrompt` holds a prompt.
 */
export function StageCommandDialogHost() {
  // The store outlives this route, so drop any pending prompt on the way out —
  // otherwise a decision made on the dashboard would reopen the dialog on the
  // next surface that hosts it.
  useEffect(() => dismissStageCommandPrompt, []);
  return (
    <Show<StageCommandPrompt | null> when={stageCommandPrompt}>
      {(prompt) => <StageCommandDialog prompt={prompt} />}
    </Show>
  );
}

function StageCommandDialog({ prompt }: { prompt: StageCommandPrompt }) {
  // null while untouched so the <Show> boundary renders nothing until a copy is
  // actually attempted.
  const copyState = useSignal<"copied" | "failed" | null>(null);
  const approving = prompt.decision === "publish";
  const target = [prompt.packageName, prompt.stagedVersion].filter(Boolean).join("@");

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(prompt.command);
      copyState.value = "copied";
    } catch {
      // Clipboard access is denied outside secure contexts and in some
      // permission setups; the command stays selectable either way.
      copyState.value = "failed";
    }
  };

  return (
    <Dialog
      open={true}
      onClose={dismissStageCommandPrompt}
      // Wider than the default: the body is a copyable one-line shell command
      // whose stage id runs long, so the default width scrolls it almost
      // immediately.
      size="md"
      title={approving ? "Finish the publish on npm" : "Remove the staged publish on npm"}
      description={
        approving
          ? "Your approval is recorded in Drydock. npm still holds the staged tarball until you approve it there, with your normal 2FA."
          : "Your decision is recorded in Drydock. The staged tarball stays on npm until you reject it there, with your normal 2FA."
      }
    >
      {target ? (
        <p class="m-0 text-[13px] leading-[1.6] text-ink-muted">
          Release <span class="font-mono text-[12px] text-ink">{target}</span>
        </p>
      ) : null}

      <div class="flex flex-col gap-2">
        <code class="font-mono text-[12px] text-ink bg-surface-2 border border-border rounded px-2.5 py-2 overflow-x-auto whitespace-pre">
          {prompt.command}
        </code>
        <div class="flex flex-wrap items-center gap-2">
          <Button variant="secondary" size="sm" onClick={() => void copy()}>
            Copy command
          </Button>
          {/* aria-live so the confirmation reaches screen readers; the button
              label stays stable so its accessible name does not shift. */}
          <span class="text-[12px] text-ink-subtle" aria-live="polite">
            <Show<"copied" | "failed" | null> when={copyState}>
              {(state) => (state === "copied" ? "Copied." : "Copy failed — select it manually.")}
            </Show>
          </span>
        </div>
      </div>

      <p class="m-0 text-[12px] leading-[1.6] text-ink-subtle">
        Needs npm CLI 11.15 or newer, signed in as a maintainer of the package.
      </p>

      <div class="flex flex-wrap gap-2">
        <Button onClick={dismissStageCommandPrompt}>Done</Button>
        {prompt.npmStagedPackagesUrl ? (
          <LinkButton
            variant="secondary"
            href={prompt.npmStagedPackagesUrl}
            target="_blank"
            rel="noreferrer noopener"
          >
            Open npm instead
          </LinkButton>
        ) : null}
      </div>
    </Dialog>
  );
}
