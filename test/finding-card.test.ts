import type { ComponentChildren, VNode } from "preact";
import { describe, expect, test } from "vitest";
import { FindingRow } from "../src/components/FindingCard";

interface FindingValueProps {
  children: ComponentChildren;
  class: string;
}

function valueProps(row: VNode): FindingValueProps {
  const children = row.props.children as VNode[];
  return children[1].props as FindingValueProps;
}

describe("FindingRow", () => {
  test("wraps long evidence without discarding its full value", () => {
    const evidence = `4825200 byte binary; sha256 ${"a".repeat(64)}`;
    const value = valueProps(FindingRow({ label: "evidence", value: evidence }));

    expect(value.class).toContain("break-words");
    expect(value.class).not.toContain("truncate");
    expect(value.children).toBe(evidence);
  });

  test("keeps explanatory rows non-interactive", () => {
    const reason = "large binary should be reviewed manually";
    const value = valueProps(FindingRow({ label: "reason", value: reason }));

    expect(value.class).not.toContain("truncate");
    expect(value.children).toBe(reason);
  });
});
