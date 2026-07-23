export type DiffEcosystem = "npm" | "pypi";

export interface DiffSpec {
  ecosystem: DiffEcosystem;
  packageName: string;
  fromVersion: string;
  toVersion: string;
}

// npm keeps the historical un-prefixed form (/diff/<name>/<from>/<to>) so
// existing links and indexed pages keep resolving; PyPI diffs live under
// /diff/pypi/<project>/<from>/<to>. The forms cannot collide: an npm package
// literally named "pypi" still parses as npm because its path has one fewer
// segment than the prefixed PyPI form.
export function packageDiffPath(
  ecosystem: DiffEcosystem,
  packageName: string,
  fromVersion: string,
  toVersion: string,
) {
  const name = packageName
    .split("/")
    .map((segment) => encodeURIComponent(segment).replace(/^%40/, "@"))
    .join("/");
  const prefix = ecosystem === "pypi" ? "/diff/pypi" : "/diff";
  return `${prefix}/${name}/${encodeURIComponent(fromVersion)}/${encodeURIComponent(toVersion)}`;
}

// /diff/<name>/<from>/<to> for npm, where a scoped <name> spans two path
// segments (/diff/@scope/pkg/1.0.0/1.1.0); /diff/pypi/<project>/<from>/<to>
// for PyPI. Anything else (including bare /diff) is the landing form.
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
  if (segments[0] === "pypi" && segments.length === 4) {
    return {
      ecosystem: "pypi",
      packageName: segments[1],
      fromVersion: segments[2],
      toVersion: segments[3],
    };
  }
  const nameSegmentCount = segments[0].startsWith("@") ? 2 : 1;
  if (segments.length !== nameSegmentCount + 2) return null;
  return {
    ecosystem: "npm",
    packageName: segments.slice(0, nameSegmentCount).join("/"),
    fromVersion: segments[nameSegmentCount],
    toVersion: segments[nameSegmentCount + 1],
  };
}
