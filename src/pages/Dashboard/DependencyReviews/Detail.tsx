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
  checkRunUrl,
  hasUnreadContent,
  dependencyAddedText,
  holdReasonPhrases,
  REPINNED_TEXT,
  REPLACES_PRIVATE_TEXT,
  unreadContentText,
  unreviewedText,
  dependencyReviewPath,
  pullRequestUrl,
  reviewState,
  type ReviewState,
} from "../../../features/dependency-review/wording";
import {
  DependencyReviewDetailModel,
  type DependencyReview,
  type DependencyReviewCoverage,
  type ReviewedBump,
} from "../../../models/dependency-review";
import { OrganizationModel } from "../../../models/organization";
import { MAX_STORED_BUMPS } from "../../../../server/lib/dependency-review/render";
import type {
  BumpEvidence,
  BumpVerdict,
  DependencyBump,
  HoldReason,
} from "../../../../server/lib/dependency-review/types";
import { Alert } from "../../../components/Alert";
import { Badge, severityTone } from "../../../components/Badge";
import { Button, LinkButton } from "../../../components/Button";
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
  // A failed refresh keeps the review already read; its error shows above.
  return (
    <>
      {error ? <Alert tone="critical">{error}</Alert> : null}
      {review ? <ReviewReport model={model} review={review} bumps={model.bumps.value} /> : null}
    </>
  );
}

function ReviewReport({
  model,
  review,
  bumps,
}: {
  model: InstanceType<typeof DependencyReviewDetailModel>;
  review: DependencyReview;
  bumps: ReviewedBump[];
}) {
  const groups = groupBumps(bumps);
  const pullUrl = pullRequestUrl(review.repositoryFullName, review.pullNumber);
  const checkUrl = checkRunUrl(review.repositoryFullName, review.pullNumber, review.checkRunId);
  const state = reviewState(review);
  const settled = state === "held" || state === "approved" || state === "clear";
  const coverage = model.coverage.value;
  const partial = !coverage.listingComplete || coverage.unreadLockfiles.length > 0;
  const approvable = model.approvable.value;
  const newerReviewId = model.newerReviewId.value;
  // The check is where a held review is approved and a failed one re-run, so
  // it leads in those states; the pull request is the way back otherwise.
  const checkAction =
    state === "held" && approvable
      ? {
          label: "Approve on GitHub ↗",
          // Held on unread files alone, Approve accepts what nobody read: it
          // stays available but doesn't lead.
          variant: review.heldCount > 0 ? ("primary" as const) : ("secondary" as const),
        }
      : state === "failed"
        ? { label: "Re-run on GitHub ↗", variant: "secondary" as const }
        : null;
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
              // A count is only a result once the review settled on full coverage.
              settled && !(partial && review.bumpCount === 0)
                ? `${review.bumpCount} ${review.bumpCount === 1 ? "update" : "updates"}`
                : null,
              formatDateTime(review.completedAt ?? review.createdAt),
            ]}
          />
        </div>
        <div class="flex flex-wrap gap-2 shrink-0 self-start">
          {checkAction && checkUrl ? (
            <LinkButton
              href={checkUrl}
              target="_blank"
              rel="noreferrer"
              variant={checkAction.variant}
            >
              {checkAction.label}
            </LinkButton>
          ) : null}
          {pullUrl ? (
            <LinkButton
              href={pullUrl}
              target="_blank"
              rel="noreferrer"
              variant={checkAction ? "ghost" : "secondary"}
            >
              Open pull request ↗
            </LinkButton>
          ) : null}
        </div>
      </header>

      {newerReviewId ? (
        <Alert tone="info">
          A newer commit on this pull request has its own review; approvals count only on the pull
          request's current head.{" "}
          <a
            class="underline text-accent"
            href={dependencyReviewPath(newerReviewId, review.organizationId)}
          >
            Open the latest review
          </a>
        </Alert>
      ) : null}

      <ReviewHeadline
        review={review}
        state={state}
        allClear={
          !partial &&
          bumps.length === review.bumpCount &&
          bumps.every(
            (bump) => bump.verdict.status === "clear" && !hasUnreadContent(bump.verdict.evidence),
          )
        }
        partial={partial}
        approvable={approvable}
        stale={newerReviewId !== null}
        // A review cut at the storage limit can't count what it didn't keep.
        passedUnread={
          bumps.length === review.bumpCount
            ? groups.unreviewed.length +
              groups.added.length +
              groups.repinned.length +
              groups.unread.length
            : null
        }
        pollingStalled={model.pollingStalled.value}
        onResume={() => model.resumePolling()}
      />

      {settled && bumps.length < review.bumpCount ? (
        <Muted class="text-[13px] m-0">
          Showing {bumps.length} of {review.bumpCount} updates. Drydock keeps up to{" "}
          {MAX_STORED_BUMPS} per review, open holds first.
        </Muted>
      ) : null}

      {settled && partial ? (
        <ReviewCoverage
          coverage={coverage}
          // With nothing held per update the headline already says this.
          approvalAcceptsUnread={state === "held" && review.heldCount > 0 && approvable}
        />
      ) : null}

      {/* The clear headline already says there was nothing to review. */}
      {settled && state !== "clear" && bumps.length === 0 && !partial ? (
        <Card>
          <EmptyLine>No package version changes were collected for this review.</EmptyLine>
        </Card>
      ) : null}

      <BumpGroup title="Held for review" bumps={groups.held} />
      {/* The headline names who approved; earlier commits' approvals carry too. */}
      <BumpGroup title="Approved" bumps={groups.approved} />
      <BumpGroup
        title="Not reviewed"
        note="Passed under this organization's policy without a diff."
        bumps={groups.unreviewed}
      />
      <BumpGroup
        title="New packages"
        note="Passed: there is no previous version to compare against."
        bumps={groups.added}
      />
      <BumpGroup
        title="Same version, new pin"
        note="Passed: the lockfile pins the same version to new hashes, which match the public release. There is no earlier version to diff."
        bumps={groups.repinned}
      />
      <BumpGroup
        title="Passed with unread changes"
        note="Passed under this organization's policy, but Drydock did not read everything these releases changed."
        bumps={groups.unread}
      />
      <BumpGroup title="Clear" bumps={groups.clear} />
    </>
  );
}

// The one sentence that says where the pull request stands. Held and the
// in-between states are Alerts because they ask for (or explain) a wait; the
// settled ones are a plain line.
function ReviewHeadline({
  review,
  state,
  allClear,
  partial,
  approvable,
  stale,
  passedUnread,
  pollingStalled,
  onResume,
}: {
  review: DependencyReview;
  state: ReviewState;
  allClear: boolean;
  partial: boolean;
  approvable: boolean;
  stale: boolean;
  passedUnread: number | null;
  pollingStalled: boolean;
  onResume: () => void;
}) {
  if (state === "reviewing") {
    // While stalled a progress bar would falsely promise an auto-refresh.
    return pollingStalled ? (
      <Alert tone="warn">
        <div class="flex flex-wrap items-center justify-between gap-3">
          <span>Automatic refresh stopped after 10 minutes without the review finishing.</span>
          <Button variant="secondary" size="sm" onClick={onResume}>
            Resume refresh
          </Button>
        </div>
      </Alert>
    ) : (
      <Alert tone="info">
        {review.status === "queued" ? "Review queued." : "Reviewing this commit."} The page
        refreshes when the review is ready.
      </Alert>
    );
  }
  if (state === "superseded") {
    return (
      <Muted class="text-[14px] m-0">
        Not reviewed: by the time Drydock ran, this commit was no longer the head of an open pull
        request.
      </Muted>
    );
  }
  if (state === "failed") {
    return (
      <Alert tone="critical">
        Drydock could not finish reviewing this commit. Re-run the check on GitHub to try again. If
        the GitHub App's permissions changed recently, an owner must accept them on GitHub first.
      </Alert>
    );
  }
  if (state === "held") {
    const held =
      review.heldCount > 0
        ? `${review.heldCount} of ${review.bumpCount} ${review.bumpCount === 1 ? "update" : "updates"} ${review.heldCount === 1 ? "is" : "are"} held.`
        : "Held: Drydock could not read some dependency changes.";
    const next = stale
      ? "This commit is no longer the pull request's head, so its check can't be approved."
      : !approvable
        ? "The check can't show everything held, so it can't be approved. Split the pull request into smaller ones."
        : review.heldCount > 0
          ? "Read the diffs below, then choose Approve held updates on the GitHub check. Anyone with write access to the repository can approve."
          : "Approving on the GitHub check accepts the unread changes listed below; changing the files so Drydock can read them gets them reviewed instead.";
    return (
      <Alert tone="warn">
        {held} {next}{" "}
        <span class="text-ink-muted">
          Merging waits for approval only where this check is a required status check.
        </span>
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
      {review.bumpCount === 0 && allClear
        ? "No npm or PyPI dependency additions or updates."
        : allClear
          ? `${review.bumpCount === 1 ? "The update is" : `All ${review.bumpCount} updates are`} clear.`
          : partial
            ? "No updates are held under this organization's policy, but this review is incomplete (see Review coverage)."
            : passedUnread === null
              ? "No updates are held. Some passed under this organization's policy without a full read."
              : passedUnread > 0
                ? `No updates are held. ${passedUnread} ${passedUnread === 1 ? "update" : "updates"} passed under this organization's policy without a full read.`
                : "No updates are held."}
    </Muted>
  );
}

function ReviewCoverage({
  coverage,
  approvalAcceptsUnread,
}: {
  coverage: DependencyReviewCoverage;
  approvalAcceptsUnread: boolean;
}) {
  return (
    <section class="flex flex-col gap-3">
      <SectionLabel as="h2">Review coverage</SectionLabel>
      <Card>
        {!coverage.listingComplete ? (
          <p class="m-0 text-[13px] text-ink">
            GitHub did not return every changed file, so this review may be missing dependency
            updates. Smaller pull requests get a complete review.
          </p>
        ) : null}
        {coverage.unreadLockfiles.length > 0 ? (
          <>
            <p class="m-0 text-[13px] text-ink">
              Drydock could not review the changes to these files:
            </p>
            <ul class="m-0 p-0 list-none font-mono text-[12px] text-ink-muted">
              {coverage.unreadLockfiles.map((path) => (
                <li key={path} class="[overflow-wrap:anywhere]">
                  {path}
                </li>
              ))}
            </ul>
            {approvalAcceptsUnread ? (
              <Muted class="text-[13px] m-0">
                Approving the held updates also accepts the changes in these files unread.
              </Muted>
            ) : null}
          </>
        ) : null}
      </Card>
    </section>
  );
}

function groupBumps(bumps: ReviewedBump[]) {
  const groups = {
    held: [] as ReviewedBump[],
    approved: [] as ReviewedBump[],
    unreviewed: [] as ReviewedBump[],
    added: [] as ReviewedBump[],
    repinned: [] as ReviewedBump[],
    unread: [] as ReviewedBump[],
    clear: [] as ReviewedBump[],
  };
  for (const bump of bumps) {
    const { status } = bump.verdict;
    if (status === "hold") (bump.approved ? groups.approved : groups.held).push(bump);
    else if (status === "unreviewed") groups.unreviewed.push(bump);
    else if (status === "new-package")
      (bump.bump.repinned ? groups.repinned : groups.added).push(bump);
    else if (hasUnreadContent(bump.verdict.evidence)) groups.unread.push(bump);
    else groups.clear.push(bump);
  }
  return groups;
}

function BumpGroup({
  title,
  note,
  bumps,
}: {
  title: string;
  note?: string;
  bumps: ReviewedBump[];
}) {
  if (bumps.length === 0) return null;
  return (
    <section class="flex flex-col gap-3">
      <SectionLabel as="h2" aside={bumps.length}>
        {title}
      </SectionLabel>
      {note ? <Muted class="text-[13px] m-0">{note}</Muted> : null}
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
  const diffHref =
    bump.fromVersion && !bump.privateSource
      ? packageDiffPath(bump.ecosystem, bump.name, bump.fromVersion, bump.toVersion)
      : null;
  const reason = verdictReason(verdict, evidence, bump);
  // A release-risk hold names the grade in its reason; don't say it twice.
  const riskInReason = verdict.status === "hold" && verdict.reasons.includes("release-risk");
  return (
    <li class="border-b border-border last:border-b-0 px-5 py-4 flex flex-col gap-2 min-w-0">
      <div class="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <div class="flex flex-wrap items-baseline gap-x-3 gap-y-1 min-w-0">
          <span class="font-mono text-[14px] font-medium text-ink break-all">{bump.name}</span>
          <span class="font-mono text-[12px] text-ink-muted break-all">
            {bump.fromVersion
              ? `${bump.fromVersion} → ${bump.toVersion}`
              : bump.repinned
                ? `${bump.toVersion}, ${REPINNED_TEXT}`
                : bump.replacesPrivate
                  ? `new ${bump.toVersion}, ${REPLACES_PRIVATE_TEXT}`
                  : `new ${bump.toVersion}`}
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
          evidence && !riskInReason ? `release risk ${evidence.releaseRisk}` : null,
          evidence ? fileCounts(evidence) : null,
        ]}
      />
      {reason ? <p class="m-0 text-[13px] text-ink">{reason}</p> : null}
      {evidence && evidence.findings.length > 0 ? (
        <FindingList evidence={evidence} diffHref={diffHref} />
      ) : null}
    </li>
  );
}

function FindingList({ evidence, diffHref }: { evidence: BumpEvidence; diffHref: string | null }) {
  const more = evidence.findingCount - evidence.findings.length;
  return (
    <ul class="m-0 p-0 list-none flex flex-col gap-1.5">
      {evidence.findings.map((finding, index) => (
        <li key={index} class="flex flex-wrap items-baseline gap-x-2 gap-y-1 min-w-0 text-[13px]">
          <Badge tone={severityTone(finding.severity)}>{finding.severity}</Badge>
          <span class="font-mono text-[12px] text-ink-muted min-w-0 [overflow-wrap:anywhere]">
            {finding.ruleId ?? "unnamed rule"} · {finding.file}
          </span>
          <span class="text-ink break-words min-w-0">{finding.reason}</span>
        </li>
      ))}
      {more > 0 ? (
        <Caption>
          {diffHref ? (
            <a href={diffHref}>
              {more} more release {more === 1 ? "finding" : "findings"} in the diff →
            </a>
          ) : (
            `${more} more release ${more === 1 ? "finding" : "findings"} in the diff`
          )}
        </Caption>
      ) : null}
    </ul>
  );
}

function Caption({ children }: { children: ComponentChildren }) {
  return <li class="font-mono text-[11px] text-ink-subtle">{children}</li>;
}

// File counts, skipping the zeros: "2 files added · 5 changed".
function fileCounts(evidence: BumpEvidence): string | null {
  const parts = [
    evidence.filesAdded ? `${evidence.filesAdded} added` : null,
    evidence.filesRemoved ? `${evidence.filesRemoved} removed` : null,
    evidence.filesChanged ? `${evidence.filesChanged} changed` : null,
  ].filter(Boolean);
  return parts.length ? `files ${parts.join(", ")}` : null;
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

function verdictReason(
  verdict: BumpVerdict,
  evidence: BumpEvidence | null,
  bump: DependencyBump,
): string | null {
  if (verdict.status === "unreviewed") return sentence(unreviewedText(verdict.unreviewed, bump));
  if (verdict.status === "clear") {
    const unread = unreadContentText(verdict.evidence);
    return unread ? sentence(unread) : null;
  }
  if (verdict.status !== "hold") return null;
  // The age hold's phrase names what went unread and when it passes.
  const ageHold = holdReasonPhrases(
    { ...verdict, reasons: ["too-new"] },
    { bump, formatTime: formatDateTime },
  )[0];
  const reasons = verdict.reasons.map((reason) => {
    if (reason === "too-new") return ageHold;
    if (reason === "new-package" && bump.repinned) return REPINNED_TEXT;
    if (reason === "unreviewed" && verdict.unreviewed) {
      return `${HOLD_REASON_TEXT.unreviewed} (${unreviewedText(verdict.unreviewed, bump)})`;
    }
    if (reason === "dependency-added" && verdict.dependencyUnseen) {
      return dependencyAddedText(verdict.dependencyUnseen);
    }
    if (reason === "young-package") {
      return holdReasonPhrases(
        { ...verdict, reasons: ["young-package"] },
        { bump, formatTime: formatDateTime },
      )[0];
    }
    if (reason === "release-risk" && evidence) {
      return `release risk ${evidence.releaseRisk}, at or above the hold threshold`;
    }
    const count = evidence ? (REASON_COUNT[reason]?.(evidence) ?? 0) : 0;
    return count > 1 ? `${HOLD_REASON_TEXT[reason]} (${count})` : HOLD_REASON_TEXT[reason];
  });
  return reasons.length ? sentence(reasons.join("; ")) : null;
}

function sentence(text: string): string {
  return `${text.charAt(0).toUpperCase()}${text.slice(1)}.`;
}
