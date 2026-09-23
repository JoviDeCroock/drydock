/**
 * Absolute dashboard links for notification bodies. Every link is rooted at
 * `BETTER_AUTH_URL`; when that is unset or malformed the builders return null
 * and the caller drops the line rather than emitting a relative or broken URL
 * into an email.
 */
function appUrl(
  env: Cloudflare.Env,
  path: string,
  params: Record<string, string | undefined>,
): string | null {
  const base = env.BETTER_AUTH_URL;
  if (typeof base !== "string" || !base) return null;
  try {
    const url = new URL(path, base);
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined) url.searchParams.set(key, value);
    }
    return url.toString();
  } catch {
    return null;
  }
}

export function scanUrl(
  env: Cloudflare.Env,
  scanId: string,
  organizationId?: string,
): string | null {
  return appUrl(env, `/dashboard/scans/${encodeURIComponent(scanId)}`, { org: organizationId });
}

export function dashboardUrl(env: Cloudflare.Env, organizationId: string): string | null {
  return appUrl(env, "/dashboard", { org: organizationId });
}

export function settingsUrl(env: Cloudflare.Env, organizationId?: string): string | null {
  return appUrl(env, "/dashboard/settings", { tab: "integrations", org: organizationId });
}

export function inviteAcceptUrl(env: Cloudflare.Env, token: string): string | null {
  return appUrl(env, "/dashboard/invite", { token });
}
