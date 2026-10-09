import { useSignal } from "@preact/signals";
import { useCancellableEffect } from "../lib/use-cancellable-effect";
import { sessionModel } from "../models/auth";

export function useAuthedSession() {
  const authed = useSignal(false);

  useCancellableEffect((isCancelled) => {
    void sessionModel.load().then((session) => {
      if (isCancelled()) return;
      authed.value = Boolean(session?.user);
    });
  }, []);

  return authed;
}
