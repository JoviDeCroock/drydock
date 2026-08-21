/**
 * Markup escaping, named by the context it is safe for.
 *
 * These were three separate `escapeHtml`/`escapeXml` functions with three
 * different escape sets. None of the call sites was wrong, but one name
 * meaning three things is how an escaping bug eventually gets written: the
 * safe set depends entirely on where the value lands, and a function called
 * `escapeHtml` does not say. So each context gets its own name, and picking
 * the wrong one is now a visible mistake at the call site rather than an
 * invisible one inside a helper.
 */

/**
 * For an HTML **text node**. `"` and `'` carry no meaning between tags, so
 * escaping the three markup-significant characters is sufficient.
 *
 * Not safe for attribute values — use `escapeHtmlAttribute` there.
 */
export function escapeHtmlText(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * For an HTML **attribute value**, quoted with either `"` or `'`. Escapes both
 * quote styles so the value cannot terminate the attribute and start a new one.
 */
export function escapeHtmlAttribute(value: string): string {
  return escapeHtmlText(value).replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

/**
 * For **XML/SVG** content, where `&apos;` is a defined entity (it is not in
 * HTML4). Used by the OG card renderer, whose output is parsed as SVG.
 */
export function escapeXml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => {
    switch (char) {
      case "&":
        return "&amp;";
      case "<":
        return "&lt;";
      case ">":
        return "&gt;";
      case '"':
        return "&quot;";
      default:
        return "&apos;";
    }
  });
}
