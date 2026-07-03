// Focused parser for `Gem::Specification#to_yaml` (Psych) output, the YAML that
// ships inside a `.gem`'s `metadata.gz` member. We deliberately do NOT pull in a
// general YAML library: the gemspec layout is highly regular and entirely
// attacker-controlled, so a small, defensive, line-oriented reader that only
// understands the handful of shapes Psych emits is both safer and lets us keep
// running in the credentials-free sandbox's constrained globals if needed. Every
// field degrades to null/[] on an unexpected shape rather than throwing, so a
// malformed gemspec surfaces as `metadata-missing` (a finding) instead of a
// pipeline crash.

export interface GemspecDependency {
  name: string;
  /** Ruby dependency type symbol without the leading colon: "runtime" | "development" | other. */
  type: string;
}

export interface GemspecSummary {
  name: string | null;
  version: string | null;
  /** "ruby" for a pure-ruby gem, otherwise a platform tag like "x86_64-linux". */
  platform: string | null;
  bindir: string | null;
  homepage: string | null;
  executables: string[];
  extensions: string[];
  requirePaths: string[];
  licenses: string[];
  /** Free-form system requirements (`spec.requirements`), e.g. "libmagic". */
  requirements: string[];
  /** Best-effort rendering of `required_ruby_version`, e.g. ">= 2.7.0". */
  requiredRubyVersion: string | null;
  dependencies: GemspecDependency[];
  /** The gemspec `metadata` hash (allowed_push_host, *_uri, …). */
  metadata: Record<string, string>;
}

interface TopLevelBlock {
  inline: string | null;
  body: string[];
}

// A document-root mapping key: an identifier at column 0 followed by `:`.
// Nested mapping keys (indented) and sequence items (`- …`) never match, so they
// stay attached to the preceding top-level key's block.
const TOP_KEY_RE = /^([A-Za-z_][A-Za-z0-9_]*):(?:[ \t]+(.*))?$/;

export function emptyGemspecSummary(): GemspecSummary {
  return {
    name: null,
    version: null,
    platform: null,
    bindir: null,
    homepage: null,
    executables: [],
    extensions: [],
    requirePaths: [],
    licenses: [],
    requirements: [],
    requiredRubyVersion: null,
    dependencies: [],
    metadata: {},
  };
}

export function parseGemspecMetadata(yaml: string | null | undefined): GemspecSummary {
  const summary = emptyGemspecSummary();
  if (!yaml || typeof yaml !== "string") return summary;

  const blocks = collectTopLevelBlocks(yaml);
  if (!blocks) return summary;

  summary.name = scalar(blocks.get("name")?.inline);
  summary.platform = scalar(blocks.get("platform")?.inline);
  summary.bindir = scalar(blocks.get("bindir")?.inline);
  summary.homepage = scalar(blocks.get("homepage")?.inline);
  summary.version = parseGemVersion(blocks.get("version"));
  summary.executables = parseScalarList(blocks.get("executables"));
  summary.extensions = parseScalarList(blocks.get("extensions"));
  summary.requirePaths = parseScalarList(blocks.get("require_paths"));
  summary.licenses = parseScalarList(blocks.get("licenses"));
  summary.requirements = parseScalarList(blocks.get("requirements"));
  summary.dependencies = parseDependencies(blocks.get("dependencies"));
  summary.metadata = parseMetadataMap(blocks.get("metadata"));
  summary.requiredRubyVersion = parseRequirement(blocks.get("required_ruby_version"));

  return summary;
}

// Returns null when the document contains a root-level construct this parser
// does not model but Psych does — quoted or escaped mapping keys, explicit
// `? key` syntax, directives, or a second YAML document. Psych applies
// last-key-wins across key spellings and reads only the first document, so
// silently skipping such a line would let a crafted spec show this parser one
// identity while `gem push` publishes under another. Psych's own
// Gem::Specification output never emits these shapes, so real gems are
// unaffected and a crafted one degrades to a missing identity (fail closed).
function collectTopLevelBlocks(yaml: string): Map<string, TopLevelBlock> | null {
  const blocks = new Map<string, TopLevelBlock>();
  let current: TopLevelBlock | null = null;
  for (const line of yaml.replace(/\r\n/g, "\n").split("\n")) {
    if (line === "---" || line.startsWith("--- ") || line.startsWith("...")) {
      // A marker is only valid as the document opener; after content it starts
      // a second document, which Psych would ignore but we would keep reading.
      if (blocks.size > 0 || current) return null;
      continue;
    }
    const match = TOP_KEY_RE.exec(line);
    if (match) {
      current = { inline: match[2] !== undefined ? match[2] : null, body: [] };
      // Last write wins; a duplicate top-level key in a crafted spec keeps the
      // later value, matching Psych's own last-key-wins mapping behavior.
      blocks.set(match[1], current);
      continue;
    }
    // Root-level lines that are neither a bare key, a sequence item, blank,
    // nor indented continuation are the unmodeled-key shapes described above.
    if (line && !/^[ \t]/.test(line) && !/^-(?: |$)/.test(line)) return null;
    if (current) current.body.push(line);
  }
  return blocks;
}

// Unwrap a Psych scalar: trim, drop a bare type tag (`!ruby/object:…`), and
// remove the single/double quotes Psych adds around values that need them.
function scalar(raw: string | null | undefined): string | null {
  if (raw == null) return null;
  const trimmed = raw.trim();
  if (!trimmed || trimmed.startsWith("!")) return null;
  if (trimmed.startsWith('"') && trimmed.endsWith('"') && trimmed.length >= 2) {
    return trimmed.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, "\\") || null;
  }
  if (trimmed.startsWith("'") && trimmed.endsWith("'") && trimmed.length >= 2) {
    return trimmed.slice(1, -1).replace(/''/g, "'") || null;
  }
  return trimmed || null;
}

// `version` is a `!ruby/object:Gem::Version` whose scalar lives on a nested
// `version:` line; tolerate an inline scalar too for hand-written specs.
function parseGemVersion(block: TopLevelBlock | undefined): string | null {
  if (!block) return null;
  const inline = scalar(block.inline);
  if (inline) return inline;
  for (const line of block.body) {
    const match = /^\s+version:\s*(.+)$/.exec(line);
    if (match) return scalar(match[1]);
  }
  return null;
}

// A block sequence of scalars at the document root (`- item` lines at column 0).
// Empty lists render inline as `[]`.
function parseScalarList(block: TopLevelBlock | undefined): string[] {
  if (!block) return [];
  if (block.inline && block.inline.trim() === "[]") return [];
  const items: string[] = [];
  for (const line of block.body) {
    const match = /^- (.+)$/.exec(line);
    if (match) {
      const value = scalar(match[1]);
      if (value) items.push(value);
    }
  }
  return items;
}

// Each dependency is a `- !ruby/object:Gem::Dependency` item (new item at column
// 0) with indented `name:`/`type:` lines. We capture only name + type; the
// nested `requirement:`/`version_requirements:` blocks are intentionally ignored.
function parseDependencies(block: TopLevelBlock | undefined): GemspecDependency[] {
  if (!block) return [];
  const deps: GemspecDependency[] = [];
  let current: { name: string | null; type: string | null } | null = null;
  const flush = () => {
    if (current?.name) deps.push({ name: current.name, type: current.type ?? "runtime" });
  };
  for (const line of block.body) {
    if (line.startsWith("- ")) {
      flush();
      current = { name: null, type: null };
      continue;
    }
    if (!current) continue;
    const nameMatch = /^\s+name:\s*(.+)$/.exec(line);
    if (nameMatch) {
      current.name = scalar(nameMatch[1]);
      continue;
    }
    const typeMatch = /^\s+type:\s*(.+)$/.exec(line);
    if (typeMatch) current.type = normalizeSymbol(scalar(typeMatch[1]));
  }
  flush();
  return deps;
}

function parseMetadataMap(block: TopLevelBlock | undefined): Record<string, string> {
  if (!block) return {};
  const out: Record<string, string> = {};
  for (const line of block.body) {
    const match = /^\s+([A-Za-z0-9_.-]+):\s*(.*)$/.exec(line);
    if (!match) continue;
    const value = scalar(match[2]);
    if (value !== null) out[match[1]] = value;
  }
  return out;
}

// `required_ruby_version` is a `Gem::Requirement` whose constraints are
// `[operator, version]` pairs; render them as "<op> <version>" joined by ", ".
function parseRequirement(block: TopLevelBlock | undefined): string | null {
  if (!block) return null;
  const operators: string[] = [];
  const versions: string[] = [];
  for (const line of block.body) {
    const opMatch = /^\s+-\s+-\s+(.+)$/.exec(line);
    if (opMatch) {
      const op = scalar(opMatch[1]);
      if (op) operators.push(op);
      continue;
    }
    const versionMatch = /^\s+version:\s*(.+)$/.exec(line);
    if (versionMatch) {
      const version = scalar(versionMatch[1]);
      if (version) versions.push(version);
    }
  }
  if (!operators.length) return null;
  const parts = operators.map((op, index) => (versions[index] ? `${op} ${versions[index]}` : op));
  return parts.join(", ") || null;
}

function normalizeSymbol(value: string | null): string | null {
  if (!value) return null;
  return value.startsWith(":") ? value.slice(1) : value;
}
