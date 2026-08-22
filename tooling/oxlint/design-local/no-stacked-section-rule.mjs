/**
 * Flag a horizontal rule stacked on the hairline `SectionLabel` already draws.
 *
 * `SectionLabel` (src/components/Typography.tsx) renders its own trailing rule —
 * `after:h-px after:bg-border` without an `aside`, an explicit `h-px bg-border`
 * span with one. `docs/design.md` treats that rule as *the* section divider. Putting a
 * `border-t`/`border-b`/`<hr>` on the same visual boundary stacks a second 1px
 * line a few pixels away, which reads as a rendering glitch rather than a
 * divider. This has regressed repeatedly (CollapsibleCard carries a comment
 * about it; the landing hero and the settings cards each shipped it once), so
 * it is checked rather than remembered. Separate with spacing instead.
 *
 *   <SectionLabel as="h2" class="border-b border-border">…</SectionLabel>  // flagged
 *   <div class="border-b border-border"><SectionLabel as="h2">…</SectionLabel></div>  // flagged
 *   <SectionLabel as="h2">…</SectionLabel><hr />                          // flagged
 *   <SectionLabel as="h2">…</SectionLabel><div class="border-t …">…</div> // flagged
 *   <section class="border border-border">…</section>                     // ok (a box, not a rule)
 *   <SectionLabel as="h2">…</SectionLabel><div class="mt-4">…</div>       // ok (spacing)
 *
 * Scope and limitations:
 *   - Only the *directional* border utilities (`border-t`/`border-b`, with an
 *     optional responsive/variant prefix) count. An all-sides `border` draws a
 *     box outline, which is a different element, not a stacked rule.
 *   - Only adjacent boundaries are reported: the label's own class, the class
 *     of the element that directly wraps it, and the immediately preceding /
 *     following JSX sibling. A rule two elements away is a spacing question,
 *     not a doubled hairline, and reporting it would be guesswork.
 *   - Class names are read from static string literals (`class="…"`, and the
 *     string arguments of a `cn(…)` call). A class assembled at runtime is not
 *     resolved.
 */

const SECTION_LABEL = "SectionLabel";

// `border-t`, `border-b`, and their non-zero width/color/variant spellings:
// `border-t-2`, `border-b-border`, `md:border-t`, `dark:border-b-ink`. Not
// `border`, `border-x`, `border-border` (all-sides color), `border-2`, or the
// zero-width removals `border-t-0` / `border-b-0`.
const TOP_RULE = /(?:^|\s|:)border-t(?:-(?!0(?:\s|$))|\s|$)/;
const BOTTOM_RULE = /(?:^|\s|:)border-b(?:-(?!0(?:\s|$))|\s|$)/;

function classStringsFrom(node, out) {
  if (!node) return out;
  if (node.type === "Literal" && typeof node.value === "string") {
    out.push(node.value);
  } else if (node.type === "TemplateLiteral") {
    for (const quasi of node.quasis) out.push(quasi.value.cooked ?? "");
  } else if (node.type === "JSXExpressionContainer") {
    classStringsFrom(node.expression, out);
  } else if (node.type === "CallExpression") {
    // cn("…", cond && "…", …) — read every static string argument.
    for (const argument of node.arguments) classStringsFrom(argument, out);
  } else if (node.type === "LogicalExpression") {
    classStringsFrom(node.left, out);
    classStringsFrom(node.right, out);
  } else if (node.type === "ConditionalExpression") {
    classStringsFrom(node.consequent, out);
    classStringsFrom(node.alternate, out);
  } else if (node.type === "ArrayExpression") {
    for (const element of node.elements) classStringsFrom(element, out);
  }
  return out;
}

function elementName(node) {
  const name = node?.openingElement?.name ?? node?.name;
  if (!name) return undefined;
  if (name.type === "JSXIdentifier") return name.name;
  // <Foo.Bar> — the trailing member is the component's own name.
  if (name.type === "JSXMemberExpression") return name.property?.name;
  return undefined;
}

/** The `class`/`className` attribute node of a JSX element, if any. */
function classAttribute(node) {
  const attributes = node?.openingElement?.attributes ?? [];
  return attributes.find(
    (attribute) =>
      attribute.type === "JSXAttribute" &&
      (attribute.name?.name === "class" || attribute.name?.name === "className"),
  );
}

function drawsDirectionalRule(node, side) {
  if (elementName(node) === "hr") return true;
  const attribute = classAttribute(node);
  if (!attribute) return false;
  const pattern = side === "top" ? TOP_RULE : BOTTOM_RULE;
  return classStringsFrom(attribute.value, []).some((value) => pattern.test(value));
}

/** JSX children with whitespace-only text dropped, so "adjacent" means visually adjacent. */
function meaningfulChildren(node) {
  return (node?.children ?? []).filter(
    (child) =>
      !(child.type === "JSXText" && child.value.trim() === "") &&
      !(child.type === "JSXExpressionContainer" && child.expression?.type === "JSXEmptyExpression"),
  );
}

/** @type {import("eslint").Rule.RuleModule} */
const rule = {
  meta: {
    type: "problem",
    docs: {
      description:
        "Never stack a border-t/border-b/<hr> on the hairline a SectionLabel already draws",
      recommended: true,
    },
    messages: {
      onLabel:
        "`SectionLabel` already draws the section divider (`after:h-px after:bg-border`); a `border-t`/`border-b` on it stacks a second hairline. Use spacing instead — see docs/design.md, “Section labels”.",
      onWrapper:
        "This element wraps a `SectionLabel`, which already draws the section divider, so its `border-t`/`border-b` stacks a second hairline on the same boundary. Use spacing instead — see docs/design.md, “Section labels”.",
      onSibling:
        "A rule ({{what}}) sits directly against a `SectionLabel`, which already draws the section divider. Two hairlines a few pixels apart read as a rendering glitch. Use spacing instead — see docs/design.md, “Section labels”.",
    },
    schema: [],
  },

  create(context) {
    function checkElement(node) {
      if (elementName(node) !== SECTION_LABEL) return;

      // The label's own class.
      const attribute = classAttribute(node);
      if (
        attribute &&
        (drawsDirectionalRule(node, "top") || drawsDirectionalRule(node, "bottom"))
      ) {
        context.report({ node: attribute, messageId: "onLabel" });
      }

      const parent = node.parent;
      if (parent?.type !== "JSXElement" && parent?.type !== "JSXFragment") return;
      const siblings = meaningfulChildren(parent);

      // The wrapper that draws its own rule on the same boundary. Only when the
      // label is the wrapper's leading or trailing child: a label in the middle
      // of a stack is not on the wrapper's top or bottom edge.
      if (parent.type === "JSXElement") {
        const wrapperClass = classAttribute(parent);
        if (
          wrapperClass &&
          ((siblings[0] === node && drawsDirectionalRule(parent, "top")) ||
            (siblings[siblings.length - 1] === node && drawsDirectionalRule(parent, "bottom")))
        ) {
          context.report({ node: wrapperClass, messageId: "onWrapper" });
        }
      }

      // Immediate siblings on either side.
      const index = siblings.indexOf(node);
      for (const [neighbour, side] of [
        [siblings[index - 1], "bottom"],
        [siblings[index + 1], "top"],
      ]) {
        if (neighbour?.type !== "JSXElement") continue;
        if (!drawsDirectionalRule(neighbour, side)) continue;
        context.report({
          node: neighbour,
          messageId: "onSibling",
          data: { what: elementName(neighbour) === "hr" ? "<hr>" : "border-t/border-b" },
        });
      }
    }

    return { JSXElement: checkElement };
  },
};

export default rule;
