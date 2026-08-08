import { Card } from "../../components/Card";
import { packageDiffPath, type DiffSpec } from "../../lib/package-diff-path";

// Version pairs must exist on the public registry: npm unpublishes malicious
// releases, so the compromised bytes themselves usually cannot be diffed after
// an incident (ua-parser-js's cryptominer, event-stream, coa/rc, and the
// colors sabotage are all gone). Before adding a row, verify both versions
// still resolve AND that the pair surfaces findings — a card that opens a
// clean report undersells the review.
const INCIDENT_DIFFS: Array<DiffSpec & { note: string }> = [
  {
    ecosystem: "npm",
    packageName: "node-ipc",
    fromVersion: "9.2.1",
    toVersion: "11.0.0",
    note: "protestware arrives as a new dependency (peacenotwar)",
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
    note: "real protestware: a postinstall hook lands in a routine patch, still live on npm",
  },
];

/**
 * Live curated incident diffs — the no-account entry point to the product,
 * shared by the marketing landing and the /diff landing.
 */
export function IncidentDiffCards() {
  return (
    <div class="grid grid-cols-1 md:grid-cols-3 gap-4">
      {INCIDENT_DIFFS.map((incident) => (
        <Card
          key={incident.packageName}
          as="article"
          class="p-5 flex flex-col gap-2 hover:border-accent transition-colors duration-150"
        >
          <a
            href={packageDiffPath(
              incident.ecosystem,
              incident.packageName,
              incident.fromVersion,
              incident.toVersion,
            )}
            class="flex flex-col gap-2 no-underline text-inherit"
          >
            <h2 class="text-base font-medium tracking-[-0.005em] m-0 break-all">
              {incident.packageName}
            </h2>
            <span class="font-mono text-[11px] text-ink-subtle">
              {incident.fromVersion} → {incident.toVersion}
            </span>
            <p class="text-[13px] text-ink-muted leading-[1.55] m-0">{incident.note}</p>
          </a>
        </Card>
      ))}
    </div>
  );
}
