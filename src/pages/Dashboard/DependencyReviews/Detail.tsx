/**
 * One dependency review: every package version change the pull request
 * merges, grouped the way the check run groups them, with each bump's
 * verdict, the evidence behind it, and a link to its public diff. The check
 * run's details link lands here.
 *
 * Package names, versions, lockfile paths, rule ids, and finding reasons all
 * come from other people's packages and repositories. They render as text
 * only; the one href built from them is the diff path `packageDiffPath`
 * encodes.
 */
import type { ComponentChildren } from "preact";
import { useComputed, useModel, useSignal } from "@preact/signals";
import { Show } from "@preact/signals/utils";
import { useLocation, useRoute } from "preact-iso";
import { formatDateTime } from "../../../lib/format";
import { packageDiffPath } from "../../../lib/package-diff-path";
import { AppHeaderActions } from "../../../features/account/AppHeaderActions";
import { useAuthedDashboardSession } from "../../../features/account/useAuthedDashboardSession";
import { usePinnedOrganization } from "../../../features/account/usePinnedOrganization";
import {
  DEPENDENCY_REVIEWS_PATH,
  HOLD_REASON_TEXT,
  UNREVIEWED_TEXT,
  dependencyReviewPath,
  pullRequestUrl,
  reviewState,
} from "../../../features/dependency-review/wording";
import {
  DependencyReviewDetailModel,
  type DependencyReview,
  type ReviewedBump,
} from "../../../models/dependency-review";
import { OrganizationModel } from "../../../models/organization";
import type {
  BumpEvidence,
  BumpVerdict,
  HoldReason,
} from "../../../../server/lib/dependency-review/types";
import { Alert } from "../../../components/Alert";
import { Badge, severityTone } from "../../../components/Badge";
import { LinkButton } from "../../../components/Button";
import { Card } from "../../../components/Card";
import { LoadingState } from "../../../components/Loading";
import { PageShell } from "../../../components/PageShell";
import { EmptyLine, MonoDetail, Muted, SectionLabel } from "../../../components/Typography";

export default function DependencyReviewDetailPage() {
  const location = useLocation();
  const route = useRoute();
  const id = route.params.id ?? "";
  // A review belongs to one organization and its address names it, like a
  // scan review: pinning `?org=` reads that organization's review strictly.
  const organizationId = location.query.org || null;
  usePinnedOrganization(organizationId);
  return (
    <DependencyReviewView
      key={`${organizationId ?? ""}:${id}`}
      id={id}
      organizationId={organizationId}
    />
  );
}

type Membership = "resolving" | "member" | "not_member" | "unavailable";

function DependencyReviewView({
  id,
  organizationId,
}: {
  id: string;
  organizationId: string | null;
}) {
  const location = useLocation();
  const model = useModel(() => new DependencyReviewDetailModel(id));
  const organizations = useModel(OrganizationModel);
  const membership = useSignal<Membership>("resolving");
  const sessionChecked = useAuthedDashboardSession({
    rememberReturnUrl: false,
    onReady: async (_session, isCancelled) => {
      await organizations.load();
      if (isCancelled()) return;
      // Without the membership list an outage would read as "not a member".
      if (organizations.error.peek()) {
        membership.value = "unavailable";
        return;
      }
      if (
        organizationId &&
        !organizations.organizations.peek().some((org) => org.id === organizationId)
      ) {
        membership.value = "not_member";
        return;
      }
      membership.value = "member";
      await model.load();
      // An address without `?org=` read the remembered organization; name the
      // one that holds the review so a copied link keeps working.
      const reviewOrganization = model.review.peek()?.organizationId;
      if (!isCancelled() && !organizationId && reviewOrganization) {
        location.route(dependencyReviewPath(id, reviewOrganization), true);
      }
    },
  });

  const ready = useComputed(
    () => sessionChecked.value && membership.value === "member" && model.loaded.value,
  );

  return (
    <PageShell
      headerActions={
        <AppHeaderActions
          current="dependencies"
          organizations={organizations}
          // The review belongs to its organization, so switching leaves for
          // the new organization's list rather than re-reading this one.
          onActivate={(next) => {
            if (next === (organizationId ?? model.review.peek()?.organizationId)) return;
            if (organizations.activate(next)) location.route(DEPENDENCY_REVIEWS_PATH);
          }}
          onCreate={async (name) => {
            if (await organizations.create(name)) location.route(DEPENDENCY_REVIEWS_PATH);
          }}
        />
      }
    >
      <a
        href={DEPENDENCY_REVIEWS_PATH}
        class="text-[13px] text-ink-muted hover:text-ink no-underline self-start"
      >
        ← Dependency reviews
      </a>

      <Show when={() => membership.value === "not_member"}>
        <Alert tone="critical">
          You are not a member of the organization this link names, so its dependency review is not
          shown.
        </Alert>
      </Show>
      <Show when={() => (membership.value === "unavailable" ? organizations.error.value : null)}>
        {(message) => <Alert tone="critical">{message}</Alert>}
      </Show>

      <Show
        when={ready}
        fallback={
          <Show when={() => membership.value === "resolving" || membership.value === "member"}>
            <LoadingState
              title="Opening dependency review"
              detail="confirming session · reading review"
            />
          </Show>
        }
      >
        {() => <ReviewBody model={model} />}
      </Show>
    </PageShell>
  );
}

function ReviewBody({ model }: { model: InstanceType<typeof DependencyReviewDetailModel> }) {
  const review = model.review.value;
  const error = model.error.value;
  if (model.notFound.value) {
    return (
      <Card>
        <EmptyLine>This dependency review does not exist in this organization.</EmptyLine>
      </Card>
    );
  }
  if (error) return <Alert tone="critical">{error}</Alert>;
  if (!review) return null;
  return <ReviewReport review={review} bumps={model.bumps.value} />;
}

function ReviewReport({ review, bumps }: { review: DependencyReview; bumps: ReviewedBump[] }) {
  const groups = groupBumps(bumps);
  const pullUrl = pullRequestUrl(review.repositoryFullName, review.pullNumber);
  const state = reviewState(review);
  return (
    <>
      <header class="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between sm:gap-6">
        <div class="flex flex-col gap-2 min-w-0">
          <h1 class="text-2xl font-semibold tracking-[-0.015em] m-0 break-words">
            {review.repositoryFullName} #{review.pullNumber}
          </h1>
          <MonoDetail
            parts={[
              `by ${review.authorLogin}`,
              `head ${review.headSha.slice(0, 7)}`,
              `${review.bumpCount} ${review.bumpCount === 1 ? "update" : "updates"}`,
              formatDateTime(review.completedAt ?? review.createdAt),
            ]}
          />
        </div>
        {pullUrl ? (
          <LinkButton
            href={pullUrl}
            target="_blank"
            rel="noreferrer"
            variant="secondary"
            class="shrink-0 self-start"
          >
            Open pull request ↗
          </LinkButton>
        ) : null}
      </header>

      <ReviewHeadline review={review} state={state} />

      {bumps.length < review.bumpCount ? (
        <Muted class="text-[13px] m-0">
          Showing the first {bumps.length} of {review.bumpCount} updates.
        </Muted>
      ) : null}

      {state !== "reviewing" && state !== "failed" && bumps.length === 0 ? (
        <Card>
          <EmptyLine>This pull request changes no package version Drydock can review.</EmptyLine>
        </Card>
      ) : null}

      <BumpGroup title="Held for review" bumps={groups.held} />
      <BumpGroup
        title={review.approvedByLogin ? `Approved by ${review.approvedByLogin}` : "Approved"}
        bumps={groups.approved}
      />
      <BumpGroup title="Not reviewed" bumps={groups.unreviewed} />
      <BumpGroup title="New packages" bumps={groups.added} />
      <BumpGroup title="Clear" bumps={groups.clear} />
    </>
  );
}

// The one sentence that says where the pull request stands. Held and the
// in-between states are Alerts because they ask for (or explain) a wait; the
// settled ones are a plain line.
function ReviewHeadline({ review, state }: { review: DependencyReview; state: string }) {
  if (state === "reviewing") {
    return (
      <Alert tone="info">Drydock is reviewing this pull request; reload for the result.</Alert>
    );
  }
  if (state === "failed") {
    return (
      <Alert tone="critical">
        Drydock could not finish this review. Re-run the check on the pull request to try again.
      </Alert>
    );
  }
  if (state === "held") {
    return (
      <Alert tone="warn">
        {review.heldCount} of {review.bumpCount}{" "}
        {review.bumpCount === 1 ? "update is" : "updates are"} held. Read the diffs, then approve on
        the pull request's Drydock dependency review check; anyone with write access to the
        repository can approve.
      </Alert>
    );
  }
  if (state === "approved") {
    return (
      <Muted class="text-[14px] m-0">
        Held updates approved
        {review.approvedByLogin ? ` by ${review.approvedByLogin}` : ""}
        {review.approvedAt ? ` ${formatDateTime(review.approvedAt)}` : ""}.
      </Muted>
    );
  }
  return (
    <Muted class="text-[14px] m-0">
      {review.bumpCount === 1 ? "The update is" : `All ${review.bumpCount} updates are`} clear.
    </Muted>
  );
}

function groupBumps(bumps: ReviewedBump[]) {
  const groups = {
    held: [] as ReviewedBump[],
    approved: [] as ReviewedBump[],
    unreviewed: [] as ReviewedBump[],
    added: [] as ReviewedBump[],
    clear: [] as ReviewedBump[],
  };
  for (const bump of bumps) {
    const { status } = bump.verdict;
    if (status === "hold") (bump.approved ? groups.approved : groups.held).push(bump);
    else if (status === "unreviewed") groups.unreviewed.push(bump);
    else if (status === "new-package") groups.added.push(bump);
    else groups.clear.push(bump);
  }
  return groups;
}

function BumpGroup({ title, bumps }: { title: string; bumps: ReviewedBump[] }) {
  if (bumps.length === 0) return null;
  return (
    <section class="flex flex-col gap-3">
      <SectionLabel as="h2" aside={bumps.length}>
        {title}
      </SectionLabel>
      <Card padding="none">
        <ul class="m-0 p-0 list-none">
          {bumps.map((bump, index) => (
            <BumpRow key={`${bump.bump.lockfilePath}:${bump.bump.name}:${index}`} reviewed={bump} />
          ))}
        </ul>
      </Card>
    </section>
  );
}

function BumpRow({ reviewed }: { reviewed: ReviewedBump }) {
  const { bump, verdict } = reviewed;
  const evidence = verdictEvidence(verdict);
  const diffHref = bump.fromVersion
    ? packageDiffPath(bump.ecosystem, bump.name, bump.fromVersion, bump.toVersion)
    : null;
  const reason = verdictReason(verdict, evidence);
  return (
    <li class="border-b border-border last:border-b-0 px-5 py-4 flex flex-col gap-2 min-w-0">
      <div class="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <div class="flex flex-wrap items-baseline gap-x-3 gap-y-1 min-w-0">
          <span class="font-mono text-[14px] font-medium text-ink break-all">{bump.name}</span>
          <span class="font-mono text-[12px] text-ink-muted break-all">
            {bump.fromVersion ? `${bump.fromVersion} → ${bump.toVersion}` : `new ${bump.toVersion}`}
          </span>
        </div>
        {diffHref ? (
          <a href={diffHref} class="text-[13px] shrink-0">
            View diff →
          </a>
        ) : null}
      </div>
      <MonoDetail
        parts={[
          bump.direct ? "direct" : "transitive",
          bump.ecosystem,
          bump.lockfilePath,
          evidence ? `release risk ${evidence.releaseRisk}` : null,
          evidence ? `${evidence.filesAdded} added` : null,
          evidence ? `${evidence.filesRemoved} removed` : null,
          evidence ? `${evidence.filesChanged} changed` : null,
        ]}
      />
      {reason ? <p class="m-0 text-[13px] text-ink">{reason}</p> : null}
      {evidence && evidence.findings.length > 0 ? <FindingList evidence={evidence} /> : null}
    </li>
  );
}

function FindingList({ evidence }: { evidence: BumpEvidence }) {
  const more = evidence.findingCount - evidence.findings.length;
  return (
    <ul class="m-0 p-0 list-none flex flex-col gap-1.5">
      {evidence.findings.map((finding, index) => (
        <li key={index} class="flex flex-wrap items-baseline gap-x-2 gap-y-1 min-w-0 text-[13px]">
          <Badge tone={severityTone(finding.severity)}>{finding.severity}</Badge>
          <span class="font-mono text-[12px] text-ink-muted break-all">
            {finding.ruleId ?? "unnamed rule"} · {finding.file}
          </span>
          <span class="text-ink break-words min-w-0">{finding.reason}</span>
        </li>
      ))}
      {more > 0 ? (
        <Caption>
          {more} more release {more === 1 ? "finding" : "findings"} in the diff
        </Caption>
      ) : null}
    </ul>
  );
}

function Caption({ children }: { children: ComponentChildren }) {
  return <li class="font-mono text-[11px] text-ink-subtle">{children}</li>;
}

function verdictEvidence(verdict: BumpVerdict): BumpEvidence | null {
  if (verdict.status === "clear") return verdict.evidence;
  if (verdict.status === "hold") return verdict.evidence;
  return null;
}

// How many of a capability the bump adds, for the reasons that count one.
const REASON_COUNT: Partial<Record<HoldReason, (evidence: BumpEvidence) => number>> = {
  "install-script-added": (e) => e.installScriptsAdded,
  "install-script-changed": (e) => e.installScriptsChanged,
  "native-binary-added": (e) => e.nativeBinariesAdded,
  "dependency-added": (e) => e.dependenciesAdded,
  "bin-command-added": (e) => e.binCommandsAdded,
  "uninspected-files": (e) => e.uninspectedFiles,
};

function verdictReason(verdict: BumpVerdict, evidence: BumpEvidence | null): string | null {
  if (verdict.status === "unreviewed") return sentence(UNREVIEWED_TEXT[verdict.unreviewed]);
  if (verdict.status !== "hold") return null;
  const reasons = verdict.reasons.map((reason) => {
    if (reason === "unreviewed" && verdict.unreviewed) {
      return `${HOLD_REASON_TEXT.unreviewed} (${UNREVIEWED_TEXT[verdict.unreviewed]})`;
    }
    const count = evidence ? (REASON_COUNT[reason]?.(evidence) ?? 0) : 0;
    return count > 1 ? `${HOLD_REASON_TEXT[reason]} (${count})` : HOLD_REASON_TEXT[reason];
  });
  return reasons.length ? sentence(reasons.join("; ")) : null;
}

function sentence(text: string): string {
  return `${text.charAt(0).toUpperCase()}${text.slice(1)}.`;
}
