import type { Signal } from "@preact/signals";
import { Show } from "@preact/signals/utils";
import { useLocation } from "preact-iso";
import { LinkButton } from "../components/Button";
import { authPageHref } from "./Auth/auth-links";

export function MarketingHeaderActions({ authed }: { authed: Signal<boolean> }) {
  const location = useLocation();
  // The brand mark is the way home, so there is no "Home" item. Signing in
  // from a page the sanitizer lets sign-in return to (a package diff) comes
  // back to it; anywhere else falls through to the default destination.
  const signInHref = authPageHref("/login", location.url);
  return (
    <>
      <Show when={authed}>
        <LinkButton href="/dashboard" variant="ghost" size="sm">
          Reviews
        </LinkButton>
      </Show>
      <LinkButton href="/diff" variant="ghost" size="sm">
        Package diff
      </LinkButton>
      <LinkButton href="/docs" variant="ghost" size="sm">
        Docs
      </LinkButton>
      <Show when={() => !authed.value}>
        <LinkButton href={signInHref} variant="ghost" size="sm">
          Sign in
        </LinkButton>
      </Show>
    </>
  );
}
