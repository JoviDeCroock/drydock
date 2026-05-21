# Design System — staged-publish-review

Source of truth for visual decisions in this repo. Read this before changing fonts, colors, spacing, or aesthetics. Do not deviate without explicit approval.

## Product Context

- **What this is:** A second pair of eyes before `npm publish`. A staged npm tarball is scanned, deterministic rules flag risky content, AI reviews changed files, and a human approves or rejects the publish.
- **Who it's for:** Package authors, security-conscious maintainers, and reviewers at companies that publish packages to the public registry.
- **Space/industry:** Supply-chain security / developer tooling. Adjacent products: Socket, Snyk Advisor, Aikido, GitHub Advisory Database, vlt.sh.
- **Project type:** Web app first (the scan workbench), marketing landing layered on the same system later.

## Aesthetic Direction

- **Direction:** Restrained dev-tool — confident sans typography, a single sharp accent color, severity carries the chromatic weight. Sits between a SaaS dashboard and a security advisory document.
- **Decoration level:** Minimal. Type and a single mono detail line (scan ID · timestamp · file count) do the work. No gradients, no icon-in-circle motifs, no decorative chrome.
- **Mood:** Sober, fast, trustworthy. Looks like a tool an engineer would keep open during a publish — not a marketing splash.
- **Reference observation:** Peer security tools converge on violet gradients + dashboard grids. This system breaks from the pack by replacing violet with orange and by giving each scan its own focused report layout rather than a sprawling dashboard.

## Typography

- **Display & Body:** Geist (weights 400, 500, 600). Loaded from Google Fonts. Modern, neutral, developer-readable, no licensing concerns.
- **Mono:** Geist Mono (weights 400, 500, 600). Used for file paths, severity labels, scan IDs, timestamps, code, and section labels — mono is a first-class typeface here, not just a code fallback.
- **Loading:** `https://fonts.googleapis.com/css2?family=Geist:wght@400;500;600;700&family=Geist+Mono:wght@400;500;600&display=swap`. Self-host if the marketing site needs it.
- **Feature settings:** `font-feature-settings: "ss01", "cv11"` for Geist (humanist alts), `"ss01", "tnum"` for Geist Mono (tabular numbers — essential for data rows).

### Scale

| Role | Size | Weight | Letter-spacing | Line-height |
|---|---|---|---|---|
| Display 1 (hero) | 44–56px | 600 | -0.03em | 1.05 |
| Display 2 | 32px | 600 | -0.02em | 1.15 |
| Heading 1 | 24px | 600 | -0.015em | 1.25 |
| Heading 2 | 18px | 500 | -0.01em | 1.35 |
| Body | 14px | 400 | 0 | 1.55 |
| Body sm | 13px | 400 | 0 | 1.5 |
| Mono code | 13px | 400/500 | 0 | 1.5 |
| Mono label | 11px (uppercase) | 500 | 0.1em | 1.4 |

## Color

- **Approach:** Restrained. One brand accent for action, severity colors do the rest. Light and dark are both first-class — auto-follow `prefers-color-scheme` by default.

### Light mode (default surface)

| Token | Hex | Usage |
|---|---|---|
| `--bg` | `#fafaf9` | Page background (warm paper-ish) |
| `--bg-elev` | `#ffffff` | Cards, inputs |
| `--bg-elev-2` | `#f4f4f5` | Secondary surfaces, button-secondary |
| `--border` | `#e7e5e4` | Default borders |
| `--border-strong` | `#d6d3d1` | Hover borders, dividers |
| `--fg` | `#18181b` | Primary text |
| `--fg-muted` | `#57534e` | Secondary text |
| `--fg-subtle` | `#a8a29e` | Tertiary text, labels |

### Dark mode

| Token | Hex | Usage |
|---|---|---|
| `--bg` | `#0a0a0a` | Page background |
| `--bg-elev` | `#141414` | Cards |
| `--bg-elev-2` | `#1c1c1c` | Secondary surfaces |
| `--border` | `#27272a` | Default borders |
| `--border-strong` | `#3f3f46` | Hover borders |
| `--fg` | `#fafafa` | Primary text |
| `--fg-muted` | `#a1a1aa` | Secondary text |
| `--fg-subtle` | `#71717a` | Tertiary text |

### Accent (brand action)

| Token | Light | Dark | Usage |
|---|---|---|---|
| `--accent` | `#ea580c` (orange-600) | `#fb923c` (orange-400) | Primary buttons, focus rings, active nav, brand mark |
| `--accent-hover` | `#c2410c` | `#fdba74` | Hover state |
| `--accent-soft` | `#fff7ed` | `rgba(251, 146, 60, 0.12)` | Focus ring background, soft fills |
| `--accent-on` | `#ffffff` | `#18181b` | Text on accent background |

**Why orange, not purple:** Every peer security tool (Socket, Snyk, Aikido) leans on violet. Orange differentiates without sacrificing the "caution / pre-flight" connotation. It is *not* a severity color — severity stays red/amber/blue/green.

### Severity (semantic)

| Token | Light | Dark | Soft (light / dark) | Usage |
|---|---|---|---|---|
| `--danger` | `#dc2626` | `#f87171` | `#fee2e2` / `rgba(239, 68, 68, 0.14)` | Critical, High |
| `--warn` | `#d97706` | `#fbbf24` | `#fef3c7` / `rgba(251, 191, 36, 0.14)` | Medium |
| `--info` | `#2563eb` | `#60a5fa` | `#dbeafe` / `rgba(96, 165, 250, 0.14)` | Low, Info |
| `--ok` | `#16a34a` | `#4ade80` | `#dcfce7` / `rgba(74, 222, 128, 0.14)` | Passed, no findings |

**Rule:** Severity colors are reserved for severity meaning. Never use red for a decorative accent, never use the orange accent to flag a finding. Color = signal.

### Dark mode strategy

Don't naively invert. Surfaces darken (true neutrals, no warm tint), accent + severity colors lighten by one tone and drop saturation ~10%, soft fills become low-opacity overlays of the same hue. Borders remain visible — never collapse to pure black.

## Spacing

- **Base unit:** 4px.
- **Density:** Comfortable for forms and report sections; dense for diff rows and finding lists.
- **Scale:** `2xs(2) xs(4) sm(8) md(12) lg(16) xl(24) 2xl(32) 3xl(48) 4xl(64) 5xl(96)`.

## Layout

- **Approach:** Grid-disciplined for app surfaces. Marketing pages get more whitespace and a deliberate single-column hero column.
- **Grid:** 12-column, 24px gutters. App content max-width `1160px`. Report bodies sit comfortably inside `~880px`. Marketing hero copy capped at `760px` so headings remain typographically scaled.
- **Border radius:**
  - `0` — Severity badges and document-style elements (squarish, terminal-adjacent — not pills).
  - `3–4px` — Small chrome (inline mono pills, file-path tags).
  - `6px` — Buttons, inputs.
  - `8px` — Cards, alerts, larger surfaces.
  - `10px` — Mockup/window shells.
  - `999px` — Reserved for true circle elements (avatars, toggle handles). Avoid for badges.

## Motion

- **Approach:** Minimal-functional. Animation supports comprehension; it does not entertain.
- **Easing:** enter `ease-out`, exit `ease-in`, move `ease-in-out`.
- **Duration:** micro `100ms` (hover/focus), short `150ms` (default), medium `250ms` (entrance), long — avoid.
- **Patterns:**
  - Hover/focus → 150ms color & border transitions.
  - Findings appear → fade-in via opacity, no slide.
  - Scan progress → indeterminate bar or pulsing mono counter, not a spinner.
  - Theme toggle → instant. No transition on color-scheme change.

## Components — non-obvious rules

- **Badges:** Squarish (3px radius), uppercase Geist Mono 10-11px, weight 600, letter-spacing 0.08–0.1em. Severity variants use the soft fill + saturated text color combo. Pill badges (`border-radius: 999px`) are deprecated in this repo.
- **Buttons:** 6px radius, 8–12px vertical / 14–18px horizontal padding. Primary uses `--accent`; secondary uses `--bg-elev-2` with a border; ghost is text-only on hover; danger uses `--danger` (only for destructive actions like Reject publish).
- **Inputs:** 6px radius, `--bg` background (intentionally lighter than the card it sits on for affordance), focus ring is a 3px `--accent-soft` halo + accent border. No inner shadow, no glow.
- **Section labels:** A small mono uppercase label with a trailing rule. Replaces the SaaS-default H1/H2 stack with something more document-shaped.
- **Mono detail line:** Many surfaces have a one-line mono caption directly under the title (`scan_01HXY... · 2026-05-21 · 17 files`). This is the system's signature treatment — treat it like a generated metadata line, not a subtitle.
- **Alerts:** 6px radius, 1px colored border, soft background fill, the icon is a 16px filled circle in the alert's color. Inline strong-tag retains body color.

## Anti-patterns — do not introduce

- Violet/purple as the primary accent. The previous `--accent: #7c5cff` is retired.
- Gradient buttons or gradient hero backgrounds.
- Bubbly border-radius (`9999px`) on badges or buttons.
- Icon-in-colored-circle three-column feature grids.
- "AI" / "AI-powered" badges as decorative flourish.
- Stock-photo hero treatments.
- Decorative use of severity colors (red as accent, etc.). Color = signal here.

## Decisions Log

| Date | Decision | Rationale |
|---|---|---|
| 2026-05-21 | Initial design system created via `/design-consultation`. | Replaces ad-hoc `src/style.css` palette. Moves brand off the SaaS-default violet, makes Geist + Geist Mono official, and locks severity semantics so they cannot drift. |
| 2026-05-21 | Accent: orange `#ea580c` over violet. | Differentiates from Socket/Snyk/Aikido violet convergence; preserves "caution / pre-flight" semantics; non-overlapping with severity colors. |
| 2026-05-21 | Light is the default surface; dark is first-class via `prefers-color-scheme`. | Auto-mode chosen by user. Both modes must be designed, not derived. |
| 2026-05-21 | Squarish badges (3px), not pills. | Echoes terminal/document feel. Pill badges read as SaaS-generic. |
