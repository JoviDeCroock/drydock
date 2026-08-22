// None of these stack a second hairline on a SectionLabel's own rule.
import { SectionLabel } from "./components";

export function BoxedCard() {
  // An all-sides outline is a box, not a rule on the label's boundary.
  return (
    <section class="border border-border rounded-lg p-4">
      <SectionLabel as="h2">Findings</SectionLabel>
      <p>body</p>
    </section>
  );
}

export function SpacedInstead() {
  return (
    <section>
      <SectionLabel as="h2">Findings</SectionLabel>
      <div class="mt-4">body</div>
    </section>
  );
}

export function RuleTwoElementsAway() {
  return (
    <section>
      <SectionLabel as="h2">Findings</SectionLabel>
      <p>lede</p>
      <div class="border-t border-border pt-3">body</div>
    </section>
  );
}

export function LabelInTheMiddleOfABorderedStack() {
  // The label is not on the wrapper's top or bottom edge, so the wrapper's
  // border-t is a different boundary.
  return (
    <div class="border-t border-border">
      <p>above</p>
      <SectionLabel as="h2">Findings</SectionLabel>
      <p>below</p>
    </div>
  );
}

export function DividerFarFromAnyLabel() {
  return (
    <section>
      <p>intro</p>
      <hr />
      <p>body</p>
    </section>
  );
}

export function BorderXOnLabel() {
  // Horizontal edges only; border-x is not a stacked hairline.
  return (
    <SectionLabel as="h2" class="border-x border-border">
      Findings
    </SectionLabel>
  );
}

export function OppositeWrapperEdges() {
  return (
    <>
      <section class="border-b border-border">
        <SectionLabel as="h2">Leading label</SectionLabel>
        <p>body before the wrapper's bottom edge</p>
      </section>
      <section class="border-t border-border">
        <p>body after the wrapper's top edge</p>
        <SectionLabel as="h2">Trailing label</SectionLabel>
      </section>
    </>
  );
}

export function OppositeSiblingEdges() {
  return (
    <section>
      <div class="border-t border-border">preceding element</div>
      <SectionLabel as="h2">Findings</SectionLabel>
      <div class="border-b border-border">following element</div>
    </section>
  );
}

export function ZeroWidthBorder() {
  return (
    <SectionLabel as="h2" class="border-t-0 border-b-0">
      Findings
    </SectionLabel>
  );
}
