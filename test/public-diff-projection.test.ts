import { describe, expect, test } from "vitest";
import {
  projectPublicDiffCapabilities,
  projectPublicDiffSourceBinding,
} from "../server/lib/public-diff/projection";
import type { PublicDiffAcquiredSide } from "../server/lib/public-diff/types";
import type { FileRecord } from "../server/lib/review";

function side(files: FileRecord[] = []): PublicDiffAcquiredSide {
  return { files, packageJson: null };
}

function packageManifest(repository: string): FileRecord {
  return {
    path: "package.json",
    size: repository.length,
    sha256: "manifest",
    flags: [],
    textSample: JSON.stringify({ repository }),
  };
}

describe("public diff projections", () => {
  test("marks capability deltas unconfident when acquisition omitted artifact evidence", () => {
    const capabilities = projectPublicDiffCapabilities({
      from: { ...side(), capabilityCoverageComplete: false },
      to: { ...side(), capabilityCoverageComplete: false },
    });

    expect(capabilities.from?.complete).toBe(false);
    expect(capabilities.to.complete).toBe(false);
    expect(capabilities.confident).toBe(false);
  });

  test.each([
    [null, "https://github.com/owner/repo", true],
    ["https://github.com/owner/repo", null, true],
    ["https://github.com/owner/repo", "https://github.com/owner/repo", false],
  ])("projects source binding %s to %s as changed=%s", (from, to, changed) => {
    const binding = projectPublicDiffSourceBinding(
      side(from ? [packageManifest(from)] : []),
      side(to ? [packageManifest(to)] : []),
    );

    expect(binding).toEqual({ from, to, changed });
  });
});
