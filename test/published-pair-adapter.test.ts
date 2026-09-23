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

  test("persists the reviewed tarball's digests and the registry it read them from", async () => {
    const sources: PublicDiffAcquiredSources = {
      from: { files: [], packageJson: null },
      to: { files: [], packageJson: null },
      toDigests: { sha1: "A".repeat(40), sha256: "not a digest" },
      buildFindings: vi.fn(() => []),
    };
    const acquire = vi.fn(async () => sources);
    const publicDiff = {
      ecosystem: "npm",
      registryUrl: "https://registry.npmjs.org",
      rulesVersionSegment: "test",
      payloadVersion: "test",
      isValidPackageName: () => true,
      normalizePackageName: (name: string) => name,
      isValidVersion: () => true,
      cacheTag: () => "test",
      // The local harness's loopback registry, as npm returns it only under
      // the explicit local-development override.
      publishedRegistryUrl: () => "http://127.0.0.1:5481",
      listVersions: vi.fn(),
      acquire,
    } satisfies PublicDiffAdapter;
    const adapter = publishedPairAdapter(publicDiff);
    const context = { env: {} } as AdapterContext;
    const pair: PublishedPairRef = {
      ecosystem: "npm",
      packageName: "pkg",
      version: "2.0.0",
      baselineVersion: "1.0.0",
    };
    const broker = adapter.createBroker(context, { organizationId: "org" });
    const staged = await adapter.acquireStaged(context, pair, broker);

    expect(acquire).toHaveBeenCalledWith(
      context.env,
      undefined,
      expect.objectContaining({
        registryUrl: "http://127.0.0.1:5481",
        allowInsecureLocalhost: true,
      }),
    );
    expect(adapter.summarizeDetails(staged.details)).toMatchObject({
      mode: "published_pair",
      registryUrl: "http://127.0.0.1:5481",
      // Lowercased, and a malformed digest is dropped rather than persisted.
      artifactDigest: { sha1: "a".repeat(40), sha256: null },
    });
  });
});
