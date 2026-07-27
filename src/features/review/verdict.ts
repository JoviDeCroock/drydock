/**
 * Text color for a verdict headline, keyed by risk level or recommendation tone.
 *
 * Shared by the dashboard's recommendation card and the public report page.
 * These drifted while they were two copies — one mapped `low`/`info` to
 * `text-info-text` and the other fell through to `text-ink` — so the same
 * release rendered a different color depending on which surface you read it on.
 */
export function verdictTextClass(risk: string): string {
  switch (risk) {
    case "critical":
    case "high":
      return "text-danger-text";
    case "medium":
      return "text-warn-text";
    case "ok":
      return "text-ok-text";
    default:
      return "text-ink";
  }
}
