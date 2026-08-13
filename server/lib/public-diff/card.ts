import type { DiffEcosystem } from "../../../src/lib/package-diff-path";

// Builds the share card SVG for a public package diff. Pure string work: no
// network, no wasm, no environment access, so the layout is unit-testable
// without a rasterizer.
//
// Everything interpolated here is attacker-influenced (package names and
// version strings come from a public registry), so every value goes through
// escapeXml() and a width-aware truncation pass. resvg does not wrap or shrink
// text, so overflow is prevented here rather than by the renderer.

export const OG_CARD_WIDTH = 1200;
export const OG_CARD_HEIGHT = 630;

// docs/design.md light-mode tokens. The card is deliberately rendered in the default
// (light) surface: social clients composite previews on their own background
// and a dark card reads as an unrelated screenshot next to the site.
const COLOR = {
  bg: "#fafaf9",
  surface: "#ffffff",
  border: "#e7e5e4",
  fg: "#18181b",
  fgMuted: "#57534e",
  fgSubtle: "#6b6660",
  accent: "#c2410c",
  danger: "#dc2626",
  warn: "#b45309",
  info: "#2563eb",
  ok: "#15803d",
} as const;

export const OG_FONT_SANS = "Geist";
const OG_FONT_MONO = "Geist Mono";

// Static-asset paths for the two faces the card uses. They live here, next to
// the families the SVG references, so the renderer cannot load a font set that
// does not match what the layout asks for.
export const OG_FONT_ASSETS = {
  [OG_FONT_SANS]: "/fonts/Geist-SemiBold.ttf",
  [OG_FONT_MONO]: "/fonts/GeistMono-Medium.ttf",
} as const;

const PAD_X = 72;
const CONTENT_WIDTH = OG_CARD_WIDTH - PAD_X * 2;

// The card's kicker, per ecosystem. Deliberately not `ECOSYSTEM_LABELS`
// uppercased: this reads as a sentence about where the release lives, and atpm
// releases do not live in a registry at all.
const REGISTRY_LABELS: Partial<Record<DiffEcosystem, string>> = {
  npm: "NPM PACKAGE DIFF",
  pypi: "PYPI PACKAGE DIFF",
  atpm: "ATPM PACKAGE DIFF",
};

export type OgRiskLevel = "low" | "medium" | "high" | "critical";

export interface OgCardStats {
  filesChanged: number;
  added: number;
  removed: number;
  modified: number;
  findingCount: number;
  risk: OgRiskLevel;
}

export interface OgCardInput {
  ecosystem: DiffEcosystem;
  packageName: string;
  fromVersion: string;
  toVersion: string;
  // Absent when the diff has not been computed yet: the card still names the
  // package and the version pair, it just cannot claim any numbers.
  stats?: OgCardStats;
}

export function escapeXml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => {
    switch (char) {
      case "&":
        return "&amp;";
      case "<":
        return "&lt;";
      case ">":
        return "&gt;";
      case '"':
        return "&quot;";
      default:
        return "&apos;";
    }
  });
}

// Control characters have no glyph and can confuse the SVG parser; zero-width
// and bidi-override characters could visually reorder a package name into
// something it is not. Neither belongs on a card whose whole job is telling
// people what they are looking at. Written as a code-point scan rather than a
// character-class regex so the ranges stay readable and lint-clean.
function isUnsafeCardCodePoint(code: number): boolean {
  if (code < 0x20) return true; // C0 controls
  if (code >= 0x7f && code <= 0x9f) return true; // DEL + C1 controls
  if (code >= 0x200b && code <= 0x200f) return true; // zero-width + bidi marks
  if (code >= 0x202a && code <= 0x202e) return true; // bidi embedding/override
  return code >= 0x2066 && code <= 0x2069; // bidi isolates
}

export function sanitizeCardText(value: string): string {
  let out = "";
  for (const char of value) {
    if (!isUnsafeCardCodePoint(char.codePointAt(0) ?? 0)) out += char;
  }
  return out;
}

// Coarse advance-width model, in em units. resvg does the real shaping; this
// only has to be conservative enough that a fitted line never overflows. The
// sans values approximate Geist SemiBold; Geist Mono is a fixed 0.6em advance.
const NARROW_CHARS = new Set(" !',./:;[]|ijlt(){}-`".split(""));
const WIDE_CHARS = new Set("@mwMW%".split(""));

function charWidthEm(char: string, mono: boolean): number {
  if (mono) return 0.6;
  if (NARROW_CHARS.has(char)) return 0.34;
  if (WIDE_CHARS.has(char)) return 0.92;
  if (char >= "A" && char <= "Z") return 0.68;
  if (char >= "0" && char <= "9") return 0.6;
  return 0.56;
}

export function estimateTextWidth(text: string, fontSize: number, mono: boolean): number {
  let em = 0;
  for (const char of text) em += charWidthEm(char, mono);
  return em * fontSize;
}

export interface FittedText {
  text: string;
  fontSize: number;
}

// Picks the largest candidate size at which the text fits, then ellipsizes at
// the smallest size if nothing fits. Truncation keeps the head of the string:
// for `@scope/name` the scope is the part that identifies the package.
export function fitText(
  text: string,
  maxWidth: number,
  sizes: readonly number[],
  mono: boolean,
): FittedText {
  const candidates = [...sizes].sort((a, b) => b - a);
  const smallest = candidates.at(-1) ?? 16;
  for (const fontSize of candidates) {
    if (estimateTextWidth(text, fontSize, mono) <= maxWidth) return { text, fontSize };
  }
  const chars = [...text];
  while (chars.length > 1) {
    chars.pop();
    const candidate = `${chars.join("")}…`;
    if (estimateTextWidth(candidate, smallest, mono) <= maxWidth) {
      return { text: candidate, fontSize: smallest };
    }
  }
  return { text: "…", fontSize: smallest };
}

function riskColor(risk: OgRiskLevel): string {
  switch (risk) {
    case "critical":
    case "high":
      return COLOR.danger;
    case "medium":
      return COLOR.warn;
    default:
      return COLOR.info;
  }
}

function findingsValue(stats: OgCardStats): { text: string; color: string } {
  if (stats.findingCount === 0) return { text: "none", color: COLOR.ok };
  const noun = stats.findingCount === 1 ? "finding" : "findings";
  return { text: `${stats.findingCount} ${noun}`, color: riskColor(stats.risk) };
}

interface TextOptions {
  x: number;
  y: number;
  size: number;
  color: string;
  mono?: boolean;
  anchor?: "start" | "end";
  letterSpacing?: number;
}

function text(raw: string, options: TextOptions): string {
  const attrs = [
    `x="${options.x}"`,
    `y="${options.y}"`,
    `font-family="${options.mono ? OG_FONT_MONO : OG_FONT_SANS}"`,
    `font-size="${options.size}"`,
    `font-weight="${options.mono ? 500 : 600}"`,
    `fill="${options.color}"`,
  ];
  if (options.anchor === "end") attrs.push(`text-anchor="end"`);
  if (options.letterSpacing) attrs.push(`letter-spacing="${options.letterSpacing}"`);
  return `<text ${attrs.join(" ")}>${escapeXml(raw)}</text>`;
}

const TILE_Y = 360;
const TILE_HEIGHT = 120;
const TILE_GAP = 24;
const TILE_WIDTH = (CONTENT_WIDTH - TILE_GAP * 2) / 3;

function tile(index: number, label: string, value: string, valueColor: string): string {
  const x = PAD_X + index * (TILE_WIDTH + TILE_GAP);
  const fitted = fitText(value, TILE_WIDTH - 48, [34, 30, 26, 22], false);
  return [
    `<rect x="${x}" y="${TILE_Y}" width="${TILE_WIDTH}" height="${TILE_HEIGHT}" rx="3" fill="${COLOR.surface}" stroke="${COLOR.border}" stroke-width="1"/>`,
    text(label, {
      x: x + 24,
      y: TILE_Y + 42,
      size: 16,
      color: COLOR.fgSubtle,
      mono: true,
      letterSpacing: 1.6,
    }),
    text(fitted.text, { x: x + 24, y: TILE_Y + 92, size: fitted.fontSize, color: valueColor }),
  ].join("");
}

function changeSummary(stats: OgCardStats): string {
  const parts: string[] = [];
  if (stats.added) parts.push(`+${stats.added}`);
  if (stats.modified) parts.push(`~${stats.modified}`);
  if (stats.removed) parts.push(`-${stats.removed}`);
  return parts.length ? parts.join(" ") : "none";
}

export function renderOgCardSvg(input: OgCardInput): string {
  const packageName = sanitizeCardText(input.packageName);
  const fromVersion = sanitizeCardText(input.fromVersion);
  const toVersion = sanitizeCardText(input.toVersion);

  const name = fitText(packageName, CONTENT_WIDTH, [72, 60, 52, 44, 36], false);
  const versions = fitText(
    `${fromVersion} → ${toVersion}`,
    CONTENT_WIDTH,
    [34, 30, 26, 22, 18],
    true,
  );
  const registryLabel = REGISTRY_LABELS[input.ecosystem] ?? "NPM PACKAGE DIFF";

  const body = input.stats
    ? [
        tile(0, "FILES CHANGED", String(input.stats.filesChanged), COLOR.fg),
        tile(1, "ADDED / MODIFIED / REMOVED", changeSummary(input.stats), COLOR.fg),
        tile(
          2,
          "DETERMINISTIC FINDINGS",
          findingsValue(input.stats).text,
          findingsValue(input.stats).color,
        ),
      ].join("")
    : // Mono, matching the site's MonoDetail idiom: only the SemiBold sans face
      // ships, so a "regular weight" sentence here would silently render bold.
      text("file-by-file diff · deterministic supply-chain findings", {
        x: PAD_X,
        y: TILE_Y + 48,
        size: 24,
        color: COLOR.fgMuted,
        mono: true,
      });

  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${OG_CARD_WIDTH}" height="${OG_CARD_HEIGHT}" viewBox="0 0 ${OG_CARD_WIDTH} ${OG_CARD_HEIGHT}">`,
    `<rect width="${OG_CARD_WIDTH}" height="${OG_CARD_HEIGHT}" fill="${COLOR.bg}"/>`,
    // Brand mark: the one saturated orange element on the card (docs/design.md).
    `<rect x="${PAD_X}" y="66" width="22" height="22" rx="3" fill="${COLOR.accent}"/>`,
    text("Drydock", { x: PAD_X + 36, y: 85, size: 28, color: COLOR.fg }),
    text(registryLabel, {
      x: OG_CARD_WIDTH - PAD_X,
      y: 84,
      size: 18,
      color: COLOR.fgSubtle,
      mono: true,
      anchor: "end",
      letterSpacing: 1.8,
    }),
    `<line x1="${PAD_X}" y1="116" x2="${OG_CARD_WIDTH - PAD_X}" y2="116" stroke="${COLOR.border}" stroke-width="1"/>`,
    text(name.text, {
      x: PAD_X,
      y: 250,
      size: name.fontSize,
      color: COLOR.fg,
      letterSpacing: -(name.fontSize * 0.03),
    }),
    text(versions.text, {
      x: PAD_X,
      y: 316,
      size: versions.fontSize,
      color: COLOR.fgMuted,
      mono: true,
    }),
    body,
    `<line x1="${PAD_X}" y1="540" x2="${OG_CARD_WIDTH - PAD_X}" y2="540" stroke="${COLOR.border}" stroke-width="1"/>`,
    text("drydock.org", { x: PAD_X, y: 582, size: 22, color: COLOR.fg, mono: true }),
    text("no account required", {
      x: OG_CARD_WIDTH - PAD_X,
      y: 582,
      size: 20,
      color: COLOR.fgSubtle,
      mono: true,
      anchor: "end",
    }),
    `</svg>`,
  ].join("");
}
