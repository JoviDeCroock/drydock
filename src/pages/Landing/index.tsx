import { Card, Eyebrow, LinkButton, PageShell, SectionLabel } from "../../components";

export default function LandingPage() {
  return (
    <PageShell class="gap-10">
      <Card class="p-10 md:p-14 flex flex-col gap-5">
        <Eyebrow tone="accent">Staged publish release review</Eyebrow>
        <h1 class="text-4xl md:text-5xl font-semibold tracking-[-0.03em] leading-[1.05] max-w-[760px] m-0">
          Explore staged npm packages without trusting package bytes.
        </h1>
        <p class="text-[17px] text-ink-muted max-w-[560px] leading-[1.6] m-0">
          Sandboxed staged-tarball download, deterministic supply-chain checks, previous-version diffs,
          Better Auth, Drizzle/D1 persistence, and Kimi K2.5 AI triage before manual approval.
        </p>
        <div class="flex gap-3 mt-2">
          <LinkButton href="/register">Create account</LinkButton>
          <LinkButton href="/login" variant="secondary">
            Sign in
          </LinkButton>
        </div>
      </Card>

      <section aria-label="Safety features" class="flex flex-col gap-4">
        <SectionLabel>Safety posture</SectionLabel>
        <div class="grid grid-cols-1 md:grid-cols-3 gap-4">
          <Feature title="Token isolation">
            The npm token stays in the parent worker. The Dynamic Worker sandbox only fetches through a
            locked-down npm gateway.
          </Feature>
          <Feature title="Diff-first review">
            Review what changed from the published version: scripts, dependencies, entrypoints, files,
            binaries, and suspicious code paths.
          </Feature>
          <Feature title="Prompt-injection resistant">
            Package contents are hostile evidence, not instructions. Kimi K2.5 receives a static cached
            safety prompt and schema-constrained output.
          </Feature>
        </div>
      </section>
    </PageShell>
  );
}

function Feature({ title, children }: { title: string; children: string }) {
  return (
    <Card as="article" class="p-5 flex flex-col gap-2">
      <h2 class="text-base font-medium tracking-[-0.005em] m-0">{title}</h2>
      <p class="text-[13px] text-ink-muted leading-[1.55] m-0">{children}</p>
    </Card>
  );
}
