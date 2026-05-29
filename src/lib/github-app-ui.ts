// The GitHub App settings UI (PyPI workflow-gate flow) is not generally
// available yet, so it is hidden in production. These organizations are
// allowlisted to exercise the flow on production before GA.
export const GITHUB_APP_UI_ALLOWLIST: ReadonlySet<string> = new Set([
  "personal:vMEkEjmZLH960ddSJzfT6N8Jxw2jTuHQ",
]);

export function isGithubAppUiEnabled(organizationId: string | null | undefined): boolean {
  if (import.meta.env.DEV) return true;
  return organizationId != null && GITHUB_APP_UI_ALLOWLIST.has(organizationId);
}
