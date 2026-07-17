import type {
  IntentEnvelope,
  IntentEnvelopeTier,
  RebuildAttestation,
} from "../../../../server/types";
import { Badge, type BadgeTone } from "../../../components/Badge";
import { SectionLabel } from "../../../components/Typography";

// Advisory source-binding row rendered under the recommendation. The envelope
// never changes risk, so tier tones stay informational (ok / info / neutral)
// rather than borrowing severity colors. Scans persisted before the envelope
// existed render nothing (the parent passes null). When the organization opted
// into rebuild attestation, its outcome renders as a second row in the same
// section — it is the empirical check of the binding the tier describes.
export function IntentEnvelopeSection({
  envelope,
  rebuild,
}: {
  envelope: IntentEnvelope;
  rebuild?: RebuildAttestation | null;
}) {
  return (
    <section class="flex flex-col gap-3 min-w-0">
      <SectionLabel>Source binding</SectionLabel>
      <div class="flex flex-wrap items-center gap-x-3 gap-y-2">
        <Badge tone={tierTone(envelope.tier)}>{envelope.tier}</Badge>
        <span class="text-[13px] leading-[1.55] text-ink-muted min-w-0">
          {tierDescription(envelope)}
        </span>
      </div>
      {envelope.signals.length ? (
        <ul class="list-none p-0 m-0 flex flex-col gap-2">
          {envelope.signals.map((signal, index) => (
            <li
              key={`${signal.kind}-${index}`}
              class="grid grid-cols-[132px_minmax(0,1fr)] gap-3 text-[13px]"
            >
              <span class="font-mono text-[11px] uppercase tracking-[0.1em] text-ink-subtle">
                {signal.kind}
              </span>
              <span class="min-w-0 text-ink-muted break-words">{signal.detail}</span>
            </li>
          ))}
        </ul>
      ) : null}
      {rebuild ? <RebuildAttestationRow rebuild={rebuild} /> : null}
    </section>
  );
}

const MAX_DIVERGENT_PATHS_SHOWN = 5;

function RebuildAttestationRow({ rebuild }: { rebuild: RebuildAttestation }) {
  const divergent = rebuild.comparison?.divergentPaths ?? [];
  const missing = rebuild.comparison?.missingFromRebuild ?? [];
  const shown = [...missing, ...divergent].slice(0, MAX_DIVERGENT_PATHS_SHOWN);
  const totalDiffering =
    (rebuild.comparison?.divergentPaths.length ?? 0) +
    (rebuild.comparison?.missingFromRebuild.length ?? 0) +
    (rebuild.comparison?.extraInRebuild.length ?? 0);
  return (
    <div class="flex flex-col gap-2 min-w-0">
      <div class="flex flex-wrap items-center gap-x-3 gap-y-2">
        <Badge tone={rebuildTone(rebuild.status)}>{rebuildBadgeLabel(rebuild.status)}</Badge>
        <span class="text-[13px] leading-[1.55] text-ink-muted min-w-0">
          {rebuildDescription(rebuild, totalDiffering)}
        </span>
      </div>
      {shown.length ? (
        <ul class="list-none p-0 m-0 flex flex-col gap-1">
          {shown.map((path) => (
            <li key={path} class="font-mono text-[12px] text-ink-muted break-all">
              {path}
            </li>
          ))}
          {totalDiffering > shown.length ? (
            <li class="text-[12px] text-ink-subtle">
              and {totalDiffering - shown.length} more differing files
            </li>
          ) : null}
        </ul>
      ) : null}
    </div>
  );
}

function rebuildTone(status: RebuildAttestation["status"]): BadgeTone {
  if (status === "byte-identical" || status === "file-identical") return "ok";
  if (status === "diverged") return "info";
  return "neutral";
}

function rebuildBadgeLabel(status: RebuildAttestation["status"]): string {
  if (status === "byte-identical" || status === "file-identical") return "reproduced";
  if (status === "diverged") return "diverged";
  if (status === "pending") return "rebuild queued";
  return "not reproduced";
}

function rebuildDescription(rebuild: RebuildAttestation, totalDiffering: number): string {
  const source = rebuild.ref
    ? `${repositoryDisplayName(rebuild.plan?.repository ?? null) ?? "the declared repository"} at ${rebuild.ref.kind === "git-head" ? rebuild.ref.value.slice(0, 12) : rebuild.ref.value}`
    : (repositoryDisplayName(rebuild.plan?.repository ?? null) ?? "the declared repository");
  if (rebuild.status === "byte-identical") {
    return `Rebuilt from ${source} — the staged tarball matches byte for byte.`;
  }
  if (rebuild.status === "file-identical") {
    return `Rebuilt from ${source} — every packed file matches; only tarball metadata differs.`;
  }
  if (rebuild.status === "diverged") {
    return `Rebuild from ${source} differs from the staged artifact in ${totalDiffering} ${
      totalDiffering === 1 ? "file" : "files"
    } — informational, not a risk signal.`;
  }
  if (rebuild.status === "pending") {
    return "A rebuild from the declared repository is queued to verify this artifact.";
  }
  const reason = rebuild.signals[0]?.detail;
  return reason
    ? `The rebuild could not verify this artifact (${reason}).`
    : "The rebuild could not verify this artifact.";
}

function tierTone(tier: IntentEnvelopeTier): BadgeTone {
  if (tier === "attested") return "ok";
  if (tier === "declared") return "info";
  return "neutral";
}

function tierDescription(envelope: IntentEnvelope): string {
  if (envelope.tier === "attested") {
    const repoName = repositoryDisplayName(envelope.repository);
    return repoName
      ? `Built and held by a GitHub workflow gate for ${repoName}.`
      : "Built and held by a GitHub workflow gate.";
  }
  if (envelope.tier === "declared") {
    return envelope.repository
      ? `Package declares repository ${envelope.repository} — binding is unverified.`
      : "Package declares a repository — binding is unverified.";
  }
  return "No repository binding — the artifact cannot be tied to reviewed source.";
}

// "https://github.com/owner/repo" → "owner/repo" for the one-liner; other
// hosts keep the full URL so the forge stays visible.
function repositoryDisplayName(repository: string | null): string | null {
  if (!repository) return null;
  const match = /^https:\/\/github\.com\/(.+)$/.exec(repository);
  return match ? match[1] : repository;
}
