import { isValidElement, type ComponentChildren, type VNode } from "preact";
import { describe, expect, test, vi } from "vitest";
import { Button } from "../src/components/Button";
import { LoadingLine } from "../src/components/Typography";
import { GateContextPanel } from "../src/pages/Dashboard/ScanDetail/GateDecisionDialog";

function elements(
  node: ComponentChildren,
): VNode<{ children?: ComponentChildren; onClick?: () => void }>[] {
  if (Array.isArray(node)) return node.flatMap(elements);
  if (!isValidElement(node)) return [];
  return [node, ...elements(node.props.children)];
}

describe("GateContextPanel lookup state", () => {
  test("replaces loading with a recoverable notice when lookup stops", () => {
    const retry = vi.fn();
    const tree = elements(
      GateContextPanel({
        gate: null,
        packageName: "left-pad",
        lookupStalled: true,
        onRetryLookup: retry,
      }),
    );
    expect(tree.some((node) => node.type === LoadingLine)).toBe(false);
    expect(
      tree.some(
        (node) =>
          node.props.children === "Gate context could not be loaded. Automatic lookup has stopped.",
      ),
    ).toBe(true);
    const button = tree.find((node) => node.type === Button);
    expect(button?.props.children).toBe("Retry lookup");
    button?.props.onClick?.();
    expect(retry).toHaveBeenCalledOnce();
  });

  test("keeps the loading indicator while lookup is still active", () => {
    const tree = elements(GateContextPanel({ gate: null, packageName: "left-pad" }));
    expect(tree.some((node) => node.type === LoadingLine)).toBe(true);
    expect(tree.some((node) => node.type === Button)).toBe(false);
  });
});
