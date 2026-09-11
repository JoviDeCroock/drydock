// Every color here leaves the docs/design.md token system.
// Line numbers are asserted in test/oxlint-design-tokens.test.mjs.
import { cn } from "./cn";

export function PaletteText() {
  return <span class="text-red-600">danger</span>;
}

export function PaletteWithVariant() {
  return <div class="hover:bg-zinc-100 dark:border-slate-700">hover</div>;
}

export function ArbitraryHex() {
  return <div class="bg-[#fafafa]">surface</div>;
}

export function ArbitraryFunction() {
  return <div class="shadow-[0_0_0_1px_rgba(0,0,0,0.2)]">ring</div>;
}

export function InlineStyle() {
  return <div style={{ borderColor: "#e4e4e7" }}>rule</div>;
}

export function InlineStyleFunction() {
  return <div style={{ color: "rgb(24, 24, 27)" }}>ink</div>;
}

export function InlineStyleEmbedded() {
  return <div style={{ boxShadow: "0 0 0 1px #e4e4e7", border: "1px solid rgb(0,0,0)" }}>x</div>;
}

export function StyleMap() {
  const styles = { background: "linear-gradient(#fff, #000)" };
  return <div style={styles}>gradient</div>;
}

export function SaturatedText() {
  return <span class="text-warn">amber label</span>;
}

export function SaturatedTextInMap() {
  const tones = { ok: "bg-ok-soft text-ok", danger: "text-danger-text" };
  return <span class={tones.ok}>ok</span>;
}

export function SaturatedTextInCn({ active }: { active: boolean }) {
  return <span class={cn("font-mono", active && "text-info/80")}>info</span>;
}

export function TemplateClass({ size }: { size: string }) {
  return <span class={`text-emerald-500 ${size}`}>template</span>;
}
