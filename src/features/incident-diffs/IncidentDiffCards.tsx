import { Card } from "../../components/Card";
import { packageDiffPath, type DiffSpec } from "../../lib/package-diff-path";

// Version pairs must exist on the public registry: npm unpublishes malicious
// releases, so the compromised bytes themselves usually cannot be diffed after
// an incident (ua-parser-js's cryptominer, event-stream, coa/rc, and the
// colors sabotage are all gone). Before adding a row, verify both versions
// still resolve AND that the pair surfaces findings — a card that opens a
// clean report undersells the review.
const INCIDENT_DIFFS: Array<DiffSpec & { note: string; caseStudyPath?: string }> = [
  {
    ecosystem: "npm",
    packageName: "node-ipc",
    fromVersion: "9.2.1",
    toVersion: "11.0.0",
    note: "a new runtime dependency appears: peacenotwar",
    caseStudyPath: "/incidents/node-ipc-peacenotwar",
  },
  {
    ecosystem: "npm",
    packageName: "semversyphus",
    fromVersion: "1.0.5",
    toVersion: "1.0.6",
    note: "a postinstall script appears — demo of the install-script rule",
  },
  {
    ecosystem: "npm",
    packageName: "es5-ext",
    fromVersion: "0.10.53",
    toVersion: "0.10.54",
    note: "a postinstall hook appears in a patch release, still live on npm",
    caseStudyPath: "/incidents/es5-ext-postinstall",
  },
];

/**
 * Live curated incident diffs — the no-account entry point to the product,
 * shared by the marketing landing and the /diff landing. Every card opens the
 * live diff the section promises; an incident with a write-up keeps it as a
 * quiet second link rather than as the card's destination.
 */
export function IncidentDiffCards() {
  return (
    <div class="grid grid-cols-1 md:grid-cols-3 gap-4">
      {INCIDENT_DIFFS.map((incident) => (
        <Card
          key={incident.packageName}
          as="article"
          padding="compact"
          hover="accent"
          class="relative flex flex-col gap-2"
        >
          <a
            href={packageDiffPath(
              incident.ecosystem,
              incident.packageName,
              incident.fromVersion,
              incident.toVersion,
            )}
            // Stretched over the card, so every highlighted pixel opens the
            // diff; the write-up link sits above it.
            class="flex flex-col gap-2 no-underline text-inherit after:absolute after:inset-0 after:content-['']"
          >
            <h2 class="text-base font-medium tracking-[-0.005em] m-0 break-all">
              {incident.packageName}
            </h2>
            <span class="font-mono text-[11px] text-ink-subtle">
              {incident.fromVersion} → {incident.toVersion}
            </span>
            <p class="text-[13px] text-ink-muted leading-[1.55] m-0">{incident.note}</p>
          </a>
          {incident.caseStudyPath ? (
            <a
              href={incident.caseStudyPath}
              class="relative z-10 self-start text-[12px] text-ink-subtle underline hover:text-ink"
            >
              Read the write-up
            </a>
          ) : null}
        </Card>
      ))}
    </div>
  );
}
