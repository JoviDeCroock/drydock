import type { ComponentChildren } from "preact";
import type { ReleaseProvenance, StagedArtifactIntegrity } from "../../../../server/types";
import { ecosystemLabel } from "../../../../server/lib/ecosystems/labels";
import { parseStagedArtifactIntegrity } from "../../../../server/lib/ecosystems/artifact-integrity";
import { Badge } from "../../../components/Badge";
import { LinkButton } from "../../../components/Button";
import { PackageJsonDiffView } from "../../../components/PackageJsonDiffView";
import { EmptyLine, MonoLabel, SectionLabel } from "../../../components/Typography";
import type { PersistedSummary } from "./types";

export function PersistedReportSections({ summary }: { summary: PersistedSummary }) {
  const artifactIntegrity = parseStagedArtifactIntegrity(summary.stagedPublish?.artifactIntegrity);
  const staged = readAtpmStagedDetails(summary.stagedPublish);
  return (
    <section class="flex flex-col gap-6">
      <ReportSection title="Manifest changes">
        {summary.packageJsonDiff ? (
          <PackageJsonDiffView
            diff={summary.packageJsonDiff}
            // PyPI dependencies are not npm packages, so the public npm diff
            // view cannot show them; npm and VS Code manifests both resolve
            // their dependencies from the npm registry. An atpm dependency
            // spelled `@handle/name` resolves on npm to a scope someone else
            // owns, so it links nothing rather than something confidently
            // wrong. Scans persisted before either field existed are npm.
            linkDependencyDiffs={!["pypi", "atpm"].includes(stagedEcosystem(summary))}
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

      {staged ? (
        <ReportSection title="Staged candidate">
          <AtpmStagedView staged={staged} />
        </ReportSection>
      ) : null}

      {/* The reviewer's narrative verdict used to sit here, at the bottom of the
          page. It moved up to `ReviewerSummary`, directly under the
          Recommendation — it answers "what is this release?", which is the
          question the page opens with, not a footnote to it. */}

      {artifactIntegrity ? (
        <ReportSection title="Artifact verification">
          <ArtifactIntegrityView integrity={artifactIntegrity} />
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

function ArtifactIntegrityView({ integrity }: { integrity: StagedArtifactIntegrity }) {
  const description =
    integrity.status === "verified"
      ? "The reviewed tarball bytes match the SHA-1 npm recorded for this staged release."
      : integrity.status === "mismatch"
        ? "The reviewed tarball bytes do not match npm's stage record. Treat this report as describing a different artifact."
        : integrity.reason === "declared-digest-missing"
          ? "npm did not provide a valid staged-tarball digest, so Drydock could not bind this review to the staged bytes."
          : integrity.reason === "stage-record-confirmation-unavailable"
            ? "Drydock saw a digest mismatch but could not confirm it against a fresh stage record, so this review remains unverified."
            : "Drydock could not hash the complete tarball stream, so this review is not bound to npm's stage record.";
  // A registry that published no digest is an absence of evidence, and the
  // report must not tone it as a warning about the release: that is the same
  // mistake as raising a finding for it. Only a digest Drydock failed to
  // compute — something on our side went wrong — reads as amber.
  const tone =
    integrity.status === "verified"
      ? "ok"
      : integrity.status === "mismatch"
        ? "critical"
        : integrity.reason === "declared-digest-missing"
          ? "neutral"
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

/**
 * The ecosystem a persisted staged review belongs to. Gate scans record it
 * inside their provenance block and staged reviews alongside it, so read both
 * rather than making the renderer care which kind of scan this was.
 */
function stagedEcosystem(summary: PersistedSummary): string {
  const staged = summary.stagedPublish;
  if (typeof staged?.ecosystem === "string") return staged.ecosystem;
  return staged?.provenance?.ecosystem ?? "npm";
}

interface AtpmStagedDetails {
  approveId: string;
  uri: string;
  provenance: { status: string; repository?: string; reason?: string };
}

/**
 * Read the atpm staged block out of a persisted summary.
 *
 * Persisted blobs are `unknown` by contract — they were written by an older
 * deployment, or by a different adapter — so every field is narrowed before it
 * reaches the DOM rather than trusted because a TypeScript type said so.
 */
function readAtpmStagedDetails(
  staged: PersistedSummary["stagedPublish"],
): AtpmStagedDetails | null {
  if (!staged || staged.ecosystem !== "atpm") return null;
  const approveId = typeof staged.approveId === "string" ? staged.approveId : null;
  const uri = typeof staged.uri === "string" ? staged.uri : null;
  if (!approveId || !uri) return null;

  const raw = staged.buildProvenance;
  const state = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const status = typeof state.status === "string" ? state.status : "not-evaluated";
  const build =
    state.provenance && typeof state.provenance === "object"
      ? (state.provenance as Record<string, unknown>)
      : null;
  return {
    approveId,
    uri,
    provenance: {
      status,
      ...(typeof build?.sourceRepository === "string"
        ? { repository: build.sourceRepository }
        : {}),
      ...(typeof state.reason === "string" ? { reason: state.reason } : {}),
    },
  };
}

/**
 * What a reviewer needs to act on an atpm candidate.
 *
 * Drydock never approves an atpm release — approval is a write to the
 * publisher's own repository, and nothing here holds a credential for it. So
 * the useful thing this section can do is name the exact candidate that was
 * reviewed, in the spelling the tool that approves it takes.
 */
function AtpmStagedView({ staged }: { staged: AtpmStagedDetails }) {
  return (
    <div class="flex flex-col gap-3">
      <dl class="flex flex-col gap-1 m-0">
        <DetailRow label="Approve" value={`npm stage approve ${staged.approveId}`} />
        <DetailRow label="Record" value={staged.uri} />
        <DetailRow
          label="Built by"
          value={
            staged.provenance.status === "verified"
              ? (staged.provenance.repository ?? "verified build")
              : staged.provenance.status === "invalid"
                ? `attestation does not verify: ${staged.provenance.reason ?? "unreadable"}`
                : "no verified build attestation"
          }
        />
      </dl>
      <div class="flex flex-wrap items-center gap-2">
        <LinkButton
          href="https://atpm.dev/dash/stage"
          target="_blank"
          rel="noreferrer"
          variant="secondary"
          size="sm"
        >
          Approve on atpm
        </LinkButton>
      </div>
      <EmptyLine>
        Approving publishes these exact bytes: the candidate is pinned by content address, so
        nothing is rebuilt or re-uploaded between this review and the release. Drydock does not
        approve on your behalf — it holds no credential for your repository, so the last step stays
        yours.
      </EmptyLine>
    </div>
  );
}

function DetailRow({ label, value }: { label: string; value: string }) {
  return (
    <div class="flex flex-wrap items-baseline gap-x-2">
      <MonoLabel as="dt" class="min-w-[72px]">
        {label}
      </MonoLabel>
      <dd class="font-mono text-[12px] text-ink-muted m-0 break-all">{value}</dd>
    </div>
  );
}
