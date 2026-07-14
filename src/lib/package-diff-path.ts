export interface DiffSpec {
  packageName: string;
  fromVersion: string;
  toVersion: string;
}

export function packageDiffPath(packageName: string, fromVersion: string, toVersion: string) {
  const name = packageName
    .split("/")
    .map((segment) => encodeURIComponent(segment).replace(/^%40/, "@"))
    .join("/");
  return `/diff/${name}/${encodeURIComponent(fromVersion)}/${encodeURIComponent(toVersion)}`;
}

// /diff/<name>/<from>/<to>, where a scoped <name> spans two path segments
// (/diff/@scope/pkg/1.0.0/1.1.0). Anything else (including bare /diff) is the
// landing form.
export function parseDiffSpec(path: string): DiffSpec | null {
  if (path !== "/diff" && !path.startsWith("/diff/")) return null;
  const segments = path
    .slice("/diff".length)
    .split("/")
    .filter(Boolean)
    .map((segment) => {
      try {
        return decodeURIComponent(segment);
      } catch {
        return segment;
      }
    });
  if (!segments.length) return null;
  const nameSegmentCount = segments[0].startsWith("@") ? 2 : 1;
  if (segments.length !== nameSegmentCount + 2) return null;
  return {
    packageName: segments.slice(0, nameSegmentCount).join("/"),
    fromVersion: segments[nameSegmentCount],
    toVersion: segments[nameSegmentCount + 1],
  };
}
