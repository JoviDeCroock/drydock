/**
 * Shared helpers for reading Tailwind utility tokens out of static strings.
 * The design rules only reason about static class strings: a class assembled
 * at runtime is not resolved.
 */

/**
 * Strip responsive/state variants (`lg:`, `hover:`, `dark:`) and the important
 * marker from a utility token. Colons inside arbitrary variants/values are not
 * variant separators.
 */
export function utilityWithoutVariants(token) {
  let bracketDepth = 0;
  let parenDepth = 0;
  let lastVariantSeparator = -1;
  for (let index = 0; index < token.length; index++) {
    const char = token[index];
    if (char === "[") bracketDepth++;
    else if (char === "]") bracketDepth--;
    else if (char === "(") parenDepth++;
    else if (char === ")") parenDepth--;
    else if (char === ":" && bracketDepth === 0 && parenDepth === 0) {
      lastVariantSeparator = index;
    }
  }
  return token
    .slice(lastVariantSeparator + 1)
    .replace(/^!/, "")
    .replace(/!$/, "");
}

/** Every static string a node contributes: literals and template quasis. */
export function staticStrings(node) {
  if (node.type === "Literal" && typeof node.value === "string") return [node.value];
  if (node.type === "TemplateLiteral") return node.quasis.map((quasi) => quasi.value.cooked ?? "");
  return [];
}

/** Whitespace-separated tokens of a class-like string. */
export function classTokens(text) {
  return text.split(/\s+/).filter(Boolean);
}
