import { useSignal } from "@preact/signals";
import { useEffect } from "preact/hooks";
import { sessionModel } from "../models/auth";

export function useAuthedSession() {
  const authed = useSignal(false);

  useEffect(() => {
    let cancelled = false;
    void sessionModel.load().then((session) => {
      if (cancelled) return;
      authed.value = Boolean(session?.user);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  return authed;
}
