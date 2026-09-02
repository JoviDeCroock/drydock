import { describe, expect, test, vi } from "vitest";
import type { AdapterContext } from "../server/lib/ecosystems/package-adapter";
import {
  publishedPairAdapter,
  type PublishedPairRef,
} from "../server/lib/ecosystems/published-pair";
import type { PublicDiffAcquiredSources, PublicDiffAdapter } from "../server/lib/public-diff/types";
import { summarizePackageJsonDiff } from "../server/lib/review";

describe("published-pair adapter", () => {
  test("releases the broker's raw source holder after deterministic findings", async () => {
    const sources: PublicDiffAcquiredSources = {
      from: {
        files: [{ path: "index.js", size: 3, sha256: "old", textSample: "old", flags: [] }],
        packageJson: null,
      },
      to: {
        files: [{ path: "index.js", size: 3, sha256: "new", textSample: "new", flags: [] }],
        packageJson: null,
      },
      buildFindings: vi.fn(() => []),
    };
    const publicDiff = {
      ecosystem: "npm",
      registryUrl: "https://registry.npmjs.org",
      rulesVersionSegment: "test",
      payloadVersion: "test",
      isValidPackageName: () => true,
      normalizePackageName: (name: string) => name,
      isValidVersion: () => true,
      cacheTag: () => "test",
      listVersions: vi.fn(),
      acquire: vi.fn(async () => sources),
    } satisfies PublicDiffAdapter;
    const adapter = publishedPairAdapter(publicDiff);
    const context = {} as AdapterContext;
    const pair: PublishedPairRef = {
      ecosystem: "npm",
      packageName: "pkg",
      version: "2.0.0",
      baselineVersion: "1.0.0",
    };
    const broker = adapter.createBroker(context, { organizationId: "org" });
    const staged = await adapter.acquireStaged(context, pair, broker);
    const baseline = await adapter.acquireBaseline(context, pair, broker, staged);

    expect((broker as unknown as { sources: unknown }).sources).toBe(sources);
    adapter.runFindings({
      staged: staged.artifact,
      baseline: baseline.artifact,
      details: staged.details,
      fileDiff: [],
      manifestDiff: summarizePackageJsonDiff(null, null),
      stagedManifestText: null,
    });
    expect(sources.buildFindings).toHaveBeenCalledOnce();
    expect((broker as unknown as { sources: unknown }).sources).toBeNull();
  });
});
