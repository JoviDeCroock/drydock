import { describe, expect, test } from "vitest";
import {
  classifyDisappearedStage,
  STAGE_WITHDRAWN_CONFIRMATION_MS,
} from "../server/lib/release-detection";
import type { RegistryMetadata } from "../server/lib/registry";

const NOW = new Date("2026-06-12T12:00:00.000Z");
const STAGED_SHASUM = "aaaa1111aaaa1111aaaa1111aaaa1111aaaa1111";

function packument(input: {
  version?: string;
  shasum?: string | null;
  publishedAt?: string;
}): RegistryMetadata {
  const version = input.version ?? "1.2.3";
  return {
    versions: {
      [version]: { dist: input.shasum === null ? {} : { shasum: input.shasum ?? STAGED_SHASUM } },
    },
    time: input.publishedAt ? { [version]: input.publishedAt } : {},
  };
}

describe("classifyDisappearedStage", () => {
  test("released when the staged version is published with a matching shasum", () => {
    const outcome = classifyDisappearedStage({
      stagedVersion: "1.2.3",
      stagedShasum: STAGED_SHASUM,
      metadata: packument({ publishedAt: "2026-06-12T11:00:00.000Z" }),
      stageMissingSince: null,
      now: NOW,
    });
    expect(outcome).toEqual({
      status: "released",
      shasumVerified: true,
      publishedAt: new Date("2026-06-12T11:00:00.000Z"),
    });
  });

  test("released but unverified when either shasum is unknown", () => {
    const noStagedShasum = classifyDisappearedStage({
      stagedVersion: "1.2.3",
      stagedShasum: null,
      metadata: packument({}),
      stageMissingSince: null,
      now: NOW,
    });
    expect(noStagedShasum).toMatchObject({ status: "released", shasumVerified: false });

    const noPublishedShasum = classifyDisappearedStage({
      stagedVersion: "1.2.3",
      stagedShasum: STAGED_SHASUM,
      metadata: packument({ shasum: null }),
      stageMissingSince: null,
      now: NOW,
    });
    expect(noPublishedShasum).toMatchObject({ status: "released", shasumVerified: false });
  });

  test("released_mismatch when the published bytes differ from the reviewed bytes", () => {
    const outcome = classifyDisappearedStage({
      stagedVersion: "1.2.3",
      stagedShasum: STAGED_SHASUM,
      metadata: packument({ shasum: "bbbb2222bbbb2222bbbb2222bbbb2222bbbb2222" }),
      stageMissingSince: null,
      now: NOW,
    });
    expect(outcome).toMatchObject({
      status: "released_mismatch",
      publishedShasum: "bbbb2222bbbb2222bbbb2222bbbb2222bbbb2222",
    });
  });

  test("pending on first observation of a missing stage", () => {
    const outcome = classifyDisappearedStage({
      stagedVersion: "1.2.3",
      stagedShasum: STAGED_SHASUM,
      metadata: null,
      stageMissingSince: null,
      now: NOW,
    });
    expect(outcome).toEqual({ status: "pending" });
  });

  test("pending while inside the withdrawal confirmation window", () => {
    const outcome = classifyDisappearedStage({
      stagedVersion: "1.2.3",
      stagedShasum: STAGED_SHASUM,
      metadata: { versions: {} },
      stageMissingSince: new Date(NOW.getTime() - STAGE_WITHDRAWN_CONFIRMATION_MS + 1000),
      now: NOW,
    });
    expect(outcome).toEqual({ status: "pending" });
  });

  test("withdrawn once the version stays unpublished past the confirmation window", () => {
    const outcome = classifyDisappearedStage({
      stagedVersion: "1.2.3",
      stagedShasum: STAGED_SHASUM,
      metadata: null,
      stageMissingSince: new Date(NOW.getTime() - STAGE_WITHDRAWN_CONFIRMATION_MS),
      now: NOW,
    });
    expect(outcome).toEqual({ status: "withdrawn" });
  });

  test("a different published version does not count as a release of the staged version", () => {
    const outcome = classifyDisappearedStage({
      stagedVersion: "1.2.4",
      stagedShasum: STAGED_SHASUM,
      metadata: packument({ version: "1.2.3" }),
      stageMissingSince: null,
      now: NOW,
    });
    expect(outcome).toEqual({ status: "pending" });
  });
});
