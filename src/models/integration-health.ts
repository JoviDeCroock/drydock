import { computed, createModel, signal } from "@preact/signals";
import { apiFetch } from "./api";

export type IntegrationHealthKind = "npm_token" | "github_installation";

export interface IntegrationHealthIssue {
  kind: IntegrationHealthKind;
  severity: "critical" | "warn";
  title: string;
  detail: string;
  occurredAt: string | null;
}

export const IntegrationHealthModel = createModel(() => {
  const issues = signal<IntegrationHealthIssue[]>([]);
  const loaded = signal(false);

  const hasIssues = computed(() => issues.value.length > 0);

  return {
    issues,
    loaded,
    hasIssues,

    async load(): Promise<void> {
      try {
        const data = await apiFetch<{ issues: IntegrationHealthIssue[] }>(
          "/api/v1/integration-health",
        );
        this.issues.value = data.issues;
      } catch {
        // The banner is best-effort; a failure to load it must not block the
        // dashboard. The underlying failures still surface in Settings.
        this.issues.value = [];
      } finally {
        this.loaded.value = true;
      }
    },
  };
});
