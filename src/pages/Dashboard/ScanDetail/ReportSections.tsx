import type { ComponentChildren } from "preact";
import type { ReleaseProvenance } from "../../../../server/types";
import { ecosystemLabel } from "../../../../server/lib/ecosystems/labels";
import {
  parseStagedTarballIntegrity,
  type StagedTarballIntegrity,
} from "../../../../server/lib/ecosystems/npm/tarball-integrity";
import { Badge } from "../../../components/Badge";
import { PackageJsonDiffView } from "../../../components/PackageJsonDiffView";
import { EmptyLine, SectionLabel } from "../../../components/Typography";
import type { PersistedSummary } from "./types";

export function PersistedReportSections({ summary }: { summary: PersistedSummary }) {
  const tarballIntegrity = parseStagedTarballIntegrity(summary.stagedPublish?.tarballIntegrity);
  return (
    <section class="flex flex-col gap-6">
      <ReportSection title="Manifest changes">
        {summary.packageJsonDiff ? (
          <PackageJsonDiffView
            diff={summary.packageJsonDiff}
            // PyPI dependencies are not npm packages, so the public npm diff
            // view cannot show them; npm and VS Code manifests both resolve
            // their dependencies from the npm registry. Scans persisted before
            // provenance carried an ecosystem are npm.
            linkDependencyDiffs={summary.stagedPublish?.provenance?.ecosystem !== "pypi"}
          />
        ) : (
          <EmptyLine>No manifest changes were saved for this review.</EmptyLine>
        )}
      </ReportSection>

      {summary.stagedPublish?.provenance?.artifacts?.length ? (
        <ReportSection title="Provenance">
          <ProvenanceView provenance={summary.stagedPublish.provenance} />
        </ReportSection>
      ) : null}

      {/* The reviewer's narrative verdict used to sit here, at the bottom of the
          page. It moved up to `ReviewerSummary`, directly under the
          Recommendation — it answers "what is this release?", which is the
          question the page opens with, not a footnote to it. */}

      {tarballIntegrity ? (
        <ReportSection title="Artifact verification">
          <TarballIntegrityView integrity={tarballIntegrity} />
        </ReportSection>
      ) : null}
    </section>
  );
}

function ReportSection({
  title,
  children,
  class: className,
}: {
  title: string;
  children: ComponentChildren;
  class?: string;
}) {
  return (
    <section class={`flex flex-col gap-3 min-w-0 ${className || ""}`}>
      <SectionLabel as="h2">{title}</SectionLabel>
      {children}
    </section>
  );
}

function TarballIntegrityView({ integrity }: { integrity: StagedTarballIntegrity }) {
  const description =
    integrity.status === "verified"
      ? "The reviewed tarball bytes match the SHA-1 npm recorded for this staged release."
      : integrity.status === "mismatch"
        ? "The reviewed tarball bytes do not match npm's stage record. Treat this report as describing a different artifact."
        : integrity.reason === "declared-digest-missing"
          ? "npm did not provide a valid staged-tarball digest, so Drydock could not bind this review to the staged bytes."
          : "Drydock could not hash the complete tarball stream, so this review is not bound to npm's stage record.";
  const tone =
    integrity.status === "verified"
      ? "ok"
      : integrity.status === "mismatch"
        ? "critical"
        : "medium";

  return (
    <div class="flex flex-col gap-3">
      <div class="flex flex-wrap gap-2">
        <Badge tone={tone}>{integrity.status}</Badge>
        <Badge tone="neutral">{integrity.algorithm}</Badge>
      </div>
      <p class="m-0 text-[13px] leading-[1.6] text-ink-muted">{description}</p>
      <div class="border border-border rounded-lg overflow-hidden divide-y divide-border">
        <DigestRow label="npm recorded" value={integrity.declared} />
        <DigestRow label="reviewed bytes" value={integrity.computed} />
      </div>
    </div>
  );
}

function DigestRow({ label, value }: { label: string; value: string | null }) {
  return (
    <div class="flex flex-col gap-1.5 px-3 py-2.5 min-w-0">
      <span class="font-mono text-[11px] uppercase tracking-[0.1em] text-ink-subtle">{label}</span>
      {value ? (
        <code class="font-mono text-[11px] text-ink-muted break-all min-w-0">{value}</code>
      ) : (
        <span class="text-[12px] text-ink-muted">not available</span>
      )}
    </div>
  );
}

function ProvenanceView({ provenance }: { provenance: ReleaseProvenance }) {
  const ecosystem = ecosystemLabel(provenance.ecosystem);
  return (
    <div class="flex flex-col gap-3">
      <p class="m-0 text-[13px] leading-[1.6] text-ink-muted">
        SHA-256 digests recomputed from the reviewed {ecosystem} release bytes. The publish job
        re-verifies these against the immutable artifact before upload, so the bytes reviewed are
        the bytes published.
      </p>
      <div class="border border-border rounded-lg overflow-hidden divide-y divide-border">
        {provenance.artifacts.map((artifact) => (
          <div key={artifact.path} class="flex flex-col gap-1.5 px-3 py-2.5 min-w-0">
            <div class="flex flex-wrap items-center gap-2 min-w-0">
              <Badge tone="neutral">{artifact.kind}</Badge>
              <code class="font-mono text-[12px] text-ink break-all min-w-0">{artifact.path}</code>
            </div>
            <div class="flex items-baseline gap-2 min-w-0">
              <span class="font-mono text-[11px] uppercase tracking-[0.1em] text-ink-subtle flex-shrink-0">
                sha256
              </span>
              <code class="font-mono text-[11px] text-ink-muted break-all min-w-0">
                {artifact.sha256}
              </code>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
