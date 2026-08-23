import { LinkButton } from "../../components/Button";
import { Card } from "../../components/Card";
import { SectionLabel } from "../../components/Typography";

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
          Put an artifact diff in every dependency PR.
        </h2>
        <p class="m-0 text-[14px] leading-[1.65] text-ink-muted max-w-[680px]">
          Renovate and Dependabot already know the exact versions a pull request changes. Drydock
          turns that pair into a public, deterministic package diff with no account or token.
        </p>
      </div>

      <div class="grid max-w-[920px] grid-cols-1 gap-3 md:grid-cols-2">
        <Card as="article" class="min-w-0 p-4 flex flex-col gap-3">
          <h3 class="m-0 text-base font-medium">Renovate preset</h3>
          <p class="m-0 text-[13px] leading-[1.55] text-ink-muted">
            Extend one shared preset to add a Drydock column to npm and PyPI update tables.
          </p>
          <code class="block rounded-md bg-surface-raised border border-border px-3 py-2 font-mono text-[11px] leading-[1.55] overflow-x-auto">
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

        <Card as="article" class="min-w-0 p-4 flex flex-col gap-3">
          <h3 class="m-0 text-base font-medium">Dependabot workflow</h3>
          <p class="m-0 text-[13px] leading-[1.55] text-ink-muted">
            Copy a workflow that verifies Dependabot&apos;s signed commit, then upserts one
            diff-link comment for single or grouped updates without checking out PR code.
          </p>
          <div class="font-mono text-[11px] text-ink-subtle">
            npm + PyPI · grouped PRs supported
          </div>
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
