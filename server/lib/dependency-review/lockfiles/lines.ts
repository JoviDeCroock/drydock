// Lines one at a time, so an 8 MiB lockfile of short lines never holds millions
// of line strings at once.
export function* textLines(text: string): Generator<string> {
  let start = 0;
  while (start <= text.length) {
    let end = text.indexOf("\n", start);
    if (end === -1) end = text.length;
    yield text.slice(start, end > start && text[end - 1] === "\r" ? end - 1 : end);
    start = end + 1;
  }
}

// pnpm-lock.yaml, Berry's yarn.lock, and .yarnrc.yml are machine-written YAML.
// They are read a line at a time, with no YAML library and no backtracking,
// and only in the shapes those tools (and Prettier, reformatting them) write:
// block mappings indented two spaces a level, plain or quoted one-line
// scalars, and single-level flow collections on one line or one entry per
// line. Anything a YAML parser could read differently (anchors, aliases, tags,
// escapes, block or multi-line scalars, comments after values, other
// indentation, duplicate keys, control characters) makes the document
// unreadable rather than guessed at. A document this accepts parses to the
// tree a YAML parser yields with every scalar read as a string.

export type YamlValue =
  // `key:` with nothing after it: a nested block follows, or the value is null.
  | { kind: "block" }
  | { kind: "scalar"; text: string }
  | { kind: "map"; fields: ReadonlyMap<string, string> }
  | { kind: "seq"; items: readonly string[] };

interface YamlEntry {
  // Nesting depth: 0 for a top-level key.
  depth: number;
  // Null for a `- item` sequence entry.
  key: string | null;
  value: YamlValue;
}

// Called for each entry in document order, and with null where a `---`
// starts a document. Returning false stops the read early.
export type YamlVisitor = (entry: YamlEntry | null) => boolean | void;

interface Frame {
  indent: number;
  kind: "map" | "seq" | null;
  keys: Set<string>;
}

interface Pending {
  depth: number;
  key: string;
  // Where its nested block, if any, must be indented.
  childIndent: number;
}

/** Reads `text` strictly; false when anything in it is outside the subset. */
export function readStrictYaml(text: string, visit: YamlVisitor): boolean {
  let frames: Frame[] = [{ indent: 0, kind: null, keys: new Set() }];
  let pending: Pending | null = null;
  let flow: { indent: number; close: string; parts: string[]; owner: Pending } | null = null;
  let stopped = false;
  const emit = (depth: number, key: string | null, value: YamlValue) => {
    if (visit({ depth, key, value }) === false) stopped = true;
  };
  const flushPending = () => {
    if (pending) emit(pending.depth, pending.key, { kind: "block" });
    pending = null;
  };
  for (const raw of textLines(text)) {
    if (stopped) return true;
    if (!plainCharacters(raw)) return false;
    let indent = 0;
    while (indent < raw.length && raw.charCodeAt(indent) === 32) indent++;
    const line = raw.slice(indent);
    if (!line) {
      if (flow) return false;
      continue;
    }
    if (line.endsWith(" ")) return false;
    if (flow) {
      if (indent === flow.indent && line === flow.close) {
        const open = flow.close === "}" ? "{" : "[";
        const value = parseFlow(`${open}${flow.parts.join(", ")}${flow.close}`);
        if (!value) return false;
        emit(flow.owner.depth, flow.owner.key, value);
        flow = null;
        continue;
      }
      if (indent !== flow.indent + 2 || line.length < 2 || !line.endsWith(",")) return false;
      flow.parts.push(line.slice(0, -1));
      continue;
    }
    if (line.startsWith("#")) continue;
    if (indent === 0 && line === "---") {
      flushPending();
      frames = [{ indent: 0, kind: null, keys: new Set() }];
      if (visit(null) === false) return true;
      continue;
    }
    const owner = pending as Pending | null;
    if (owner && indent === owner.childIndent && (line === "{" || line === "[")) {
      flow = { indent, close: line === "{" ? "}" : "]", parts: [], owner };
      pending = null;
      continue;
    }
    if (owner && indent === owner.childIndent) {
      flushPending();
      frames.push({ indent, kind: null, keys: new Set() });
    } else {
      flushPending();
      while (frames.length > 1 && frames[frames.length - 1].indent > indent) frames.pop();
      if (frames[frames.length - 1].indent !== indent) return false;
    }
    if (stopped) return true;
    const frame = frames[frames.length - 1];
    const depth = frames.length - 1;
    if (line.startsWith("-")) {
      if (frame.kind === "map" || !line.startsWith("- ")) return false;
      frame.kind = "seq";
      const value = parseValue(line.slice(2));
      if (!value || value.kind === "map") return false;
      emit(depth, null, value);
      continue;
    }
    if (frame.kind === "seq") return false;
    frame.kind = "map";
    const parsed = parseKey(line);
    if (!parsed || parsed.key === "<<" || frame.keys.has(parsed.key)) return false;
    frame.keys.add(parsed.key);
    const rest = line.slice(parsed.end);
    if (rest === "") {
      pending = { depth, key: parsed.key, childIndent: indent + 2 };
      continue;
    }
    if (rest[0] !== " " || rest[1] === " ") return false;
    const value = parseValue(rest.slice(1));
    if (!value) return false;
    emit(depth, parsed.key, value);
  }
  if (flow) return false;
  if (!stopped) flushPending();
  return true;
}

// No tab, control character, or anything a YAML reader may take as a line
// break or a byte-order mark.
function plainCharacters(line: string): boolean {
  for (let i = 0; i < line.length; i++) {
    const c = line.charCodeAt(i);
    if (c < 0x20 || c === 0x7f || c === 0x85 || c === 0x2028 || c === 0x2029 || c === 0xfeff) {
      return false;
    }
  }
  return true;
}

// Characters a plain scalar may not start with: YAML indicators.
const INDICATORS = new Set("-?:,[]{}#&*!|>'\"%@`");
const FLOW_INDICATORS = new Set("[]{},");

// A key and the offset just past its `:` indicator.
function parseKey(line: string): { key: string; end: number } | null {
  if (line[0] === "'" || line[0] === '"') {
    const quoted = readQuoted(line, 0);
    if (!quoted || line[quoted.end] !== ":") return null;
    return { key: quoted.text, end: quoted.end + 1 };
  }
  // A plain key ends at the first `:` followed by a space or the line end, so
  // a URL's `://` stays in the key.
  let colon = line.indexOf(":");
  while (colon !== -1 && colon + 1 < line.length && line[colon + 1] !== " ") {
    colon = line.indexOf(":", colon + 1);
  }
  if (colon <= 0) return null;
  const key = line.slice(0, colon);
  return plainScalar(key, false) ? { key, end: colon + 1 } : null;
}

function parseValue(text: string): YamlValue | null {
  if (text[0] === "{" || text[0] === "[") return parseFlow(text);
  const scalar = oneScalar(text, false);
  return scalar === null ? null : { kind: "scalar", text: scalar };
}

// A plain scalar on one line: no leading indicator, nothing that starts a
// mapping (`: `) or a comment (` #`), no trailing `:`, and in flow context
// none of the flow indicators.
function plainScalar(text: string, inFlow: boolean): boolean {
  if (!text || INDICATORS.has(text[0]) || text.endsWith(":") || text.endsWith(" ")) return false;
  if (text.includes(": ") || text.includes(" #")) return false;
  if (inFlow) {
    for (let i = 0; i < text.length; i++) if (FLOW_INDICATORS.has(text[i])) return false;
  }
  return true;
}

// The whole of `text` as one scalar, quoted or plain. In a flow collection a
// plain scalar may hold no quote, so a quote can only open a quoted scalar.
function oneScalar(text: string, inFlow: boolean): string | null {
  if (text[0] === "'" || text[0] === '"') {
    const quoted = readQuoted(text, 0);
    return quoted && quoted.end === text.length ? quoted.text : null;
  }
  if (inFlow && (text.includes("'") || text.includes('"'))) return null;
  return plainScalar(text, inFlow) ? text : null;
}

// `'…'` with `''` for a quote, or `"…"` with no escapes at all (a backslash
// is refused rather than decoded).
function readQuoted(text: string, start: number): { text: string; end: number } | null {
  if (text[start] === '"') {
    const close = text.indexOf('"', start + 1);
    if (close === -1) return null;
    const inner = text.slice(start + 1, close);
    return inner.includes("\\") ? null : { text: inner, end: close + 1 };
  }
  let out = "";
  let i = start + 1;
  for (;;) {
    const close = text.indexOf("'", i);
    if (close === -1) return null;
    out += text.slice(i, close);
    if (text[close + 1] !== "'") return { text: out, end: close + 1 };
    out += "'";
    i = close + 2;
  }
}

// `{a: b, c: 'd'}`, `{ a: b }`, `[a, b]`: one level, entries split on `, `.
function parseFlow(text: string): YamlValue | null {
  const close = text[0] === "{" ? "}" : "]";
  if (text.length < 2 || !text.endsWith(close)) return null;
  let inner = text.slice(1, -1);
  if (inner.length >= 2 && inner.startsWith(" ") && inner.endsWith(" ")) {
    inner = inner.slice(1, -1);
  }
  const parts = splitFlow(inner);
  if (!parts) return null;
  if (close === "]") {
    const items: string[] = [];
    for (const part of parts) {
      const item = oneScalar(part, true);
      if (item === null) return null;
      items.push(item);
    }
    return { kind: "seq", items };
  }
  const fields = new Map<string, string>();
  for (const part of parts) {
    let key: string;
    let rest: string;
    if (part[0] === "'" || part[0] === '"') {
      const quoted = readQuoted(part, 0);
      if (!quoted || part[quoted.end] !== ":") return null;
      key = quoted.text;
      rest = part.slice(quoted.end + 1);
    } else {
      const colon = part.indexOf(": ");
      if (colon <= 0) return null;
      key = part.slice(0, colon);
      if (!plainScalar(key, true)) return null;
      rest = part.slice(colon + 1);
    }
    if (rest[0] !== " " || key === "<<" || fields.has(key)) return null;
    const value = oneScalar(rest.slice(1), true);
    if (value === null) return null;
    fields.set(key, value);
  }
  return { kind: "map", fields };
}

// Splits on `, ` outside quoted scalars, in one pass.
function splitFlow(inner: string): string[] | null {
  const parts: string[] = [];
  if (!inner) return parts;
  let start = 0;
  let i = 0;
  while (i < inner.length) {
    const c = inner[i];
    if ((c === "'" || c === '"') && (i === start || inner[i - 1] === " ")) {
      const quoted = readQuoted(inner, i);
      if (!quoted) return null;
      i = quoted.end;
    } else if (c === "," && inner[i + 1] === " ") {
      parts.push(inner.slice(start, i));
      i += 2;
      start = i;
    } else {
      i++;
    }
  }
  // A trailing `, ` (or `,`) leaves an empty last entry.
  const last = inner.slice(start);
  if (last.endsWith(",") && start < inner.length) parts.push(last.slice(0, -1));
  else parts.push(last);
  return parts.every((part) => part.length > 0) ? parts : null;
}
