import type { Capability, CapabilityDelta } from "../../../server/lib/review";
import { Badge, type BadgeTone } from "../../components/Badge";
import { Muted, SectionLabel } from "../../components/Typography";

// Reader-facing names for the capability keys. Kept short: these render as a
// badge row, and the surrounding copy carries the sentence.
const CAPABILITY_LABELS: Record<Capability, string> = {
  network: "network",
  process: "process execution",
  credentials: "credential access",
  dynamicEval: "dynamic eval",
  native: "native code",
  installScripts: "install scripts",
  bin: "CLI commands",
};

/**
 * Advisory capability row shared by the scan workbench and the anonymous
 * /diff page: what this release can do, and what changed against the
 * baseline. Escalations are the signal — "this patch release of a color
 * library now touches the network" — so they lead the row in warn tone while
 * unchanged capabilities stay neutral context.
 *
 * Like the intent envelope, this never restates risk: tones stop at warn even
 * for an escalation, because the deterministic findings own severity.
 */
export function CapabilitiesSection({ delta }: { delta: CapabilityDelta }) {
  const escalations = new Set(delta.escalations);
  const carried = delta.to.capabilities.filter((capability) => !escalations.has(capability));
  const emptyState = capabilityEmptyState(delta);

  return (
    <section class="flex flex-col gap-3 min-w-0">
      <SectionLabel as="h2">Capabilities</SectionLabel>
      <div class="flex flex-wrap items-center gap-2">
        {delta.escalations.map((capability) => (
          <Badge key={capability} tone="medium">
            + {CAPABILITY_LABELS[capability]}
          </Badge>
        ))}
        {carried.map((capability) => (
          <Badge key={capability} tone="neutral">
            {CAPABILITY_LABELS[capability]}
          </Badge>
        ))}
        {emptyState ? <Badge tone={emptyState.tone}>{emptyState.label}</Badge> : null}
      </div>
      <Muted class="m-0 text-[13px] leading-[1.55] max-w-[760px]">
        {capabilityDeltaDescription(delta)}
      </Muted>
    </section>
  );
}

export function capabilityDeltaDescription(delta: CapabilityDelta): string {
  const parts: string[] = [];
  if (delta.escalations.length) {
    parts.push(
      `This release adds ${listCapabilities(delta.escalations)} the previous version did not show.`,
    );
  }
  if (delta.reductions.length) {
    parts.push(`It no longer shows ${listCapabilities(delta.reductions)}.`);
  }
  if (!delta.from) {
    parts.push("No comparable baseline, so nothing can honestly be called an escalation.");
  } else if (delta.confident && !delta.escalations.length && !delta.reductions.length) {
    parts.push("No capability changes against the previous version.");
  }
  // The honesty constraint from the projection: an empty escalation list over
  // uninspected bytes must never read as "no escalation". Target-side gaps
  // still matter on a first release, where there is no baseline side to count.
  const uninspected = (delta.from?.uninspectedFiles ?? 0) + delta.to.uninspectedFiles;
  if (uninspected > 0) {
    parts.push(
      `Lower bound: ${uninspected} file ${uninspected === 1 ? "body" : "bodies"} exceeded the ` +
        "inspection tier and could carry capabilities this review cannot see.",
    );
  }
  parts.push("Derived from the same patterns the deterministic rules match; advisory only.");
  return parts.join(" ");
}

export function capabilityEmptyState(
  delta: CapabilityDelta,
): { tone: BadgeTone; label: string } | null {
  if (delta.to.capabilities.length) return null;
  return delta.to.complete
    ? { tone: "ok", label: "none detected" }
    : { tone: "neutral", label: "inspection incomplete" };
}

// A persisted scan's capability delta is bound to the baseline selected when
// that scan ran. The version picker can load another baseline for an ad-hoc
// comparison, but that response does not carry a replacement projection; hide
// the stale delta instead of relabeling it as evidence about the selected pair.
export function capabilityDeltaForComparison(
  delta: CapabilityDelta | null,
  isDefaultComparison: boolean,
): CapabilityDelta | null {
  return isDefaultComparison ? delta : null;
}

function listCapabilities(capabilities: Capability[]): string {
  const labels = capabilities.map((capability) => CAPABILITY_LABELS[capability]);
  if (labels.length === 1) return labels[0];
  return `${labels.slice(0, -1).join(", ")} and ${labels.at(-1)}`;
}
