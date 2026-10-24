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

// pnpm-lock.yaml and Berry yarn.lock are machine-written YAML. They are read a
// line at a time, the way the dependency-PR workflow reads them, rather than
// with a YAML library: only block mappings of scalar keys matter here, and a
// hand scanner has no backtracking a hostile file could exploit.

export interface YamlLine {
  // Leading whitespace of any kind, as the workflow counts it, so a stray tab
  // nests a line rather than ending the section.
  indent: number;
  // Null for a line that is not a `key: value` pair; it still ends whatever
  // entry an earlier line at its indent opened.
  key: string | null;
  value: string;
}

export function* yamlLines(text: string): Generator<YamlLine> {
  for (const raw of textLines(text)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const indent = raw.length - raw.trimStart().length;
    const entry = yamlKey(line);
    yield entry ? { indent, ...entry } : { indent, key: null, value: "" };
  }
}

function unquote(value: string): string {
  const trimmed = value.trim();
  const first = trimmed[0];
  if (trimmed.length >= 2 && (first === "'" || first === '"') && trimmed.endsWith(first)) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

// `key: value`, `'quoted key': value`, or `key:` opening a nested block.
export function yamlKey(line: string): { key: string; value: string } | null {
  const quote = line[0];
  if (quote === "'" || quote === '"') {
    let key = "";
    let i = 1;
    for (; i < line.length; i++) {
      if (line[i] !== quote) {
        key += line[i];
      } else if (line[i + 1] === quote) {
        key += quote;
        i++;
      } else {
        break;
      }
    }
    if (i >= line.length || line[i + 1] !== ":") return null;
    return afterColon(key, line, i + 2);
  }
  if (!quote || /\s/.test(quote)) return null;
  // The key ends at the first colon followed by whitespace or the line end, so
  // a plain key may hold a URL (`foo@https://host/x:`).
  let colon = line.indexOf(":");
  while (colon !== -1 && colon + 1 < line.length && !/\s/.test(line[colon + 1])) {
    colon = line.indexOf(":", colon + 1);
  }
  if (colon <= 0) return null;
  return afterColon(line.slice(0, colon).trimEnd(), line, colon + 1);
}

function afterColon(key: string, line: string, at: number): { key: string; value: string } | null {
  if (at < line.length && !/\s/.test(line[at])) return null;
  return { key, value: unquote(line.slice(at)) };
}
