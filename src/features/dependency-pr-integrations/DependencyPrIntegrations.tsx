import { LinkButton } from "../../components/Button";
import { Card } from "../../components/Card";
import { MonoDetail, SectionLabel } from "../../components/Typography";

const RENOVATE_PRESET = '"github>JoviDeCroock/drydock//renovate/diff-links"';

export function DependencyPrIntegrations() {
  return (
    <section aria-labelledby="dependency-pr-integrations" class="flex flex-col gap-4">
      <div class="flex flex-col gap-3">
        <SectionLabel as="p">Dependency update reviews</SectionLabel>
        <h2
          id="dependency-pr-integrations"
          class="text-2xl font-semibold tracking-[-0.015em] m-0 max-w-[680px]"
        >
          Read the package diff from your dependency PR.
        </h2>
        <p class="m-0 text-[14px] leading-[1.65] text-ink-muted max-w-[680px]">
          Add Drydock links to npm and PyPI updates from Renovate or Dependabot. Reviewers can
          compare the published files for each version pair without a Drydock account.
        </p>
      </div>

      <div class="grid grid-cols-1 gap-3 md:grid-cols-2">
        <Card as="article" padding="compact" class="min-w-0 flex flex-col gap-3">
          <h3 class="m-0 text-base font-medium">Renovate preset</h3>
          <p class="m-0 text-[13px] leading-[1.55] text-ink-muted">
            Extend one shared preset to add a Drydock column to npm and PyPI update tables.
          </p>
          <code class="block rounded-md bg-surface-2 border border-border px-3 py-2 font-mono text-[11px] leading-[1.55] overflow-x-auto">
            {RENOVATE_PRESET}
          </code>
          <LinkButton
            href="/docs#renovate-diff-links"
            variant="secondary"
            size="sm"
            class="mt-auto self-start"
          >
            Add to Renovate
          </LinkButton>
        </Card>

        <Card as="article" padding="compact" class="min-w-0 flex flex-col gap-3">
          <h3 class="m-0 text-base font-medium">Dependabot workflow</h3>
          <p class="m-0 text-[13px] leading-[1.55] text-ink-muted">
            Add a workflow that verifies Dependabot&apos;s signed commit and posts package diff
            links. When Dependabot revises a grouped update, the workflow updates the same comment.
          </p>
          <MonoDetail parts={["npm + PyPI", "grouped PRs supported"]} />
          <LinkButton
            href="/docs#dependabot-diff-links"
            variant="secondary"
            size="sm"
            class="mt-auto self-start"
          >
            Add to Dependabot
          </LinkButton>
        </Card>
      </div>
    </section>
  );
}
