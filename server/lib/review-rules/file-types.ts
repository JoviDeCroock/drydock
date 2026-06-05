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
