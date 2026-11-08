import { isValidElement, type ComponentChildren, type VNode } from "preact";
import { describe, expect, test, vi } from "vitest";
import { Button } from "../src/components/Button";
import { LoadingLine } from "../src/components/Typography";
import {
  GateContextPanel,
  gateJobSentence,
} from "../src/pages/Dashboard/ScanDetail/GateDecisionDialog";

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
    const tree = elements(GateContextPanel({ gate: null }));
    expect(tree.some((node) => node.type === LoadingLine)).toBe(true);
    expect(tree.some((node) => node.type === Button)).toBe(false);
  });
});

describe("gate job sentence", () => {
  const one = [{}] as Parameters<typeof gateJobSentence>[0]["packages"];
  const two = [{}, {}] as Parameters<typeof gateJobSentence>[0]["packages"];

  test("a decided gate never claims GitHub is still holding the job", () => {
    for (const status of ["approved", "rejected"] as const) {
      expect(gateJobSentence({ status, failureReason: null, packages: two })).not.toMatch(
        /holding/,
      );
    }
    expect(gateJobSentence({ status: "rejected", failureReason: null, packages: one })).toMatch(
      /not to run the protected publish job/,
    );
  });

  test("a pending gate states the all-packages rule only when there are several", () => {
    expect(gateJobSentence({ status: "pending", failureReason: null, packages: two })).toMatch(
      /all 2 release packages are approved; rejecting any one blocks it/,
    );
    expect(gateJobSentence({ status: "pending", failureReason: null, packages: one })).not.toMatch(
      /packages/,
    );
  });

  test("an errored gate leaves the reason to its failure alert", () => {
    expect(
      gateJobSentence({ status: "errored", failureReason: "artifact missing", packages: one }),
    ).toBeNull();
    expect(gateJobSentence({ status: "errored", failureReason: null, packages: one })).toMatch(
      /cannot continue/,
    );
  });

  test("a superseded gate points at the newer request, not a held job", () => {
    const sentence = gateJobSentence({ status: "superseded", failureReason: null, packages: one });
    expect(sentence).toMatch(/newer deployment request/);
    expect(sentence).not.toMatch(/holding/);
  });

  test("a stale review leaves the explanation to its alert", () => {
    expect(
      gateJobSentence({ status: "pending", failureReason: "artifacts_changed", packages: one }),
    ).toBeNull();
  });
});
