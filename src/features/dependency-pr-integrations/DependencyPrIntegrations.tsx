import { LinkButton } from "../../components/Button";
import { Card } from "../../components/Card";
import { packageDiffPath } from "../../lib/package-diff-path";
import { MonoDetail, SectionLabel } from "../../components/Typography";

const RENOVATE_GUIDE = "/docs#renovate-diff-links";
const DEPENDABOT_GUIDE = "/docs#dependabot-diff-links";
const RENOVATE_PRESET = '"github>JoviDeCroock/drydock//renovate/diff-links"';

export function DependencyPrIntegrations({ compact = false }: { compact?: boolean }) {
  if (compact) return <DependencyPrPromotion />;

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
            href={RENOVATE_GUIDE}
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
            href={DEPENDABOT_GUIDE}
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

function DependencyPrPromotion() {
  return (
    <section aria-labelledby="dependency-pr-integrations" class="flex flex-col gap-4">
      <SectionLabel as="p">Dependency update reviews</SectionLabel>
      <div class="grid grid-cols-1 md:grid-cols-2 gap-6 items-start">
        <div class="flex flex-col gap-3">
          <h2
            id="dependency-pr-integrations"
            class="text-2xl font-semibold tracking-[-0.015em] m-0 max-w-[680px]"
          >
            Put package diffs in your dependency PRs.
          </h2>
          <p class="m-0 text-[14px] leading-[1.65] text-ink-muted max-w-[680px]">
            Add Drydock links to npm and PyPI updates from Renovate or Dependabot. Reviewers can
            inspect the published files before merging, without a Drydock account.
          </p>
          <div class="flex flex-wrap gap-3">
            <LinkButton href={RENOVATE_GUIDE} variant="secondary" size="sm">
              Add to Renovate
            </LinkButton>
            <LinkButton href={DEPENDABOT_GUIDE} variant="secondary" size="sm">
              Add to Dependabot
            </LinkButton>
          </div>
        </div>
        <Card padding="none" class="min-w-0">
          <p id="dependency-pr-example" class="m-0 px-4 py-3 text-[12px] text-ink-muted">
            Renovate PR example · demo package
          </p>
          <div
            role="region"
            aria-labelledby="dependency-pr-example"
            tabIndex={0}
            class="overflow-x-auto"
          >
            <table class="w-full border-collapse text-left whitespace-nowrap">
              <thead class="border-y border-border text-[11px] text-ink-subtle">
                <tr>
                  <th scope="col" class="px-4 py-2 font-medium">
                    Package
                  </th>
                  <th scope="col" class="px-4 py-2 font-medium">
                    Change
                  </th>
                  <th scope="col" class="px-4 py-2 font-medium">
                    Drydock
                  </th>
                </tr>
              </thead>
              <tbody class="text-[12px]">
                <tr>
                  <td class="px-4 py-3 font-mono">semversyphus</td>
                  <td class="px-4 py-3 font-mono text-ink-muted">1.0.5 → 1.0.6</td>
                  <td class="px-4 py-3">
                    <a
                      href={packageDiffPath("npm", "semversyphus", "1.0.5", "1.0.6")}
                      class="text-accent underline hover:text-ink"
                    >
                      Read the diff
                    </a>
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
          <p class="m-0 px-4 py-3 border-t border-border text-[12px] text-ink-muted leading-[1.55]">
            Dependabot adds the same diff links in a PR comment.
          </p>
        </Card>
      </div>
    </section>
  );
}
