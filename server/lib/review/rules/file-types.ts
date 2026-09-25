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

function lowerBasename(path: string): string {
  return path.replaceAll("\\", "/").split("/").at(-1)?.toLowerCase() ?? "";
}

// Node parses `.json` even as a `main` or `require` target, so it never runs.
// package.json stays scanned: its scripts are commands that run.
export function isJsonDataPath(path: string): boolean {
  const basename = lowerBasename(path);
  return basename !== "package.json" && basename.endsWith(".json");
}

// Node runs any other extension as CommonJS when it is `node file.txt`, a
// `main`/`bin` target or `require('./file.css')`, so these are data only while
// nothing loads them. The caller decides that; this only names the formats.
const LOADABLE_DATA_EXTENSIONS = new Set([
  "css",
  "csv",
  "less",
  "lock",
  "map",
  "scss",
  "tsv",
  "txt",
  "xml",
]);

export function isLoadableDataPath(path: string): boolean {
  const basename = lowerBasename(path);
  const dot = basename.lastIndexOf(".");
  return dot > 0 && LOADABLE_DATA_EXTENSIONS.has(basename.slice(dot + 1));
}

// A browser runs only markup's script elements, inline event handlers and
// `javascript:` URLs; everything else (a generated docs page's `<pre>`
// examples) is text. Like the loadable data formats, Node runs the whole file
// if something loads it.
export function isMarkupPath(path: string): boolean {
  return /\.(?:html?|xhtml|svg)$/i.test(path);
}

const SCRIPT_OPEN = /<script(?=[\s/>])/gi;
// A script element closes only on `</script` followed by whitespace, `/` or `>`;
// `</scriptx>` inside a comment does not end it.
const SCRIPT_CLOSE = /<\/script(?=[\s/>])/gi;
// Attribute values a browser runs: inline event handlers and `javascript:` URLs.
// Whitespace appears once, inside the lookahead, so a long run after `=` is
// scanned once rather than once per backtrack.
const SCRIPT_ATTRIBUTE = /\bon[a-z]+\s*=|=(?=\s*(?:["']\s*)?javascript:)/gi;
const LEADING_WHITESPACE = /\s*/y;
const UNQUOTED_VALUE_END = /[\s>]/g;

// A browser decodes character references in attribute values and strips tabs
// and newlines from URLs before running them, so `&#101;val(`, `javascript&colon;`,
// `java&#x09;script:` and `java<TAB>script:` would hide code from the region
// scan. Markup using those forms in a script-capable attribute, or `srcdoc`
// (an escaped document), is scanned whole instead. `&amp;`, `&quot;`, `&apos;`,
// `&lt;`, `&gt;` and `&nbsp;` cannot spell code and stay allowed.
const SCRIPT_CAPABLE_ATTRIBUTE =
  /\b(?:on[a-z]+|href|src|action|formaction|xlink:href|to|values|from|by)\s*=/gi;
const CODE_SPELLING_REFERENCE = /&#|&(?!(?:amp|quot|apos|lt|gt|nbsp);)[a-z]+;/i;
const SPLIT_JAVASCRIPT_SCHEME =
  /j[\t\n\r]*a[\t\n\r]*v[\t\n\r]*a[\t\n\r]*s[\t\n\r]*c[\t\n\r]*r[\t\n\r]*i[\t\n\r]*p[\t\n\r]*t[\t\n\r]*:/i;

export function markupHidesScript(markup: string): boolean {
  if (/\bsrcdoc\s*=/i.test(markup)) return true;
  SCRIPT_CAPABLE_ATTRIBUTE.lastIndex = 0;
  for (
    let attribute = SCRIPT_CAPABLE_ATTRIBUTE.exec(markup);
    attribute;
    attribute = SCRIPT_CAPABLE_ATTRIBUTE.exec(markup)
  ) {
    const [start, end] = attributeValueBounds(markup, attribute.index + attribute[0].length);
    const value = markup.slice(start, end);
    if (CODE_SPELLING_REFERENCE.test(value)) return true;
    if (/[\t\n\r]/.test(value) && SPLIT_JAVASCRIPT_SCHEME.test(value)) return true;
    if (end === markup.length) break;
    SCRIPT_CAPABLE_ATTRIBUTE.lastIndex = Math.max(SCRIPT_CAPABLE_ATTRIBUTE.lastIndex, end);
  }
  return false;
}

// The value after an attribute's `=`: quoted up to its closing quote, or
// unquoted up to whitespace or `>`. An unclosed value runs to the end.
function attributeValueBounds(markup: string, afterEquals: number): [number, number] {
  LEADING_WHITESPACE.lastIndex = afterEquals;
  LEADING_WHITESPACE.exec(markup);
  const valueStart = LEADING_WHITESPACE.lastIndex;
  const quote = markup[valueStart];
  if (quote === '"' || quote === "'") {
    const close = markup.indexOf(quote, valueStart + 1);
    return [valueStart + 1, close === -1 ? markup.length : close];
  }
  UNQUOTED_VALUE_END.lastIndex = valueStart;
  return [valueStart, UNQUOTED_VALUE_END.exec(markup)?.index ?? markup.length];
}

// Keeps line numbers: every character outside a script region becomes a space
// or stays a newline, so a finding still points at its real line. Scans
// forward only: an unclosed opener or quote runs to the end and ends the scan,
// so adversarial markup cannot make this quadratic.
export function markupScriptText(markup: string): string {
  const ranges: Array<[number, number]> = [];
  SCRIPT_OPEN.lastIndex = 0;
  for (let open = SCRIPT_OPEN.exec(markup); open; open = SCRIPT_OPEN.exec(markup)) {
    const tagEnd = markup.indexOf(">", open.index);
    if (tagEnd === -1) break;
    SCRIPT_CLOSE.lastIndex = tagEnd + 1;
    const close = SCRIPT_CLOSE.exec(markup);
    ranges.push([tagEnd + 1, close ? close.index : markup.length]);
    if (!close) break;
    SCRIPT_OPEN.lastIndex = close.index + close[0].length;
  }
  SCRIPT_ATTRIBUTE.lastIndex = 0;
  for (
    let attribute = SCRIPT_ATTRIBUTE.exec(markup);
    attribute;
    attribute = SCRIPT_ATTRIBUTE.exec(markup)
  ) {
    const [start, end] = attributeValueBounds(markup, attribute.index + attribute[0].length);
    ranges.push([start, end]);
    if (end === markup.length) break;
    SCRIPT_ATTRIBUTE.lastIndex = Math.max(SCRIPT_ATTRIBUTE.lastIndex, end);
  }
  ranges.sort((a, b) => a[0] - b[0]);
  const blank = (text: string) => text.replace(/[^\n]/g, " ");
  let out = "";
  let cursor = 0;
  for (const [start, end] of ranges) {
    if (end <= cursor) continue;
    const from = Math.max(start, cursor);
    out += blank(markup.slice(cursor, from)) + markup.slice(from, end);
    cursor = end;
  }
  return out + blank(markup.slice(cursor));
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
