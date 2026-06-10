/**
 * Flag conditional rendering whose condition reads (or derives from) a signal's
 * `.value`, expressed as a ternary or `&&`/`||`/`??` in JSX child position
 * instead of `<Show>`.
 *
 * Eagerly unwrapping a signal to branch in the component body subscribes the
 * whole component, so any change re-renders everything — even the parts that
 * didn't change. `<Show when={signal}>` (or `when={() => derived}` for a derived
 * condition) moves the subscription into a tiny boundary component, so only the
 * conditional subtree re-renders.
 *
 *   {error.value ? <Alert>{error.value}</Alert> : null}        // flagged
 *   {open.value && <Panel />}                                  // flagged
 *   {loading.value ? "Saving…" : "Save"}                       // flagged (text too)
 *   <Show when={error}>{(msg) => <Alert>{msg}</Alert>}</Show>  // preferred
 *   <Show when={loading} fallback="Save">Saving…</Show>        // preferred
 *
 * Both element and text branches are reported, because the fix is the same
 * `<Show>` either way. A single derivation that is not a two-way conditional —
 * e.g. `{trigger(open.value)}` or `{format(size.value)}` — is NOT reported;
 * lift those into a `useComputed` and render the computed directly.
 *
 * Only child position is reported. Attribute values like
 * `disabled={loading.value ? a : b}` cannot host a `<Show>`, so they are left
 * for a `useComputed` and not flagged.
 *
 * Limitation: detection is scope-based, so it catches signals declared as
 * locals (`useSignal`/`useComputed`/`signal`/`computed`) or typed
 * `Signal`/`ReadonlySignal`. Signals reached only through member access
 * (e.g. `model.count.value`) are missed unless type information is available,
 * which oxlint generally does not provide today.
 */

import { readFileSync } from "node:fs";
import { isAbsolute, relative, sep } from "node:path";
import { isKnownSignal, isSignalByTypeChecker } from "./signals-scope.mjs";

const SKIP_KEYS = new Set(["parent", "loc", "range", "start", "end", "type"]);

// Baseline of pre-existing infractions, grandfathered so the rule can ship as
// `error` without first migrating every call site to `<Show>`. Keyed by
// repo-relative path → 1-based line numbers; anything NOT listed still errors,
// so the baseline only shrinks. Burn it down as sites migrate, then regenerate:
//   node tooling/oxlint/signals-local/regenerate-suppressions.mjs
// (SIGNALS_NO_SUPPRESS=1 bypasses the baseline — the regenerator sets it.)
const SUPPRESSIONS =
  process.env.SIGNALS_NO_SUPPRESS === "1"
    ? {}
    : (() => {
        try {
          return JSON.parse(readFileSync(new URL("./suppressions.json", import.meta.url), "utf8"));
        } catch {
          return {};
        }
      })();

/** Repo-relative, forward-slashed path so lookups match suppressions.json keys. */
function toRepoRelative(filename) {
  if (!filename) return "";
  const rel = isAbsolute(filename) ? relative(process.cwd(), filename) : filename;
  return rel.split(sep).join("/");
}

/** @type {import("eslint").Rule.RuleModule} */
const rule = {
  meta: {
    type: "suggestion",
    docs: {
      description:
        "Render conditional JSX driven by a signal through `<Show>` instead of an eagerly-unwrapped ternary or `&&`",
      recommended: true,
    },
    messages: {
      ternary:
        "Conditional JSX driven by a signal. Reading `.value` here subscribes the whole component, so any change re-renders everything. Use `<Show when={signal}>` (or `when={() => derived}` for a derived condition) so only this subtree re-renders.",
      logical:
        "Conditional JSX driven by a signal. Reading `.value` here subscribes the whole component, so any change re-renders everything. Use `<Show when={signal}>` (or `when={() => derived}` for a derived condition) so only this subtree re-renders.",
    },
    schema: [],
  },

  create(context) {
    const sourceCode = context.sourceCode ?? context.getSourceCode();
    const parserServices = context.parserServices ?? sourceCode?.parserServices;

    // Skip infractions grandfathered in the baseline (see SUPPRESSIONS above).
    const suppressedLines = new Set(
      SUPPRESSIONS[toRepoRelative(context.filename ?? context.getFilename?.() ?? "")] ?? [],
    );
    function reportConditional(node, messageId) {
      if (suppressedLines.has(node.loc?.start?.line)) return;
      context.report({ node, messageId });
    }

    function isSignal(node) {
      return isKnownSignal(sourceCode, node) || isSignalByTypeChecker(parserServices, node);
    }

    /** A `<signal>.value` member read, where `<signal>` is a known signal. */
    function isSignalValueRead(node) {
      return (
        node?.type === "MemberExpression" &&
        !node.computed &&
        node.property.type === "Identifier" &&
        node.property.name === "value" &&
        isSignal(node.object)
      );
    }

    /**
     * Walk an expression subtree looking for any `<signal>.value` read. This is
     * what makes a condition count as "derived from a signal" — `!a.value`,
     * `a.value > 3`, `a.value && b.value`, `fn(a.value)` all qualify.
     */
    function containsSignalValueRead(node) {
      if (!node || typeof node.type !== "string") return false;
      if (isSignalValueRead(node)) return true;
      for (const key in node) {
        if (SKIP_KEYS.has(key)) continue;
        const child = node[key];
        if (Array.isArray(child)) {
          for (const item of child) {
            if (item && typeof item.type === "string" && containsSignalValueRead(item)) {
              return true;
            }
          }
        } else if (child && typeof child.type === "string") {
          if (containsSignalValueRead(child)) return true;
        }
      }
      return false;
    }

    return {
      JSXExpressionContainer(node) {
        // Only conditional rendering in child position is fixable with `<Show>`;
        // attribute values (`<X disabled={a.value ? …} />`) cannot host one and
        // are left for a `useComputed`.
        const parentType = node.parent?.type;
        if (parentType !== "JSXElement" && parentType !== "JSXFragment") return;

        const expr = node.expression;
        if (!expr) return;

        if (expr.type === "ConditionalExpression") {
          if (containsSignalValueRead(expr.test)) {
            reportConditional(expr, "ternary");
          }
        } else if (
          expr.type === "LogicalExpression" &&
          (expr.operator === "&&" || expr.operator === "||" || expr.operator === "??")
        ) {
          if (containsSignalValueRead(expr.left)) {
            reportConditional(expr, "logical");
          }
        }
      },
    };
  },
};

export default rule;
