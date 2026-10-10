import { useComputed } from "@preact/signals";
import { Show } from "@preact/signals/utils";
import { AppHeaderActions } from "../features/account/AppHeaderActions";
import { LinkButton } from "../components/Button";
import { Card } from "../components/Card";
import { HeaderFeedback, PageShell } from "../components/PageShell";
import { Muted } from "../components/Typography";
import { sessionModel } from "../models/auth";
import { useAuthedSession } from "./useAuthedSession";

export default function NotFoundPage() {
  // A dead link can be the first page loaded, so ask for the session here. The
  // way back reads the same signal as the shell's brand mark, so a signed-in
  // visitor is offered the app in both places, never the landing page.
  useAuthedSession();
  const signedIn = sessionModel.authenticated;
  const backHref = useComputed(() => (signedIn.value ? "/dashboard" : "/"));
  const backLabel = useComputed(() => (signedIn.value ? "Back to reviews" : "Back to home"));
  return (
    <PageShell
      width="narrow"
      headerActions={
        <Show when={signedIn} fallback={<HeaderFeedback />}>
          <AppHeaderActions />
        </Show>
      }
    >
      <Card class="flex flex-col gap-3">
        <h1 class="text-2xl font-semibold tracking-[-0.015em] m-0">Page not found</h1>
        <Muted class="text-[13px] m-0">That page isn't available.</Muted>
        <div class="mt-2">
          <LinkButton href={backHref} variant="secondary">
            {backLabel}
          </LinkButton>
        </div>
      </Card>
    </PageShell>
  );
}
