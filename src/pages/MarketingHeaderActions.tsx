import type { Signal } from "@preact/signals";
import { Show } from "@preact/signals/utils";
import { LinkButton } from "../components/Button";

export function MarketingHeaderActions({
  authed,
  page,
}: {
  authed: Signal<boolean>;
  page: "home" | "docs";
}) {
  return (
    <>
      {page !== "home" ? (
        <LinkButton href="/" variant="ghost" size="sm">
          Home
        </LinkButton>
      ) : null}
      {page !== "docs" ? (
        <LinkButton href="/docs" variant="ghost" size="sm">
          Docs
        </LinkButton>
      ) : null}
      <Show
        when={authed}
        fallback={
          <>
            <LinkButton href="/login" variant="ghost" size="sm">
              Sign in
            </LinkButton>
            <LinkButton href="/register" size="sm">
              Create account
            </LinkButton>
          </>
        }
      >
        <LinkButton href="/dashboard" variant="ghost" size="sm">
          Dashboard
        </LinkButton>
      </Show>
    </>
  );
}
