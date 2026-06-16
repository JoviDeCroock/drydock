import { Card, Eyebrow, LinkButton, Muted, PageShell } from "../components";

export default function NotFoundPage() {
  return (
    <PageShell width="narrow">
      <Card class="flex flex-col gap-3">
        <Eyebrow>404</Eyebrow>
        <h1 class="text-2xl font-semibold tracking-[-0.015em] m-0">Page not found</h1>
        <Muted class="text-[13px] m-0">That page isn't available.</Muted>
        <div class="mt-2">
          <LinkButton href="/" variant="secondary">
            Back to home
          </LinkButton>
        </div>
      </Card>
    </PageShell>
  );
}
