import { describe, expect, test } from "vitest";
import { buildTree, type FolderNode } from "../src/components/file-tree-model.ts";

const entry = (path: string, status: "added" | "removed" | "modified" | "unchanged") => ({
  path,
  status,
});

function findFolder(nodes: ReturnType<typeof buildTree>, path: string): FolderNode | undefined {
  for (const node of nodes) {
    if (node.kind === "folder") {
      if (node.path === path) return node;
      const nested = findFolder(node.children, path);
      if (nested) return nested;
    }
  }
  return undefined;
}

describe("buildTree finding counts", () => {
  test("attaches per-file counts and bubbles count + max severity up folders", () => {
    const counts = new Map([
      ["lib/install.js", { count: 2, maxSeverity: "critical" }],
      ["lib/util/helper.js", { count: 1, maxSeverity: "low" }],
      ["index.js", { count: 1, maxSeverity: "medium" }],
    ]);
    const tree = buildTree(
      [
        entry("lib/install.js", "added"),
        entry("lib/util/helper.js", "modified"),
        entry("index.js", "modified"),
        entry("README.md", "unchanged"),
      ],
      counts,
    );

    const lib = findFolder(tree, "lib");
    expect(lib?.findingCount).toBe(3);
    // critical (install.js) outranks low (util/helper.js)
    expect(lib?.findingSeverity).toBe("critical");

    const util = findFolder(tree, "lib/util");
    expect(util?.findingCount).toBe(1);
    expect(util?.findingSeverity).toBe("low");

    const readme = tree.find((node) => node.path === "README.md");
    expect(readme?.findingCount).toBe(0);
    expect(readme?.findingSeverity).toBeNull();
  });

  test("defaults every node to a zero count when no map is supplied", () => {
    const tree = buildTree([entry("lib/a.js", "added")]);
    const lib = findFolder(tree, "lib");
    expect(lib?.findingCount).toBe(0);
    expect(lib?.findingSeverity).toBeNull();
  });
});
