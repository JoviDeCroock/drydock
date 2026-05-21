import { useEffect } from "preact/hooks";
import { useSignal } from "@preact/signals";
import { Show } from "@preact/signals/utils";
import { getSession } from "../../models/auth";
import {
  Card,
  Eyebrow,
  LinkButton,
  PageShell,
  SectionLabel,
  StatusStrip,
  StatusStripItem,
} from "../../components";

export default function LandingPage() {
  const authed = useSignal(false);

  useEffect(() => {
    let cancelled = false;
    getSession().then((session) => {
      if (cancelled) return;
      authed.value = Boolean(session?.user);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <PageShell class="gap-10">
      <section class="py-8 md:py-12 border-y border-border flex flex-col gap-5">
        <Eyebrow tone="accent">Release confidence for npm maintainers</Eyebrow>
        <h1 class="text-4xl md:text-5xl font-semibold tracking-[-0.03em] leading-[1.05] max-w-[760px] m-0">
          Catch risky changes before a staged package goes live.
        </h1>
        <p class="text-[17px] text-ink-muted max-w-[620px] leading-[1.6] m-0">
          Review what changed, spot suspicious release behavior, and leave with a clear safety report —
          without executing package code or exposing credentials to untrusted package contents.
        </p>
        <div class="flex gap-3 mt-2">
          <Show
            when={authed}
            fallback={
              <>
                <LinkButton href="/register">Create account</LinkButton>
                <LinkButton href="/login" variant="secondary">
                  Sign in
                </LinkButton>
              </>
            }
          >
            <LinkButton href="/dashboard">Open dashboard</LinkButton>
          </Show>
        </div>
      </section>

      <StatusStrip>
        <StatusStripItem label="credentials" status="scoped" tone="ok">
          Your npm token is used only to fetch staged release evidence, never exposed to package contents.
        </StatusStripItem>
        <StatusStripItem label="retention" status="redacted" tone="ok">
          Reports keep redacted review evidence, not raw release archives.
        </StatusStripItem>
        <StatusStripItem label="approval" status="human" tone="neutral">
          Maintainers approve in npm with normal 2FA. We never publish on their behalf.
        </StatusStripItem>
      </StatusStrip>

      <section aria-label="Safety features" class="flex flex-col gap-4">
        <SectionLabel>How it protects releases</SectionLabel>
        <div class="grid grid-cols-1 md:grid-cols-3 gap-4">
          <Feature title="Credentials stay protected">
            Connect npm once. Reviews can fetch staged releases without exposing your token to untrusted
            package contents.
          </Feature>
          <Feature title="Changes take center stage">
            See the release delta that matters: scripts, dependencies, entrypoints, new files, binaries,
            and suspicious code paths.
          </Feature>
          <Feature title="Assistant that knows its place">
            The reviewer treats package contents as evidence, not instructions — adding context without
            overriding hard safety signals.
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
