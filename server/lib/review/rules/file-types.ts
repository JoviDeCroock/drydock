const DOCUMENTATION_EXTENSIONS = new Set(["adoc", "asciidoc", "markdown", "md", "mdx", "rst"]);
const DOCUMENTATION_BASENAMES = new Set([
  "authors",
  "changelog",
  "changes",
  "code_of_conduct",
  "contributors",
  "copying",
  "history",
  "license",
  "licence",
  "notice",
  "readme",
  "security",
]);

export function isDocumentationPath(path: string): boolean {
  const basename = path.replaceAll("\\", "/").split("/").at(-1)?.toLowerCase() ?? "";
  if (!basename) return false;

  const dot = basename.lastIndexOf(".");
  if (dot > 0 && DOCUMENTATION_EXTENSIONS.has(basename.slice(dot + 1))) return true;
  if (dot > 0) return false;
  return DOCUMENTATION_BASENAMES.has(basename);
}

// Python packaging metadata files: an sdist's PKG-INFO (root or *.egg-info/),
// and a wheel's *.dist-info/METADATA. Their payload is the project
// long-description — README prose, not executable code — so running capability
// regexes over them only re-flags documentation (`requests.get(...)` examples,
// netrc mentions). The diff tree can collapse the versioned directory down to a
// bare ".egg-info"/".dist-info" segment, so the parent match allows an empty
// prefix. Secret scanning still applies at documentation (high-confidence)
// strength: a real token pasted into metadata must keep surfacing.
export function isPythonMetadataPath(path: string): boolean {
  const normalized = path.replaceAll("\\", "/").toLowerCase();
  if (/(^|\/)pkg-info$/.test(normalized)) return true;
  return /(^|\/)[^/]*\.(?:dist-info|egg-info)\/metadata$/.test(normalized);
}

const TEST_DIRECTORY_SEGMENTS = new Set(["test", "tests", "__tests__", "spec", "specs"]);

// Test-suite files shipped inside a package (a test runner's own test/ tree,
// __tests__ fixtures, *.spec.* files). They are scanned like any other file —
// malware does hide in test directories — but a capability hit in a test-only
// file that nothing consumer-facing can reach is weak evidence on its own, so
// the script rules demote (never drop) those findings.
export function isTestPath(path: string): boolean {
  const segments = path.replaceAll("\\", "/").replace(/^\.\//, "").toLowerCase().split("/");
  const withoutPackage = segments[0] === "package" ? segments.slice(1) : segments;
  if (withoutPackage.slice(0, -1).some((segment) => TEST_DIRECTORY_SEGMENTS.has(segment))) {
    return true;
  }
  const basename = withoutPackage.at(-1) ?? "";
  return /\.(?:test|spec)\.[^.]+$/.test(basename) || /^test[_-]/.test(basename);
}

// TypeScript declaration files (.d.ts/.d.cts/.d.mts) carry only type
// information: they are never executed by Node and are stripped by bundlers, so
// a payload would ship as .js, not .d.ts. We keep their text sample so the
// public API surface stays diffable, but exclude them from the content-scanning
// rules — running the normalizer and capability/secret regexes over large
// bundled declaration files is pure cost (perf/memory) with no detection value,
// and type signatures like `fetch(...)` would only yield false positives.
export function isTypeDeclarationPath(path: string): boolean {
  const basename = path.replaceAll("\\", "/").split("/").at(-1)?.toLowerCase() ?? "";
  return /\.d\.(?:c|m)?ts$/.test(basename);
}
