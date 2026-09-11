// Everything here stays on the token system and above the size floor.
import { cn } from "./cn";

export function TokenColors() {
  return (
    <div class="bg-surface text-ink border border-border">
      <span class="text-warn-text bg-warn-soft">amber label</span>
      <span class="text-ok-text">ok</span>
      <span class="text-accent hover:text-accent-hover">link</span>
    </div>
  );
}

export function SaturatedShapes() {
  return (
    <div class="border-l-2 border-warn">
      <span class="w-4 h-4 rounded-full bg-danger" aria-hidden />
      <span class="bg-current" />
    </div>
  );
}

export function TokenInArbitraryValue() {
  return <div class="shadow-[0_0_0_3px_var(--color-accent-soft)] bg-ink/15">focus</div>;
}

export function StructuralWhiteAndBlack() {
  return <div class="backdrop:bg-black/40 text-white">overlay</div>;
}

export function InlineStyleWithoutColor({ width }: { width: number }) {
  return <div style={{ width: `${width}%`, height: "6px" }} />;
}

export function ProseWithHash() {
  return <p>See issue #123 and commit #abc — neither is a color.</p>;
}

export function SmallButAllowed({ active }: { active: boolean }) {
  return (
    <span class={cn("text-[10px] text-ink-subtle", active && "text-[11px]")}>
      ▸ <span class="text-[12px]">helper</span> <span class="text-xs">also 12px</span>
    </span>
  );
}

export function ShorthandAboveFloor() {
  return <span class="text-[13px]/5 text-[length:11px] [font-size:12px]">fine</span>;
}

export function PropertyValueWithoutColor() {
  const meta = { href: "#section-1", label: "Issue #1234" };
  return <a href={meta.href}>{meta.label}</a>;
}
