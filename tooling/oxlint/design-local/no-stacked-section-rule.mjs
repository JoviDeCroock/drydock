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
 *   - Only non-zero border-width utilities (`border-t`/`border-b`/`border-y`,
 *     with an optional responsive/variant prefix) count. Directional color-only
 *     utilities do not create a line. An all-sides `border` draws a box outline,
 *     which is a different element, not a stacked rule.
 *   - Only adjacent boundaries are reported: the label's own class, the class
 *     of the element that directly wraps it, and the immediately preceding /
 *     following JSX sibling. When the label touches a wrapper edge, the
 *     wrapper's touching sibling is adjacent too (`<summary><SectionLabel />
 *     </summary><div class="border-t">`). Logical and conditional JSX siblings
 *     are inspected branch-by-branch. A rule beyond either boundary is a spacing
 *     question, not a doubled hairline, and reporting it would be guesswork.
 *   - Class names are read from static string literals (`class="…"`, and the
 *     string arguments of a `cn(…)` call). A class assembled at runtime is not
 *     resolved.
 */

const SECTION_LABEL = "SectionLabel";

// Tailwind's directional border namespace contains both widths and colors:
// `border-t-2` sets a width, while `border-t-border` only sets a color and does
// not draw anything by itself. Recognize the built-in numeric/px widths and
// arbitrary length values, plus `border-y` because it draws both horizontal
// edges. Colons inside arbitrary variants/values are not variant separators.
function utilityWithoutVariants(token) {
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

function isZeroCssLength(value) {
  return /^[-+]?(?:0+(?:\.0*)?|\.0+)(?:[A-Za-z%]+)?$/.test(value.trim());
}

function isArbitraryBorderWidth(value) {
  const bracketed = value.startsWith("[") && value.endsWith("]");
  const parenthesized = value.startsWith("(") && value.endsWith(")");
  if (!bracketed && !parenthesized) return false;

  const inner = value.slice(1, -1).trim();
  if (inner.startsWith("color:")) return false;
  if (inner.startsWith("length:")) return !isZeroCssLength(inner.slice("length:".length));
  // Tailwind resolves untyped CSS variables as colors in the border namespace;
  // the `(length:--name)` spelling is required to make one a width.
  if (parenthesized || inner.startsWith("var(")) return false;
  if (isZeroCssLength(inner)) return false;
  return /^(?:[-+]?(?:\d+(?:\.\d*)?|\.\d+)[A-Za-z%]+|(?:calc|min|max|clamp)\()/.test(inner);
}

function borderWidthUtilitySides(token) {
  const unprefixed = utilityWithoutVariants(token);
  const match = unprefixed.match(/^border-(t|b|y)(?:-(.+))?$/);
  if (!match) return [];

  const value = match[2];
  if (value !== undefined) {
    if (value === "0") return [];
    if (value !== "px" && !/^\d+(?:\.\d+)?$/.test(value) && !isArbitraryBorderWidth(value)) {
      return [];
    }
    if (/^\d+(?:\.\d+)?$/.test(value) && Number(value) === 0) return [];
  }

  return match[1] === "y" ? ["top", "bottom"] : [match[1] === "t" ? "top" : "bottom"];
}

function classStringsFrom(node, out) {
  if (!node) return out;
  if (node.type === "Literal" && typeof node.value === "string") {
    out.push(node.value);
  } else if (node.type === "TemplateLiteral") {
    for (const quasi of node.quasis) out.push(quasi.value.cooked ?? "");
  } else if (node.type === "JSXExpressionContainer") {
    classStringsFrom(node.expression, out);
  } else if (
    node.type === "CallExpression" &&
    node.callee?.type === "Identifier" &&
    node.callee.name === "cn"
  ) {
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
  return classStringsFrom(attribute.value, []).some((value) =>
    value
      .split(/\s+/)
      .filter(Boolean)
      .some((token) => borderWidthUtilitySides(token).includes(side)),
  );
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
    function canRenderNothing(node) {
      if (!node) return true;
      if (node.type === "JSXExpressionContainer") return canRenderNothing(node.expression);
      if (node.type === "JSXEmptyExpression") return true;
      if (node.type === "Literal") {
        return node.value === null || typeof node.value === "boolean" || node.value === "";
      }
      if (node.type === "Identifier") return node.name === "undefined";
      if (node.type === "LogicalExpression") {
        if (node.operator === "&&") {
          // JSX and fragments are truthy values, so only the right-hand side is
          // rendered. An unknown condition may instead render false/null.
          if (node.left.type === "JSXElement" || node.left.type === "JSXFragment") {
            return canRenderNothing(node.right);
          }
          return true;
        }
        return canRenderNothing(node.left) || canRenderNothing(node.right);
      }
      if (node.type === "ConditionalExpression") {
        return canRenderNothing(node.consequent) || canRenderNothing(node.alternate);
      }
      if (node.type === "JSXFragment") {
        return meaningfulChildren(node).every(canRenderNothing);
      }
      if (node.type === "ArrayExpression") {
        return node.elements.every(canRenderNothing);
      }
      return false;
    }

    function boundaryElementsAcross(children, side) {
      const ordered = side === "top" ? children : [...children].reverse();
      const elements = [];
      for (const child of ordered) {
        elements.push(...boundaryElements(child, side));
        if (!canRenderNothing(child)) break;
      }
      return elements;
    }

    function boundaryElements(node, side) {
      if (!node) return [];
      if (node.type === "JSXElement") return [node];
      if (node.type === "JSXExpressionContainer") {
        return boundaryElements(node.expression, side);
      }
      if (node.type === "LogicalExpression") {
        if (node.operator === "&&") return boundaryElements(node.right, side);
        return [...boundaryElements(node.left, side), ...boundaryElements(node.right, side)];
      }
      if (node.type === "ConditionalExpression") {
        return [
          ...boundaryElements(node.consequent, side),
          ...boundaryElements(node.alternate, side),
        ];
      }
      if (node.type === "JSXFragment") {
        return boundaryElementsAcross(meaningfulChildren(node), side);
      }
      return [];
    }

    function reportSibling(neighbour, side) {
      const ruleElement = boundaryElements(neighbour, side).find((element) =>
        drawsDirectionalRule(element, side),
      );
      if (!ruleElement) return false;
      context.report({
        node: neighbour,
        messageId: "onSibling",
        data: { what: elementName(ruleElement) === "hr" ? "<hr>" : "border-t/border-b" },
      });
      return true;
    }

    function reportAdjacentSibling(siblings, startIndex, step, side) {
      for (let index = startIndex; index >= 0 && index < siblings.length; index += step) {
        const neighbour = siblings[index];
        if (reportSibling(neighbour, side)) return;
        if (!canRenderNothing(neighbour)) return;
      }
    }

    function touchesBoundary(siblings, nodeIndex, side) {
      const between = side === "top" ? siblings.slice(0, nodeIndex) : siblings.slice(nodeIndex + 1);
      return between.every(canRenderNothing);
    }

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
      const index = siblings.indexOf(node);
      const touchesTop = touchesBoundary(siblings, index, "top");
      const touchesBottom = touchesBoundary(siblings, index, "bottom");

      // The wrapper that draws its own rule on the same boundary. Only when the
      // label is the wrapper's leading or trailing child: a label in the middle
      // of a stack is not on the wrapper's top or bottom edge.
      if (parent.type === "JSXElement") {
        const wrapperClass = classAttribute(parent);
        if (
          wrapperClass &&
          ((touchesTop && drawsDirectionalRule(parent, "top")) ||
            (touchesBottom && drawsDirectionalRule(parent, "bottom")))
        ) {
          context.report({ node: wrapperClass, messageId: "onWrapper" });
        }
      }

      // Visually adjacent siblings on either side. A conditional that renders
      // nothing does not create a boundary, so continue through that branch.
      reportAdjacentSibling(siblings, index - 1, -1, "bottom");
      reportAdjacentSibling(siblings, index + 1, 1, "top");

      // A wrapper does not make its outer boundary non-adjacent. This is the
      // CollapsibleCard shape: the label is the summary's trailing child and a
      // border-t on the following content div still doubles the label's rule.
      if (parent.type === "JSXElement") {
        const grandparent = parent.parent;
        if (grandparent?.type !== "JSXElement" && grandparent?.type !== "JSXFragment") return;
        const outerSiblings = meaningfulChildren(grandparent);
        const parentIndex = outerSiblings.indexOf(parent);
        if (touchesTop) {
          reportAdjacentSibling(outerSiblings, parentIndex - 1, -1, "bottom");
        }
        if (touchesBottom) {
          reportAdjacentSibling(outerSiblings, parentIndex + 1, 1, "top");
        }
      }
    }

    return { JSXElement: checkElement };
  },
};

export default rule;
