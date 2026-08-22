// Every SectionLabel here sits on a boundary that already has a second rule.
// Line numbers are asserted in test/oxlint-stacked-section-rule.test.mjs.
import { SectionLabel } from "./components";
import { cn } from "./cn";

export function OnLabel() {
  return (
    <SectionLabel as="h2" class="border-b border-border">
      Findings
    </SectionLabel>
  );
}

export function OnLabelViaCn({ extra }: { extra?: string }) {
  return (
    <SectionLabel as="h2" class={cn("mt-4", extra, "border-t border-border")}>
      Findings
    </SectionLabel>
  );
}

export function OnWrapper() {
  return (
    <div class="border-b border-border pb-2">
      <SectionLabel as="h2">Findings</SectionLabel>
    </div>
  );
}

export function OnSiblingHr() {
  return (
    <section>
      <SectionLabel as="h2">Findings</SectionLabel>
      <hr />
    </section>
  );
}

export function OnSiblingBorder() {
  return (
    <section>
      <SectionLabel as="h2">Findings</SectionLabel>
      <div class="border-t border-border pt-3">body</div>
    </section>
  );
}

export function OnPrecedingSibling() {
  return (
    <section>
      <div class="border-b border-border pb-3">intro</div>
      <SectionLabel as="h2">Findings</SectionLabel>
    </section>
  );
}

export function OnSiblingHrAcrossComment() {
  return (
    <section>
      <SectionLabel as="h2">Findings</SectionLabel>
      {/* This comment renders no node, so the rule remains visually adjacent. */}
      <hr />
    </section>
  );
}

export function OnLeadingWrapperEdge() {
  return (
    <section class="border-t border-border">
      <SectionLabel as="h2">Findings</SectionLabel>
      <p>body</p>
    </section>
  );
}

export function OnTrailingWrapperEdge() {
  return (
    <section class="border-b border-border">
      <p>body</p>
      <SectionLabel as="h2">Findings</SectionLabel>
    </section>
  );
}
