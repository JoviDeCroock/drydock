import type { DependencyIntelVerdict } from "../../../server/lib/review/serialize";
import { Badge } from "../../components/Badge";
import { formatDateTimeExact } from "../../lib/format";

const INTEL_URL = "https://intel.aikido.dev/malware?ecosystem=npm";

export function DependencyIntel({ verdict }: { verdict: DependencyIntelVerdict }) {
  const malicious = verdict.status === "known_malware";
  const label = malicious
    ? "Known malware"
    : verdict.status === "no_known_malware"
      ? "No known malware match"
      : verdict.status === "unavailable"
        ? "Intel unavailable"
        : "Spec not checked";
  const detail = malicious
    ? verdict.matchedVersions?.includes("*")
      ? "Aikido lists all versions of the public npm package."
      : verdict.matchKind === "range"
        ? "This range admits malware versions listed for public npm; the installed version is unknown."
        : "This exact version is listed by Aikido for the public npm package."
    : verdict.status === "no_known_malware"
      ? "No match in the malware feed. This is not a safety verdict."
      : verdict.status === "unavailable"
        ? "The malware feed could not be checked."
        : "A registry version or semver range is needed to check this declaration.";

  return (
    <div class="flex flex-col gap-1 text-[11px] text-ink-muted">
      <div class="flex flex-wrap items-center gap-2">
        <Badge tone={malicious ? "high" : "neutral"}>{label}</Badge>
        <a href={INTEL_URL} target="_blank" rel="noreferrer" class="underline hover:text-ink">
          Aikido Intel
        </a>
        <span>advisory</span>
        {verdict.checkedAt ? (
          <time dateTime={verdict.checkedAt}>checked {formatDateTimeExact(verdict.checkedAt)}</time>
        ) : null}
      </div>
      <span>{detail}</span>
      {malicious && verdict.matchedVersions?.length ? (
        <code class="break-all">
          {verdict.packageName}: {verdict.matchedVersions.join(", ")}
          {(verdict.matchedVersionCount ?? 0) > verdict.matchedVersions.length
            ? ` (+${(verdict.matchedVersionCount ?? 0) - verdict.matchedVersions.length} more)`
            : ""}
        </code>
      ) : null}
    </div>
  );
}
