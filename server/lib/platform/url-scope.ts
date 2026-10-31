/**
 * `url`'s path relative to `base`, or null when `url` is outside `base`: a
 * different origin, or a same-origin path that is not `base`'s path or below
 * it. A service hosted under a path (a registry behind a reverse proxy at
 * `/npm`) owns only that subtree of its origin, so a credential scoped to the
 * service must not follow a URL into the rest of it. Both URLs come from the
 * WHATWG parser, which has already resolved dot segments.
 */
export function pathWithinBaseUrl(url: URL, base: URL): string | null {
  if (url.origin !== base.origin) return null;
  const basePath = base.pathname.replace(/\/+$/, "");
  if (!basePath) return url.pathname;
  return url.pathname.startsWith(`${basePath}/`) ? url.pathname.slice(basePath.length) : null;
}
