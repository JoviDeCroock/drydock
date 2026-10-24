/**
 * The organization's recent dependency reviews: one row per Dependabot or
 * Renovate pull request the GitHub App checked, newest first.
 */
import type { ComponentChildren } from "preact";
import { useModel } from "@preact/signals";
import { formatDateTime } from "../../../lib/format";
import { AppHeaderActions } from "../../../features/account/AppHeaderActions";
import { useAuthedDashboardSession } from "../../../features/account/useAuthedDashboardSession";
import { DependencyReviewsModel, type DependencyReview } from "../../../models/dependency-review";
import { OrganizationModel } from "../../../models/organization";
import { ReviewStateMark } from "../../../features/dependency-review/ReviewStateMark";
import { dependencyReviewPath } from "../../../features/dependency-review/wording";
import { Alert } from "../../../components/Alert";
import { LinkButton } from "../../../components/Button";
import { Card } from "../../../components/Card";
import { LoadingState } from "../../../components/Loading";
import { PageShell } from "../../../components/PageShell";
import { EmptyLine, Muted } from "../../../components/Typography";
import { SETTINGS_SECTION, settingsTabHref } from "../Settings/settings-links";

const SETTINGS_HREF = settingsTabHref("integrations", SETTINGS_SECTION.dependencyReview);

export default function DependencyReviewsPage() {
  const model = useModel(DependencyReviewsModel);
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

  return (
    <PageShell headerActions={headerActions}>
      <header class="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between sm:gap-6">
        <div class="flex flex-col gap-2 max-w-[640px]">
          <h1 class="text-3xl font-semibold tracking-[-0.02em] m-0">Dependency reviews</h1>
          <Muted class="text-[14px] leading-[1.55] m-0">
            Dependabot and Renovate pull requests the Drydock GitHub App checked. Held updates wait
            for an approval on the pull request's Drydock dependency review check.
          </Muted>
        </div>
        <LinkButton href={SETTINGS_HREF} variant="secondary" class="shrink-0 self-start">
          Review settings
        </LinkButton>
      </header>

      {error ? <Alert tone="critical">{error}</Alert> : null}

      {!ready ? (
        <LoadingState
          title="Loading dependency reviews"
          detail="confirming session · reading reviews"
        />
      ) : error ? null : reviews.length === 0 ? (
        <Card>
          <EmptyLine>
            {enabled
              ? "No dependency update pull requests have been reviewed in this organization yet."
              : "Dependency review is off for this organization."}
          </EmptyLine>
        </Card>
      ) : (
        <ReviewTable reviews={reviews} />
      )}
    </PageShell>
  );
}

function ReviewTable({ reviews }: { reviews: DependencyReview[] }) {
  return (
    <Card padding="none" class="overflow-x-auto">
      <table class="w-full border-collapse text-[13px]">
        <thead>
          <tr class="border-b border-border bg-surface-2">
            <Th>Pull request</Th>
            <Th>State</Th>
            <Th>Updates</Th>
            <Th>Reviewed</Th>
          </tr>
        </thead>
        <tbody>
          {reviews.map((review) => (
            <tr key={review.id} class="border-b border-border last:border-b-0 hover:bg-surface-2">
              <Td>
                <a
                  href={dependencyReviewPath(review.id, review.organizationId)}
                  class="font-mono text-[12px] break-all"
                >
                  {review.repositoryFullName} #{review.pullNumber}
                </a>
                <span class="block font-mono text-[11px] text-ink-subtle">
                  by {review.authorLogin}
                </span>
              </Td>
              <Td>
                <ReviewStateMark review={review} />
              </Td>
              <Td class="font-mono text-[12px] text-ink-muted whitespace-nowrap">
                {updatesLabel(review)}
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

function updatesLabel(review: DependencyReview): string {
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
