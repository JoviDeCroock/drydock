import { useSignal } from "@preact/signals";
import { useCancellableEffect } from "../../lib/use-cancellable-effect";
import type { LandingVariant } from "../../lib/landing-experiment";
import { classifyAcquisitionChannel } from "../../lib/landing-experiment";

export function useLandingExperiment() {
  const initial =
    typeof document !== "undefined"
      ? document.getElementById("app")?.dataset.landingVariant
      : undefined;
  const variant = useSignal<LandingVariant>(initial === "challenger" ? "challenger" : "control");
  useCancellableEffect((isCancelled) => {
    if (initial || typeof window === "undefined") return;
    void fetch("/api/public/v1/landing-experiment", {
      credentials: "same-origin",
      headers: {
        "x-drydock-acquisition-channel": classifyAcquisitionChannel(
          document.referrer,
          location.hostname,
        ),
      },
    })
      .then(async (response) => {
        if (!response.ok) return;
        const result: unknown = await response.json();
        if (
          !isCancelled() &&
          result &&
          typeof result === "object" &&
          "variant" in result &&
          result.variant === "challenger"
        )
          variant.value = "challenger";
      })
      .catch(() => {});
  }, []);
  return variant;
}
