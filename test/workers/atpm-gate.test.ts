import { afterEach, describe, expect, test, vi } from "vitest";
import { atpmAdapter, selectAtpmBaseline } from "../../server/lib/ecosystems/atpm";
import {
  atpmWorkflowGateAdapter,
  isBuiltByRun,
} from "../../server/lib/ecosystems/atpm/workflow-gate";
import { verifyAtpmProvenance } from "../../server/lib/ecosystems/atpm/provenance";
import type { AtpmStagedVersion } from "../../server/lib/ecosystems/atpm/stage-record";
import type { AtpmPackage } from "../../server/lib/ecosystems/atpm/record";
import { WorkflowArtifactError } from "../../server/lib/github-app/artifacts";
import {
  PUBLISHER_SOURCED_ECOSYSTEMS,
  SUPPORTED_ECOSYSTEMS,
} from "../../server/lib/github-app/config";
import { ECOSYSTEMS, supportedWorkflowGateEcosystems } from "../../server/lib/ecosystems";
import type { TargetGateContext } from "../../server/lib/workflow-gates/types";

const DID = "did:plc:twegdcgytckr5cxm57gyruxa";
const PDS = "https://shiitake.us-east.host.bsky.network";
const CID = "bafkreibrz4xmz6sbraw6h2mtchh5xq7jqghrjhr3yyyub3wbyrvmyjg2bm";

// The same real Fulcio-signed bundle the provenance suite uses. Here it stands
// in for the attestation `npm stage publish --provenance` attaches, and its
// certificate is the thing that binds a candidate to one workflow run.
import BUNDLE_FIXTURE from "../fixtures/atpm/sigstore-3.0.0.provenance.json";

const BUNDLE = BUNDLE_FIXTURE as unknown as Record<string, unknown>;

// Both values are read out of that certificate, not out of any record.
const REPOSITORY = "sigstore/sigstore-js";
const RUN_ID = 11331290387;

function stagedVersion(overrides: Partial<AtpmStagedVersion> = {}): AtpmStagedVersion {
  return {
    rkey: "3lmabcdefghij",
    uri: `at://${DID}/dev.atpm.alpha.stage/3lmabcdefghij`,
    recordCid: "bafyreih5wqzfvyjyw2djzp2zaqf2wmn3tjq4vg6nxbwjqz6c5xkxq6snqi",
    stageId: "e852a96a-83f5-5c21-97c4-dce5b2f116ad",
    declaredName: "@ebey.dev/counter",
    version: "0.0.16",
    declaredVersion: "0.0.16",
    tag: "latest",
    createdAt: "2026-08-13T06:28:24.000Z",
    cid: CID,
    size: 604,
    declaredShasum: null,
    declaredIntegrity: null,
    declaredTarball: `${PDS}/xrpc/com.atproto.sync.getBlob?did=${DID}&cid=${CID}`,
    provenance: { status: "absent" },
    ...overrides,
  };
}

function gateContext(overrides: Partial<TargetGateContext> = {}): TargetGateContext {
  return {
    env: {} as Cloudflare.Env,
    executionCtx: {} as ExecutionContext,
    organizationId: "org_1",
    repositoryFullName: REPOSITORY,
    runId: RUN_ID,
    environment: "production",
    publisherRef: "@ebey.dev",
    ...overrides,
  };
}

async function verifiedProvenance() {
  const state = await verifyAtpmProvenance(BUNDLE);
  if (state.status !== "verified") throw new Error("fixture must verify");
  return state;
}

describe("atpm gate configuration", () => {
  // The request-shape boundary restates both lists as literals, because it sits
  // underneath the GitHub API client this adapter imports and reading the
  // registry from there forms a cycle. These two assertions are what stop the
  // restatement from drifting.
  test("a release target may pin every ecosystem that declares a gate", () => {
    expect([...SUPPORTED_ECOSYSTEMS].sort()).toEqual(supportedWorkflowGateEcosystems().sort());
  });

  test("the ecosystems that require a publisher are the target-sourced gates", () => {
    const targetSourced = ECOSYSTEMS.filter(
      (eco) => eco.gate?.prepareReleaseCandidatesFromTarget,
    ).map((eco) => eco.id);
    expect([...PUBLISHER_SOURCED_ECOSYSTEMS].sort()).toEqual(targetSourced.sort());
  });

  test("never claims a bundle entry", () => {
    // Candidates come from the publisher's repository, so this adapter must not
    // pull an uploaded `.tgz` away from npm on an auto-detect target.
    expect(atpmWorkflowGateAdapter.classifyArtifact("package-1.0.0.tgz")).toBeNull();
    expect(atpmWorkflowGateAdapter.detectArtifact({ files: [], packageJson: null })).toBeNull();
    expect(() => atpmWorkflowGateAdapter.prepareReleaseCandidates([])).toThrow(
      WorkflowArtifactError,
    );
  });

  test("declares the target-sourced hook the runner branches on", () => {
    expect(typeof atpmWorkflowGateAdapter.prepareReleaseCandidatesFromTarget).toBe("function");
    expect(atpmWorkflowGateAdapter.packageAdapter).toBe(atpmAdapter);
  });
});

describe("isBuiltByRun", () => {
  test("binds a candidate whose certificate names this repository and run", async () => {
    const provenance = await verifiedProvenance();
    expect(isBuiltByRun(stagedVersion({ provenance }), REPOSITORY, RUN_ID)).toBe(true);
  });

  test("accepts a re-run attempt of the same run", async () => {
    const provenance = await verifiedProvenance();
    expect(provenance.provenance.runInvocation).toContain("/attempts/1");
    expect(isBuiltByRun(stagedVersion({ provenance }), REPOSITORY, RUN_ID)).toBe(true);
  });

  test("refuses a candidate built by a different run of the same repository", async () => {
    const provenance = await verifiedProvenance();
    expect(isBuiltByRun(stagedVersion({ provenance }), REPOSITORY, RUN_ID + 1)).toBe(false);
  });

  test("refuses a candidate built by a different repository", async () => {
    const provenance = await verifiedProvenance();
    expect(isBuiltByRun(stagedVersion({ provenance }), "attacker/fork", RUN_ID)).toBe(false);
  });

  test("refuses a candidate with no verified provenance at all", () => {
    for (const provenance of [
      { status: "absent" } as const,
      { status: "invalid", reason: "x" } as const,
      { status: "not-evaluated" } as const,
    ]) {
      expect(isBuiltByRun(stagedVersion({ provenance }), REPOSITORY, RUN_ID)).toBe(false);
    }
  });

  test("refuses a run URI that is not on github.com", async () => {
    const { provenance } = await verifiedProvenance();
    expect(
      isBuiltByRun(
        stagedVersion({
          provenance: {
            status: "verified",
            provenance: {
              ...provenance,
              runInvocation: `https://evil.example/${REPOSITORY}/actions/runs/${RUN_ID}`,
            },
          },
        }),
        REPOSITORY,
        RUN_ID,
      ),
    ).toBe(false);
  });

  test("does not let a longer run id pass as a prefix of this one", async () => {
    const { provenance } = await verifiedProvenance();
    expect(
      isBuiltByRun(
        stagedVersion({
          provenance: {
            status: "verified",
            provenance: {
              ...provenance,
              runInvocation: `https://github.com/${REPOSITORY}/actions/runs/${RUN_ID}9`,
            },
          },
        }),
        REPOSITORY,
        RUN_ID,
      ),
    ).toBe(false);
  });
});

describe("prepareReleaseCandidatesFromTarget", () => {
  afterEach(() => vi.unstubAllGlobals());

  test("refuses a release target that names no publishing account", async () => {
    await expect(
      atpmWorkflowGateAdapter.prepareReleaseCandidatesFromTarget!(
        gateContext({ publisherRef: null }),
      ),
    ).rejects.toMatchObject({ code: "release_target_misconfigured" });
  });

  test("refuses a publishing account that is not addressable", async () => {
    await expect(
      atpmWorkflowGateAdapter.prepareReleaseCandidatesFromTarget!(
        gateContext({ publisherRef: "@localhost" }),
      ),
    ).rejects.toMatchObject({ code: "release_target_misconfigured" });
  });

  test("refuses a publishing account that does not resolve", async () => {
    vi.stubGlobal("fetch", () => Promise.resolve(new Response("no", { status: 404 })));
    await expect(
      atpmWorkflowGateAdapter.prepareReleaseCandidatesFromTarget!(gateContext()),
    ).rejects.toMatchObject({ code: "release_target_misconfigured" });
  });
});

describe("selectAtpmBaseline", () => {
  function published(versions: string[], tags: Record<string, string> = {}): AtpmPackage {
    return {
      tags,
      unreadableVersions: [],
      versions: versions.map((version) => ({
        version,
        cid: CID,
        size: 604,
        mimeType: "application/gzip",
        createdAt: "2026-01-01T00:00:00.000Z",
        declaredName: "@ebey.dev/counter",
        declaredVersion: version,
        declaredShasum: null,
        declaredTarball: null,
        declaredIntegrity: null,
        provenance: { status: "absent" },
      })),
    };
  }

  test("prefers the published version behind the tag this candidate would move", () => {
    const selected = selectAtpmBaseline(published(["0.0.14", "0.0.15"], { latest: "0.0.14" }), {
      version: "0.0.16",
      tag: "latest",
    });
    expect(selected.entry?.version).toBe("0.0.14");
    expect(selected.info.source).toBe("dist-tag");
  });

  test("falls back to the immediate semver predecessor", () => {
    const selected = selectAtpmBaseline(published(["0.0.14", "0.0.15", "1.0.0"]), {
      version: "0.0.16",
      tag: "next",
    });
    expect(selected.entry?.version).toBe("0.0.15");
    expect(selected.info.source).toBe("semver-predecessor");
  });

  test("uses the highest published version when the candidate does not supersede one", () => {
    const selected = selectAtpmBaseline(published(["1.0.0"]), { version: "0.0.1", tag: null });
    expect(selected.entry?.version).toBe("1.0.0");
    expect(selected.info.source).toBe("highest-published");
  });

  test("reviews a first release with no baseline rather than failing", () => {
    const selected = selectAtpmBaseline(published([]), { version: "0.0.1", tag: "latest" });
    expect(selected.entry).toBeNull();
    expect(selected.info.source).toBe("none");
  });
});

describe("atpm staged adapter", () => {
  test("holds no organization credential", () => {
    expect(atpmAdapter.requiresConnection).toBe(false);
    expect(atpmAdapter.preflightStaged).toBeUndefined();
  });

  test("accepts only staged references it can address", () => {
    expect(atpmAdapter.parseInput({ stageId: `atpm:${DID}:3lmabcdefghij` }).ref.did).toBe(DID);
    expect(() => atpmAdapter.parseInput({ stageId: "npm-style-stage-id" })).toThrow(
      /invalid atpm stageId/,
    );
    expect(() => atpmAdapter.parseInput(null)).toThrow();
  });
});
