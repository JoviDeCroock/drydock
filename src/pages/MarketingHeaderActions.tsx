import type { Signal } from "@preact/signals";
import { Show } from "@preact/signals/utils";
import { LinkButton } from "../components";

export function MarketingHeaderActions({ authed }: { authed: Signal<boolean> }) {
  return (
    <>
      <LinkButton href="/" variant="ghost" size="sm">
        Home
      </LinkButton>
      <LinkButton href="/docs" variant="ghost" size="sm">
        Docs
      </LinkButton>
      <Show when={authed}>
        <LinkButton href="/dashboard" variant="ghost" size="sm">
          Dashboard
        </LinkButton>
      </Show>
    </>
  );
}
