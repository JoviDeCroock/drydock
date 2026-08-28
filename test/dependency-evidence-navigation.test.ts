import { describe, expect, test } from "vitest";
import { dependencyEvidenceDomId } from "../src/lib/dependency-evidence-navigation";

describe("dependencyEvidenceDomId", () => {
  test("keeps identical package names in separate declaration coordinates", () => {
    const runtime = dependencyEvidenceDomId({
      name: "shared",
      section: "dependencies",
      declaredSpec: "1.0.0",
    });
    const peer = dependencyEvidenceDomId({
      name: "shared",
      section: "peerDependencies",
      declaredSpec: "2.0.0",
    });

    expect(runtime).not.toBe(peer);
    expect(decodeURIComponent(runtime)).toContain('["dependencies","shared","1.0.0"]');
    expect(decodeURIComponent(peer)).toContain('["peerDependencies","shared","2.0.0"]');
  });
});
