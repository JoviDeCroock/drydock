import { describe, expect, test } from "vitest";
import {
  channelLabel,
  describeBaseline,
  groupReleasesByChannel,
  releaseAttention,
} from "../src/features/package-releases";
import { packageReleasesApiPath, packageReleasesPath } from "../src/lib/package-releases-path";

function release(overrides: Record<string, unknown> = {}) {
  return { id: crypto.randomUUID(), tag: "latest", status: "complete", ...overrides };
}

describe("releaseAttention", () => {
  test("flags an npm-published release with no Drydock decision", () => {
    expect(releaseAttention(release({ registryVersionStatus: "published" }))).toBe(
      "published_without_review",
    );
    expect(releaseAttention(release({ registryReleaseOutcome: "deleted" }))).toBe(
      "published_without_review",
    );
  });

  test("flags a blocked release npm published anyway", () => {
    expect(
      releaseAttention(release({ decision: "no_publish", registryVersionStatus: "published" })),
    ).toBe("published_despite_block");
  });

  test("stays quiet for approved, blocked-by-npm, undecided-but-staged, and superseded rows", () => {
    expect(
      releaseAttention(release({ decision: "publish", registryVersionStatus: "published" })),
    ).toBe(null);
    expect(releaseAttention(release({ registryVersionStatus: "blocked" }))).toBe(null);
    expect(releaseAttention(release({ registryVersionStatus: "staged" }))).toBe(null);
    expect(releaseAttention(release({}))).toBe(null);
    expect(
      releaseAttention(
        release({ registryVersionStatus: "published", registryStatusSupersededAt: "2026-09-01" }),
      ),
    ).toBe(null);
  });
});

describe("groupReleasesByChannel", () => {
  test("keeps latest first, other channels by most recent release, untagged last", () => {
    const rows = [
      release({ id: "next-2", tag: "next" }),
      release({ id: "gate", tag: null }),
      release({ id: "latest-1", tag: "latest" }),
      release({ id: "beta-1", tag: "beta" }),
      release({ id: "next-1", tag: "next" }),
    ];
    const groups = groupReleasesByChannel(rows);
    expect(groups.map((group) => group.tag)).toEqual(["latest", "next", "beta", null]);
    expect(groups[1].releases.map((row) => row.id)).toEqual(["next-2", "next-1"]);
  });

  test("treats a blank tag as no channel", () => {
    const groups = groupReleasesByChannel([release({ tag: "  " })]);
    expect(groups[0].tag).toBe(null);
    expect(channelLabel(groups[0].tag)).toBe("no dist-tag");
  });
});

describe("describeBaseline", () => {
  test("names the channel when its dist-tag chose the baseline", () => {
    expect(
      describeBaseline(
        release({
          previousVersion: "2.0.0-beta.1",
          baseline: { version: "2.0.0-beta.1", source: "dist-tag", tag: "beta" },
        }),
      ),
    ).toBe("2.0.0-beta.1 (beta)");
  });

  test("names the semver rule when the channel had no prior release", () => {
    expect(
      describeBaseline(
        release({
          previousVersion: "1.4.2",
          baseline: { version: "1.4.2", source: "semver-predecessor", tag: "next" },
        }),
      ),
    ).toBe("1.4.2 (previous version)");
    expect(
      describeBaseline(
        release({
          previousVersion: "3.0.0",
          baseline: { version: "3.0.0", source: "highest-published" },
        }),
      ),
    ).toBe("3.0.0 (highest published)");
  });

  test("prefers the downloaded version and states an all-added diff", () => {
    expect(
      describeBaseline(
        release({
          previousVersion: "1.0.0",
          baseline: { version: "1.0.1", source: "dist-tag", tag: "latest" },
        }),
      ),
    ).toBe("1.0.0 (latest)");
    expect(describeBaseline(release({ baseline: { version: null, source: "none" } }))).toBe(
      "no baseline (all files added)",
    );
    expect(describeBaseline(release({ status: "pending" }))).toBe("—");
  });
});

describe("package release paths", () => {
  test("encodes a scoped name as one segment and omits the npm default", () => {
    expect(packageReleasesPath("@scope/name")).toBe("/dashboard/packages/%40scope%2Fname");
    expect(packageReleasesPath("requests", "pypi")).toBe(
      "/dashboard/packages/requests?ecosystem=pypi",
    );
    expect(packageReleasesApiPath("@scope/name", { cursor: "1:abc", ecosystem: "npm" })).toBe(
      "/api/v1/packages/%40scope%2Fname/releases?cursor=1%3Aabc",
    );
  });
});
