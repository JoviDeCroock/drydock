/**
 * Dashboard URL of one package's release view.
 *
 * A scoped npm name carries a `/`, so the whole name travels as a single
 * percent-encoded path segment (`/dashboard/packages/%40scope%2Fname`);
 * `preact-iso` and Hono both decode the `:name` param back to `@scope/name`.
 * The ecosystem rides in the query only when it is not npm, so the common
 * link stays short and the page can default the same way the API does.
 */
export function packageReleasesPath(packageName: string, ecosystem?: string | null): string {
  const path = `/dashboard/packages/${encodeURIComponent(packageName)}`;
  return ecosystem && ecosystem !== "npm"
    ? `${path}?ecosystem=${encodeURIComponent(ecosystem)}`
    : path;
}

export function packageReleasesApiPath(
  packageName: string,
  options: { ecosystem?: string | null; cursor?: string | null; limit?: number } = {},
): string {
  const params = new URLSearchParams();
  if (options.ecosystem && options.ecosystem !== "npm") params.set("ecosystem", options.ecosystem);
  if (options.cursor) params.set("cursor", options.cursor);
  if (options.limit) params.set("limit", String(options.limit));
  const qs = params.toString();
  return `/api/v1/packages/${encodeURIComponent(packageName)}/releases${qs ? `?${qs}` : ""}`;
}
