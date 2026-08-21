// Bounded YAML-subset reader for GitHub Actions workflow files.
//
// Workflow YAML is repository content, so it is hostile evidence like package
// bytes: it is read, never evaluated. This parser has no anchors/aliases, no
// merge keys, no tags, no custom types, and no code paths that resolve
// anything outside the string it was handed. It covers exactly the shapes
// GitHub Actions workflows use — block mappings, block sequences, flow
// collections, quoted and block scalars, comments — and refuses anything
// larger or deeper than the limits below rather than growing unbounded work.
//
// Every scalar is returned as a string. Workflow authority is compared
// textually (`write` vs `read`, `v4` vs a 40-hex sha), so YAML's implicit
// typing would only add ways for two equal authorities to look different.
// It also keeps `on:` a key named "on" instead of YAML 1.1's boolean `true`.

export type YamlValue = string | null | YamlValue[] | { [key: string]: YamlValue };

export type YamlErrorCode =
  | "too_large"
  | "too_many_lines"
  | "too_deep"
  | "too_many_nodes"
  | "unsupported_syntax";

export class WorkflowYamlError extends Error {
  constructor(
    public code: YamlErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "WorkflowYamlError";
  }
}

// A release workflow that exceeds any of these is not something we can review
// as an authority graph; the caller records it as unresolved coverage rather
// than pretending the snapshot is complete.
export const MAX_WORKFLOW_BYTES = 512 * 1024;
const MAX_LINES = 20_000;
const MAX_DEPTH = 32;
const MAX_NODES = 20_000;
const MAX_FLOW_LENGTH = 8_192;

interface Line {
  indent: number;
  text: string;
}

interface ParseState {
  lines: Line[];
  index: number;
  nodes: number;
}

export interface WorkflowDocument {
  value: YamlValue;
  /**
   * False when the reader stopped before the end of the document — the input
   * used a YAML construct this subset does not cover. Callers must treat the
   * projection as partial rather than concluding "nothing changed": this parser
   * is deliberately stricter than GitHub's, and silently dropping a job would
   * hide exactly the authority change the review exists to surface.
   */
  complete: boolean;
}

/**
 * Parse one workflow document into plain JSON-ish values. Only the first
 * document of a multi-document stream is read — Actions ignores the rest too.
 * Throws `WorkflowYamlError` when a limit is hit; malformed-but-bounded input
 * degrades to whatever structure could be read and reports `complete: false`,
 * because a partially readable workflow still carries real authority signal.
 */
export function parseWorkflowYaml(source: string): WorkflowDocument {
  if (source.length > MAX_WORKFLOW_BYTES) {
    throw new WorkflowYamlError(
      "too_large",
      `workflow document exceeds ${MAX_WORKFLOW_BYTES} bytes`,
    );
  }
  const lines = splitLines(source);
  if (lines.length > MAX_LINES) {
    throw new WorkflowYamlError("too_many_lines", `workflow document exceeds ${MAX_LINES} lines`);
  }
  const state: ParseState = { lines, index: 0, nodes: 0 };
  skipIgnorable(state);
  if (state.index >= state.lines.length) return { value: null, complete: true };
  const first = state.lines[state.index];
  const value = parseNode(state, first.indent, 0);
  skipIgnorable(state);
  return { value, complete: state.index >= state.lines.length };
}

// ── Line handling ────────────────────────────────────────────────────────────

function splitLines(source: string): Line[] {
  const raw = source.split("\n");
  const lines: Line[] = [];
  let seenContent = false;
  for (const original of raw) {
    // A lone `---`/`...` ends the first document; everything after is dropped.
    // Leading blank/comment lines are not content, so a document that opens
    // with `---` still starts at its first real line.
    const stripped = original.replace(/\r$/, "");
    const trimmedEnd = stripped.trimEnd();
    if (seenContent && (trimmedEnd === "---" || trimmedEnd === "...")) break;
    if (trimmedEnd === "---") continue;
    if (trimmedEnd.length > 0 && !trimmedEnd.trimStart().startsWith("#")) seenContent = true;
    // Tabs are illegal YAML indentation and Actions rejects them; normalizing
    // rather than failing keeps a stray tab from blanking the whole snapshot.
    const expanded = expandLeadingTabs(stripped);
    const indent = expanded.length - expanded.trimStart().length;
    lines.push({ indent, text: expanded.slice(indent) });
  }
  return lines;
}

function expandLeadingTabs(line: string): string {
  let cut = 0;
  while (cut < line.length && (line[cut] === " " || line[cut] === "\t")) cut += 1;
  return line.slice(0, cut).replace(/\t/g, "  ") + line.slice(cut);
}

function isIgnorable(line: Line): boolean {
  return line.text.length === 0 || line.text.startsWith("#");
}

function skipIgnorable(state: ParseState): void {
  while (state.index < state.lines.length && isIgnorable(state.lines[state.index])) {
    state.index += 1;
  }
}

function peek(state: ParseState): Line | null {
  skipIgnorable(state);
  return state.index < state.lines.length ? state.lines[state.index] : null;
}

function countNode(state: ParseState): void {
  state.nodes += 1;
  if (state.nodes > MAX_NODES) {
    throw new WorkflowYamlError("too_many_nodes", `workflow document exceeds ${MAX_NODES} nodes`);
  }
}

function guardDepth(depth: number): void {
  if (depth > MAX_DEPTH) {
    throw new WorkflowYamlError("too_deep", `workflow document nests deeper than ${MAX_DEPTH}`);
  }
}

// ── Block structure ──────────────────────────────────────────────────────────

function parseNode(state: ParseState, indent: number, depth: number): YamlValue {
  guardDepth(depth);
  const line = peek(state);
  if (!line || line.indent < indent) return null;
  if (isSequenceEntry(line.text)) return parseSequence(state, line.indent, depth);
  return parseMapping(state, line.indent, depth);
}

function isSequenceEntry(text: string): boolean {
  return text === "-" || text.startsWith("- ");
}

function parseMapping(state: ParseState, indent: number, depth: number): YamlValue {
  guardDepth(depth);
  // YAML keys are hostile input. A normal object gives `__proto__` setter
  // semantics, which would hide a valid GitHub Actions job with that id while
  // still reporting complete coverage.
  const map = Object.create(null) as { [key: string]: YamlValue };
  let sawKey = false;

  for (;;) {
    const line = peek(state);
    if (!line || line.indent !== indent) break;
    const entry = splitKey(line.text);
    if (!entry) {
      // Not a `key:` line at this indent. A plain scalar here means the block
      // is not a mapping after all; hand it back so the caller can use it.
      if (!sawKey) {
        state.index += 1;
        return parseFlowScalar(stripComment(line.text));
      }
      break;
    }
    if (entry.mergeKey) {
      throw new WorkflowYamlError("unsupported_syntax", "workflow merge keys are not supported");
    }
    sawKey = true;
    countNode(state);
    state.index += 1;

    const rest = entry.rest;
    if (rest.length === 0) {
      map[entry.key] = parseChildBlock(state, indent, depth);
      continue;
    }
    const blockScalar = readBlockScalarHeader(rest);
    if (blockScalar) {
      map[entry.key] = parseBlockScalar(state, indent, blockScalar);
      continue;
    }
    map[entry.key] = parseFlowScalar(rest);
  }

  return map;
}

/**
 * Resolve the value of a `key:` line whose value is on following lines. A
 * nested block indents further, but a sequence may legally sit at the key's own
 * indent (`tags:` followed by `- "v*"` in the same column), so that case is
 * accepted at `indent` too.
 */
function parseChildBlock(state: ParseState, indent: number, depth: number): YamlValue {
  const next = peek(state);
  if (!next) return null;
  if (next.indent > indent) return parseNode(state, next.indent, depth + 1);
  if (next.indent === indent && isSequenceEntry(next.text)) {
    return parseSequence(state, indent, depth + 1);
  }
  return null;
}

function parseSequence(state: ParseState, indent: number, depth: number): YamlValue {
  guardDepth(depth);
  const items: YamlValue[] = [];

  for (;;) {
    const line = peek(state);
    if (!line || line.indent !== indent || !isSequenceEntry(line.text)) break;
    countNode(state);

    const afterDash = line.text.slice(1);
    const leading = afterDash.length - afterDash.trimStart().length;
    const rest = afterDash.slice(leading);
    if (rest.length === 0) {
      state.index += 1;
      const next = peek(state);
      items.push(next && next.indent > indent ? parseNode(state, next.indent, depth + 1) : null);
      continue;
    }

    // Rewrite `- uses: x` into a mapping line at the column the content starts
    // in, so the item's remaining keys (which sit in that same column) parse as
    // one mapping without a second code path.
    const contentIndent = indent + 1 + leading;
    state.lines[state.index] = { indent: contentIndent, text: rest };
    items.push(parseNode(state, contentIndent, depth + 1));
  }

  return items;
}

interface KeyLine {
  key: string;
  rest: string;
  mergeKey: boolean;
}

/**
 * Split `key: value` at the first structural colon. Quoted keys are unquoted;
 * a colon inside quotes or inside a flow collection does not split, and a
 * colon must be followed by whitespace or end-of-line to be structural (so
 * `image: ghcr.io/o/r:tag` and `run: curl https://x` stay intact).
 */
function splitKey(text: string): KeyLine | null {
  let quote: string | null = null;
  let flow = 0;
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    if (quote) {
      if (char === "\\" && quote === '"') {
        i += 1;
        continue;
      }
      if (char === quote) quote = null;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (char === "[" || char === "{") {
      flow += 1;
      continue;
    }
    if (char === "]" || char === "}") {
      if (flow > 0) flow -= 1;
      continue;
    }
    if (char === "#" && i > 0 && /\s/.test(text[i - 1])) break;
    if (char !== ":" || flow > 0) continue;
    const next = text[i + 1];
    if (next !== undefined && next !== " " && next !== "\t") continue;
    const rawKey = text.slice(0, i).trim();
    const key = unquoteScalar(rawKey);
    if (!key) return null;
    return { key, rest: stripComment(text.slice(i + 1).trim()), mergeKey: rawKey === "<<" };
  }
  return null;
}

// ── Scalars ──────────────────────────────────────────────────────────────────

interface BlockScalarHeader {
  fold: boolean;
  chomp: "clip" | "strip" | "keep";
  explicitIndent: number | null;
}

function readBlockScalarHeader(rest: string): BlockScalarHeader | null {
  const match = /^([|>])([+-]?)(\d*)([+-]?)\s*$/.exec(rest);
  if (!match) return null;
  const chompChar = match[2] || match[4];
  return {
    fold: match[1] === ">",
    chomp: chompChar === "-" ? "strip" : chompChar === "+" ? "keep" : "clip",
    explicitIndent: match[3] ? Number.parseInt(match[3], 10) : null,
  };
}

/**
 * Read a `|`/`>` block scalar. The body is kept because `run:` steps are
 * publish-path evidence, but it is only ever compared and displayed, never
 * executed. Chomping follows YAML: strip drops trailing newlines, keep retains
 * them, clip leaves exactly one.
 */
function parseBlockScalar(
  state: ParseState,
  parentIndent: number,
  header: BlockScalarHeader,
): string {
  const bodyLines: string[] = [];
  let blockIndent = header.explicitIndent === null ? -1 : parentIndent + header.explicitIndent;

  while (state.index < state.lines.length) {
    const line = state.lines[state.index];
    const blank = line.text.length === 0;
    if (!blank && line.indent <= parentIndent) break;
    if (blank) {
      bodyLines.push("");
      state.index += 1;
      continue;
    }
    if (blockIndent < 0) blockIndent = line.indent;
    if (line.indent < blockIndent) break;
    bodyLines.push(" ".repeat(line.indent - blockIndent) + line.text);
    state.index += 1;
  }

  while (bodyLines.length > 0 && bodyLines[bodyLines.length - 1] === "") bodyLines.pop();
  if (bodyLines.length === 0) return "";
  const body = header.fold ? foldLines(bodyLines) : bodyLines.join("\n");
  if (header.chomp === "strip") return body;
  return `${body}\n`;
}

function foldLines(lines: string[]): string {
  let out = "";
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (i === 0) {
      out = line;
      continue;
    }
    // Folded scalars keep the break before a blank line or a more-indented
    // (literal) line, and replace it with a space otherwise.
    const previous = lines[i - 1];
    const keepBreak =
      line === "" || previous === "" || startsIndented(line) || startsIndented(previous);
    out += keepBreak ? `\n${line}` : ` ${line}`;
  }
  return out;
}

function startsIndented(line: string): boolean {
  return line.startsWith(" ");
}

/**
 * Parse a value that appears on the same line as its key or dash: a quoted
 * string, a flow collection, or a plain scalar.
 */
function parseFlowScalar(text: string): YamlValue {
  const trimmed = text.trim();
  if (trimmed.length === 0) return null;
  if (trimmed.length > MAX_FLOW_LENGTH) {
    throw new WorkflowYamlError(
      "too_large",
      `inline workflow value exceeds ${MAX_FLOW_LENGTH} characters`,
    );
  }
  rejectUnsupportedNodeToken(trimmed);
  if (trimmed === "~" || trimmed === "null") return null;
  if (trimmed.startsWith("[") || trimmed.startsWith("{")) {
    const parsed = parseFlowCollection(trimmed);
    if (parsed !== undefined) return parsed;
    throw new WorkflowYamlError("unsupported_syntax", "workflow flow collection is malformed");
  }
  return unquoteScalar(trimmed);
}

function unquoteScalar(value: string): string {
  if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
    return unescapeDoubleQuoted(value.slice(1, -1));
  }
  if (value.length >= 2 && value.startsWith("'") && value.endsWith("'")) {
    return value.slice(1, -1).replace(/''/g, "'");
  }
  return value;
}

function unescapeDoubleQuoted(value: string): string {
  let out = "";
  for (let i = 0; i < value.length; i += 1) {
    const char = value[i];
    if (char !== "\\") {
      out += char;
      continue;
    }
    const next = value[++i];
    if (next === undefined) break;
    if (next === "n") out += "\n";
    else if (next === "t") out += "\t";
    else if (next === "r") out += "\r";
    else if (next === "0") out += "\0";
    else out += next;
  }
  return out;
}

/**
 * Strip a trailing `# comment` from a plain scalar. A `#` only starts a comment
 * when it follows whitespace and sits outside quotes, so `run: echo '#1'` and
 * `ref: refs/tags/v1#x` survive intact.
 */
function stripComment(text: string): string {
  let quote: string | null = null;
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    if (quote) {
      if (char === "\\" && quote === '"') {
        i += 1;
        continue;
      }
      if (char === quote) quote = null;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (char === "#" && (i === 0 || /\s/.test(text[i - 1]))) return text.slice(0, i).trimEnd();
  }
  return text.trimEnd();
}

// ── Flow collections ─────────────────────────────────────────────────────────

interface FlowCursor {
  text: string;
  index: number;
  depth: number;
}

/** Returns `undefined` for input this reader cannot make sense of, so the
 * caller can fall back to treating the text as a plain scalar. */
function parseFlowCollection(text: string): YamlValue | undefined {
  const cursor: FlowCursor = { text, index: 0, depth: 0 };
  const value = readFlowValue(cursor);
  if (value === undefined) return undefined;
  skipFlowSpace(cursor);
  return cursor.index >= cursor.text.length ? value : undefined;
}

function readFlowValue(cursor: FlowCursor): YamlValue | undefined {
  if (cursor.depth > MAX_DEPTH) return undefined;
  skipFlowSpace(cursor);
  const char = cursor.text[cursor.index];
  if (char === "[") return readFlowSequence(cursor);
  if (char === "{") return readFlowMapping(cursor);
  return readFlowToken(cursor, false);
}

function readFlowSequence(cursor: FlowCursor): YamlValue | undefined {
  cursor.index += 1;
  cursor.depth += 1;
  const items: YamlValue[] = [];
  for (;;) {
    skipFlowSpace(cursor);
    if (cursor.index >= cursor.text.length) return undefined;
    if (cursor.text[cursor.index] === "]") {
      cursor.index += 1;
      cursor.depth -= 1;
      return items;
    }
    const item = readFlowValue(cursor);
    if (item === undefined) return undefined;
    items.push(item);
    skipFlowSpace(cursor);
    if (cursor.text[cursor.index] === ",") cursor.index += 1;
    else if (cursor.text[cursor.index] !== "]") return undefined;
  }
}

function readFlowMapping(cursor: FlowCursor): YamlValue | undefined {
  cursor.index += 1;
  cursor.depth += 1;
  const map = Object.create(null) as { [key: string]: YamlValue };
  for (;;) {
    skipFlowSpace(cursor);
    if (cursor.index >= cursor.text.length) return undefined;
    if (cursor.text[cursor.index] === "}") {
      cursor.index += 1;
      cursor.depth -= 1;
      return map;
    }
    const keyStartsQuoted = cursor.text[cursor.index] === '"' || cursor.text[cursor.index] === "'";
    const key = readFlowToken(cursor, true);
    if (key === undefined || key === null) return undefined;
    if (key === "<<" && !keyStartsQuoted) {
      throw new WorkflowYamlError("unsupported_syntax", "workflow merge keys are not supported");
    }
    skipFlowSpace(cursor);
    if (cursor.text[cursor.index] !== ":") return undefined;
    cursor.index += 1;
    const value = readFlowValue(cursor);
    if (value === undefined) return undefined;
    map[String(key)] = value;
    skipFlowSpace(cursor);
    if (cursor.text[cursor.index] === ",") cursor.index += 1;
    else if (cursor.text[cursor.index] !== "}") return undefined;
  }
}

function readFlowToken(cursor: FlowCursor, stopAtColon: boolean): YamlValue | undefined {
  skipFlowSpace(cursor);
  const start = cursor.index;
  const quote = cursor.text[start];
  if (quote === '"' || quote === "'") {
    let i = start + 1;
    while (i < cursor.text.length) {
      const char = cursor.text[i];
      if (char === "\\" && quote === '"') {
        i += 2;
        continue;
      }
      if (char === quote) break;
      i += 1;
    }
    if (i >= cursor.text.length) return undefined;
    cursor.index = i + 1;
    return unquoteScalar(cursor.text.slice(start, cursor.index));
  }
  let i = start;
  while (
    i < cursor.text.length &&
    !",[]{}".includes(cursor.text[i]) &&
    (!stopAtColon || cursor.text[i] !== ":")
  ) {
    i += 1;
  }
  const token = cursor.text.slice(start, i).trim();
  cursor.index = i;
  if (token.length === 0) return undefined;
  rejectUnsupportedNodeToken(token);
  if (token === "~" || token === "null") return null;
  return token;
}

function rejectUnsupportedNodeToken(value: string): void {
  if (!/^[&*!](?:[^\s,[\]{}]+)(?:\s|$)/.test(value)) return;
  throw new WorkflowYamlError(
    "unsupported_syntax",
    "workflow anchors, aliases, and tags are not supported",
  );
}

function skipFlowSpace(cursor: FlowCursor): void {
  while (cursor.index < cursor.text.length && /\s/.test(cursor.text[cursor.index])) {
    cursor.index += 1;
  }
}

// ── Shape helpers shared by the snapshot projection ──────────────────────────

export function asRecord(value: YamlValue): { [key: string]: YamlValue } | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value : null;
}

export function asString(value: YamlValue): string | null {
  return typeof value === "string" ? value : null;
}

/** Read a value that YAML allows to be either a scalar or a list of scalars. */
export function asStringList(value: YamlValue): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) {
    return value.filter((item): item is string => typeof item === "string");
  }
  return [];
}
