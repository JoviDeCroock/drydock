import type { Signal } from "@preact/signals";
import { Show } from "@preact/signals/utils";
import { LinkButton } from "../components/Button";

export function MarketingHeaderActions({ authed }: { authed: Signal<boolean> }) {
  return (
    <>
      <Show
        when={authed}
        fallback={
          <LinkButton href="/" variant="ghost" size="sm">
            Home
          </LinkButton>
        }
      >
        <LinkButton href="/dashboard" variant="ghost" size="sm">
          Dashboard
        </LinkButton>
      </Show>
      <LinkButton href="/docs" variant="ghost" size="sm">
        Docs
      </LinkButton>
    </>
  );
}
