import { describe, expect, test } from "vitest";
import { scanPublicPackageIdentity } from "../server/lib/public-feed";

describe("scanPublicPackageIdentity", () => {
  test("does not expose a name-only browser artifact as a badge identity", () => {
    expect(
      scanPublicPackageIdentity(
        "workflow_gate",
        {
          stagedPublish: {
            publicPackageIdentity: null,
            provenance: { ecosystem: "browser", mode: "workflow_gate", artifacts: [] },
          },
        },
        "Tab helper",
      ),
    ).toBeNull();
  });
});
