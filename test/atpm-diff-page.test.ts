import { describe, expect, test } from "vitest";
import { buildProvenanceExplanation } from "../src/pages/Diff/TrustEvidence";

describe("atpm build provenance copy", () => {
  test("does not collapse an unsupported trusted-publisher provider into no declaration", () => {
    expect(
      buildProvenanceExplanation(
        {
          status: "verified",
          match: "unknown-provider",
          build: {
            repository: "https://github.com/example/package",
            ref: null,
            commit: null,
            workflow: null,
            runUrl: null,
            runnerEnvironment: "github-hosted",
            signedAt: "2026-08-21T00:00:00.000Z",
            logIndex: "1",
            logBaseUrl: "https://rekor.sigstore.dev",
          },
        },
        false,
      ),
    ).toContain("declares a trusted-publisher provider");
  });
});
