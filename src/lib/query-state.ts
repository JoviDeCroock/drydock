export type QueryUpdates = Record<string, string | null | undefined>;

export function buildQueryUrl(updates: QueryUpdates): string {
  const params = new URLSearchParams(window.location.search);
  for (const [key, value] of Object.entries(updates)) {
    if (value === null || value === undefined || value === "") {
      params.delete(key);
    } else {
      params.set(key, value);
    }
  }
  const search = params.toString();
  return window.location.pathname + (search ? `?${search}` : "");
}

export function currentLocationKey(): string {
  return window.location.pathname + window.location.search;
}
