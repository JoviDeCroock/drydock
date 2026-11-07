import type { VNode } from "preact";
import { describe, expect, test } from "vitest";
import { FindingDetails } from "../src/components/FindingCard";
import { findingSentence } from "../src/lib/findings";

function parts(details: VNode): VNode[] {
  return (details.props.children as Array<VNode | null>).filter(Boolean) as VNode[];
}

describe("FindingDetails", () => {
  test("wraps long evidence in mono without discarding its full value", () => {
    const evidence = `4825200 byte binary; sha256 ${"a".repeat(64)}`;
    const [, value] = parts(FindingDetails({ reason: "large binary", evidence }));
    const props = value.props as { class: string; children: unknown; title?: string };

    expect(value.type).toBe("code");
    expect(props.class).toContain("font-mono");
    expect(props.class).toContain("wrap-anywhere");
    expect(props.class).not.toContain("truncate");
    expect(props.title).toBeUndefined();
    expect(props.children).toBe(evidence);
  });

  test("states the reason as a sentence and omits absent evidence", () => {
    const rendered = parts(
      FindingDetails({ reason: "large binary should be reviewed manually", evidence: "" }),
    );

    expect(rendered).toHaveLength(1);
    expect(rendered[0].props.children).toBe("Large binary should be reviewed manually.");
  });
});

describe("findingSentence", () => {
  test("capitalizes a lower-case clause and ends it", () => {
    expect(findingSentence("the staged tarball does not match")).toBe(
      "The staged tarball does not match.",
    );
  });

  test("leaves identifiers, tool names, and finished sentences alone", () => {
    expect(findingSentence("package.json could not be parsed")).toBe(
      "package.json could not be parsed.",
    );
    expect(findingSentence("npm runs this hook on install")).toBe("npm runs this hook on install.");
    expect(findingSentence("Already a sentence.")).toBe("Already a sentence.");
    expect(findingSentence("reads `process.env`")).toBe("Reads `process.env`");
  });
});
