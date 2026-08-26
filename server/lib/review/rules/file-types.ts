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

export function isPythonMetadataPath(path: string): boolean {
  const normalized = path.replaceAll("\\", "/").toLowerCase();
  if (/(^|\/)pkg-info$/.test(normalized)) return true;
  return /(^|\/)[^/]*\.(?:dist-info|egg-info)\/metadata$/.test(normalized);
}

const BUILD_INFRASTRUCTURE_BASENAMES = new Set([
  "dockerfile",
  "containerfile",
  "jenkinsfile",
  "makefile",
  "gnumakefile",
  "vagrantfile",
  ".gitlab-ci.yml",
  ".gitlab-ci.yaml",
  ".travis.yml",
  "azure-pipelines.yml",
  "azure-pipelines.yaml",
  "cloudbuild.yaml",
  "appveyor.yml",
]);
const BUILD_INFRASTRUCTURE_DIRECTORIES = [
  ".github/workflows/",
  ".github/actions/",
  ".circleci/",
  ".buildkite/",
  ".devcontainer/",
];

export function isBuildInfrastructurePath(path: string): boolean {
  const normalized = path.replaceAll("\\", "/").replace(/^\.\//, "").toLowerCase();
  const withoutPackage = normalized.startsWith("package/") ? normalized.slice(8) : normalized;
  if (BUILD_INFRASTRUCTURE_DIRECTORIES.some((dir) => withoutPackage.includes(dir))) return true;

  const basename = withoutPackage.split("/").at(-1) ?? "";
  if (!basename) return false;
  if (BUILD_INFRASTRUCTURE_BASENAMES.has(basename)) return true;
  const stem = basename.split(".")[0];
  return stem === "dockerfile" || stem === "containerfile" || stem === "makefile";
}

const TEST_DIRECTORY_SEGMENTS = new Set(["test", "tests", "__tests__", "spec", "specs"]);

export function isTestPath(path: string): boolean {
  const segments = path.replaceAll("\\", "/").replace(/^\.\//, "").toLowerCase().split("/");
  const withoutPackage = segments[0] === "package" ? segments.slice(1) : segments;
  if (withoutPackage.slice(0, -1).some((segment) => TEST_DIRECTORY_SEGMENTS.has(segment))) {
    return true;
  }
  const basename = withoutPackage.at(-1) ?? "";
  return /\.(?:test|spec)\.[^.]+$/.test(basename) || /^test[_-]/.test(basename);
}

export function isTypeDeclarationPath(path: string): boolean {
  const basename = path.replaceAll("\\", "/").split("/").at(-1)?.toLowerCase() ?? "";
  return /\.d\.(?:c|m)?ts$/.test(basename);
}
