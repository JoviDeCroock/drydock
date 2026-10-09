// Every size here is under the docs/design.md floor (`text-xs` is 10.5px on the 14px root).
// Line numbers are asserted in test/oxlint-design-tokens.test.mjs.

export function NinePx() {
  return <span class="text-[9px]">tiny</span>;
}

export function HalfRem() {
  return <span class="font-mono text-[0.5rem]">tiny</span>;
}

export function WithVariant() {
  return <span class="lg:text-[8px]">tiny</span>;
}

export function InMap() {
  const sizes = { micro: "text-[6px] uppercase" };
  return <span class={sizes.micro}>tiny</span>;
}

export function LeadingShorthand() {
  return <span class="text-[9px]/3">tiny</span>;
}

export function LengthHint() {
  return <span class="text-[length:9px]/[12px]">tiny</span>;
}

export function ArbitraryProperty() {
  return <span class="[font-size:9px]">tiny</span>;
}

export function NamedExtraSmall() {
  return <span class="text-xs">tiny</span>;
}
