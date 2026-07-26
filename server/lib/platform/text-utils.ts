export function firstMatchingLine(
  text: string | undefined | null,
  patterns: RegExp[],
): number | undefined {
  if (!text) return undefined;
  const lines = text.split("\n");
  for (let index = 0; index < lines.length; index += 1) {
    for (const pattern of patterns) {
      pattern.lastIndex = 0;
      if (pattern.test(lines[index])) return index + 1;
    }
  }
  return undefined;
}

export function firstMatchingSourceLine(
  text: string | undefined | null,
  patterns: RegExp[],
): number | undefined {
  if (!text) return undefined;
  let firstIndex: number | undefined;
  for (const pattern of patterns) {
    pattern.lastIndex = 0;
    const match = pattern.exec(text);
    if (match && (firstIndex === undefined || match.index < firstIndex)) {
      firstIndex = match.index;
    }
  }
  if (firstIndex === undefined) return undefined;
  return text.slice(0, firstIndex).split("\n").length;
}
