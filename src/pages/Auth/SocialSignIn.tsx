import { useEffect } from "preact/hooks";
import { useSignal } from "@preact/signals";
import { Show } from "@preact/signals/utils";
import { authConfigModel, sessionModel } from "../../models/auth";
import { errorMessage } from "../../models/api";
import { Button } from "../../components/Button";
import { Muted } from "../../components/Typography";

/**
 * "Continue with GitHub" plus the `or` divider, rendered only when the
 * deployment has the OAuth credential pair configured. Identity-only: the
 * authorize grant shares the user's profile and verified email, never repo
 * access — installing the GitHub App for workflow gates stays a separate,
 * optional step.
 */
export function SocialSignIn({
  returnTo,
  errorPath,
  onError,
}: {
  returnTo: string;
  /** The page that starts the flow, so a failed redirect lands back on it. */
  errorPath: "/login" | "/register";
  onError: (message: string) => void;
}) {
  const starting = useSignal(false);

  useEffect(() => {
    void authConfigModel.load();
  }, []);

  const onGitHub = async () => {
    starting.value = true;
    try {
      await sessionModel.signInWithGitHub(returnTo, errorPath);
      // The browser is navigating to GitHub; leave the button disabled.
    } catch (err) {
      starting.value = false;
      onError(errorMessage(err));
    }
  };

  return (
    <Show when={authConfigModel.githubSignIn}>
      <div class="flex flex-col gap-3 mt-2">
        <Button variant="secondary" disabled={starting} onClick={onGitHub}>
          <Show when={starting} fallback="Continue with GitHub">
            Redirecting to GitHub…
          </Show>
        </Button>
        <Muted class="text-[12px] m-0">
          GitHub shares your name and verified email. Nothing is installed and no repository access
          is granted.
        </Muted>
        <div class="flex items-center gap-3" aria-hidden>
          <span class="h-px flex-1 bg-border" />
          <span class="font-mono text-[10px] uppercase tracking-[0.1em] text-ink-subtle">or</span>
          <span class="h-px flex-1 bg-border" />
        </div>
      </div>
    </Show>
  );
}
