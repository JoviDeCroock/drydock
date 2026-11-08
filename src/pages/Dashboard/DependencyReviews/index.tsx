/**
 * The organization's recent dependency reviews: one row per pull request
 * commit the GitHub App checked, newest first.
 */
import type { ComponentChildren } from "preact";
import { useModel } from "@preact/signals";
import { formatDateTime } from "../../../lib/format";
import { AppHeaderActions } from "../../../features/account/AppHeaderActions";
import { useAuthedDashboardSession } from "../../../features/account/useAuthedDashboardSession";
import { DependencyReviewsModel, type DependencyReview } from "../../../models/dependency-review";
import { OrganizationModel } from "../../../models/organization";
import { ReviewStateMark } from "../../../features/dependency-review/ReviewStateMark";
import { dependencyReviewPath, reviewState } from "../../../features/dependency-review/wording";
import { Alert } from "../../../components/Alert";
import { Button, LinkButton } from "../../../components/Button";
import { Card } from "../../../components/Card";
import { LoadingState } from "../../../components/Loading";
import { PageShell } from "../../../components/PageShell";
import { EmptyLine, MonoDetail, Muted } from "../../../components/Typography";
import { SETTINGS_SECTION, settingsTabHref } from "../Settings/settings-links";

const SETTINGS_HREF = settingsTabHref("integrations", SETTINGS_SECTION.dependencyReview);
const GITHUB_APP_HREF = settingsTabHref("integrations", SETTINGS_SECTION.githubApp);

export default function DependencyReviewsPage() {
  const model = useModel(() => new DependencyReviewsModel({ followReviews: true }));
  const organizations = useModel(OrganizationModel);
  const sessionChecked = useAuthedDashboardSession({
    // A scan review's back link leads to the scan lists, not here.
    rememberReturnUrl: false,
    onReady: async (_session, isCancelled) => {
      await organizations.load();
      if (isCancelled()) return;
      await model.load();
    },
  });

  const headerActions = (
    <AppHeaderActions
      current="dependencies"
      organizations={organizations}
      onActivate={async (id) => {
        if (organizations.activate(id)) await model.load();
      }}
      onCreate={async (name) => {
        if (await organizations.create(name)) await model.load();
      }}
    />
  );

  const ready = sessionChecked.value && model.loaded.value;
  const error = model.error.value;
  const reviews = model.reviews.value;
  const enabled = model.saved.value?.enabled ?? false;
  // On but without the App nothing can ever be reviewed; that is the next step.
  const appMissing = ready && enabled && !model.githubAppInstalled.value;
  const canManage = model.canManage.value;

  return (
    <PageShell headerActions={headerActions}>
      <header class="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between sm:gap-6">
        <div class="flex flex-col gap-2 max-w-[640px]">
          <h1 class="text-3xl font-semibold tracking-[-0.02em] m-0">Dependency reviews</h1>
          <Muted class="text-[14px] leading-[1.55] m-0">
            Pull requests from branches in your repositories that the Drydock GitHub App checked. A
            held update needs approval on the pull request's Drydock dependency review check;
            merging waits for it only where that check is required.
          </Muted>
        </div>
        <LinkButton href={SETTINGS_HREF} variant="secondary" class="shrink-0 self-start">
          {ready && !enabled && canManage ? "Turn on dependency review" : "Review settings"}
        </LinkButton>
      </header>

      {error ? <Alert tone="critical">{error}</Alert> : null}
      {appMissing ? (
        <Alert tone="warn">
          Dependency review is on, but the Drydock GitHub App is not installed, so no pull request
          can be reviewed.{" "}
          {canManage ? (
            <a class="underline text-accent" href={GITHUB_APP_HREF}>
              Install the GitHub App
            </a>
          ) : (
            "An owner or admin can install it in Settings."
          )}
        </Alert>
      ) : null}
      {model.pollingStalled.value && model.anyInFlight.value ? (
        <Alert tone="warn">
          <div class="flex flex-wrap items-center justify-between gap-3">
            <span>Automatic refresh stopped after 10 minutes without the reviews finishing.</span>
            <Button variant="secondary" size="sm" onClick={() => model.resumePolling()}>
              Resume refresh
            </Button>
          </div>
        </Alert>
      ) : null}

      {!ready ? (
        <LoadingState
          title="Loading dependency reviews"
          detail="confirming session · reading reviews"
        />
      ) : reviews.length > 0 ? (
        // A failed refresh keeps the rows already read; its error shows above.
        <ReviewTable reviews={reviews} />
      ) : error || appMissing ? null : (
        <Card>
          <EmptyLine>
            {enabled
              ? "No pull requests reviewed yet. Drydock reviews one when a pull request from a branch in an installed repository is opened or updated."
              : canManage
                ? "Dependency review is off for this organization."
                : "Dependency review is off for this organization. An owner or admin can turn it on."}
          </EmptyLine>
        </Card>
      )}
    </PageShell>
  );
}

function ReviewTable({ reviews }: { reviews: DependencyReview[] }) {
  return (
    <Card padding="none">
      {/* Below sm the rows stack, so nothing hides behind a sideways scroll. */}
      <ul class="m-0 p-0 list-none sm:hidden">
        {reviews.map((review) => (
          <li
            key={review.id}
            class="border-b border-border last:border-b-0 px-4 py-3 flex flex-col gap-1.5"
          >
            <div class="flex items-baseline justify-between gap-3 min-w-0">
              <ReviewLink review={review} />
              <ReviewStateMark review={review} />
            </div>
            <MonoDetail parts={rowDetail(review, true)} />
          </li>
        ))}
      </ul>
      <table class="hidden sm:table w-full border-collapse text-[13px]">
        <thead>
          <tr class="border-b border-border bg-surface-2">
            <Th>Pull request</Th>
            <Th>State</Th>
            <Th>Updates</Th>
            <Th>Updated</Th>
          </tr>
        </thead>
        <tbody>
          {reviews.map((review) => (
            <tr key={review.id} class="border-b border-border last:border-b-0 hover:bg-surface-2">
              <Td>
                <ReviewLink review={review} />
                <span class="block font-mono text-[11px] text-ink-subtle">
                  {rowDetail(review, false).join(" · ")}
                </span>
              </Td>
              <Td>
                <ReviewStateMark review={review} />
              </Td>
              <Td class="font-mono text-[12px] text-ink-muted whitespace-nowrap">
                {updatesLabel(review) ?? "—"}
              </Td>
              <Td class="font-mono text-[12px] text-ink-muted whitespace-nowrap">
                {formatDateTime(review.completedAt ?? review.createdAt)}
              </Td>
            </tr>
          ))}
        </tbody>
      </table>
    </Card>
  );
}

function ReviewLink({ review }: { review: DependencyReview }) {
  return (
    <a
      href={dependencyReviewPath(review.id, review.organizationId)}
      class="font-mono text-[12px] [overflow-wrap:anywhere]"
    >
      {review.repositoryFullName} #{review.pullNumber}
    </a>
  );
}

// Author and commit; one pull request can have several reviewed commits.
function rowDetail(review: DependencyReview, withCountAndTime: boolean): string[] {
  const parts = [`by ${review.authorLogin}`, review.headSha.slice(0, 7)];
  if (!withCountAndTime) return parts;
  const updates = updatesLabel(review);
  return [
    ...parts,
    ...(updates ? [updates] : []),
    formatDateTime(review.completedAt ?? review.createdAt),
  ];
}

// A count is a result only once the review finished; before that it reads as zero.
function updatesLabel(review: DependencyReview): string | null {
  const state = reviewState(review);
  if (state === "reviewing" || state === "failed" || state === "superseded") return null;
  // Zero is a result only for a clear review; otherwise a lockfile went unread.
  if (state !== "clear" && review.bumpCount === 0) return null;
  return `${review.bumpCount} ${review.bumpCount === 1 ? "update" : "updates"}`;
}

function Th({ children }: { children: ComponentChildren }) {
  return (
    <th class="text-left font-mono text-[11px] uppercase tracking-[0.1em] text-ink-subtle px-4 py-2.5">
      {children}
    </th>
  );
}

function Td({ children, class: className }: { children: ComponentChildren; class?: string }) {
  return <td class={`px-4 py-2.5 align-baseline ${className || ""}`}>{children}</td>;
}
