import { afterEach, describe, expect, test, vi } from "vitest";
import {
  resolveAtpmStagedReview,
  selectBaselineVersion,
} from "../server/lib/ecosystems/atpm/staged-review";
import {
  ATPM_NO_BASELINE_VERSION,
  formatAtpmStagedVersion,
  isAtpmStagedVersion,
  parseAtpmStagedVersion,
} from "../server/lib/ecosystems/atpm/stage-ref";
import {
  assertAtpmRecordCid,
  atpmRecordCid,
  type AtpmStagedVersion,
} from "../server/lib/ecosystems/atpm/stage-record";
import type { AtpmPackage, AtpmVersion } from "../server/lib/ecosystems/atpm/record";
import { atpmStagedFindings } from "../server/lib/ecosystems/atpm/findings";
import { atpmPurl } from "../server/lib/ecosystems/atpm/provenance";
import { diffRefLabel } from "../src/lib/pkg-pr-new";

const DID = "did:plc:twegdcgytckr5cxm57gyruxa";
const PDS = "https://shiitake.us-east.host.bsky.network";
const CID = "bafkreibrz4xmz6sbraw6h2mtchh5xq7jqghrjhr3yyyub3wbyrvmyjg2bm";
const RECORD_CID = "bafyreid6s3kc6vqdqr3q32chwtumycvyd2zrzuc4p2ftcoztimngtpst6u";
const RKEY = "3lmabcdefghij";

function stageRecord(version = "0.0.16") {
  return {
    uri: `at://${DID}/dev.atpm.alpha.stage/${RKEY}`,
    cid: RECORD_CID,
    value: {
      $type: "dev.atpm.alpha.stage",
      createdAt: "2026-08-13T06:28:24.000Z",
      name: "@ebey.dev/counter",
      version,
      tags: { latest: version },
      blob: { $type: "blob", ref: { $link: CID }, size: 604, mimeType: "application/gzip" },
      meta: {
        name: "@ebey.dev/counter",
        version,
        dist: { tarball: `${PDS}/xrpc/com.atproto.sync.getBlob?did=${DID}&cid=${CID}` },
      },
    },
  };
}

function packageRecord(versions: string[], tags: Record<string, string> = {}) {
  return {
    $type: "dev.atpm.alpha.package",
    createdAt: "2026-01-01T00:00:00.000Z",
    tags,
    versions: versions.map((version) => ({
      $type: "dev.atpm.alpha.package#package",
      version,
      createdAt: "2026-01-01T00:00:00.000Z",
      blob: { $type: "blob", ref: { $link: CID }, size: 604, mimeType: "application/gzip" },
      meta: {
        name: "@ebey.dev/counter",
        version,
        dist: { tarball: `${PDS}/xrpc/com.atproto.sync.getBlob?did=${DID}&cid=${CID}` },
      },
    })),
  };
}

/** The publisher's whole resolution chain, answered from memory. */
function stubNetwork(options: { published?: unknown; staged?: unknown } = {}) {
  vi.stubGlobal("fetch", (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.startsWith("https://cloudflare-dns.com/dns-query")) {
      return Promise.resolve(Response.json({ Answer: [{ type: 16, data: `"did=${DID}"` }] }));
    }
    if (url.startsWith(`https://plc.directory/${encodeURIComponent(DID)}`)) {
      return Promise.resolve(
        Response.json({
          id: DID,
          alsoKnownAs: ["at://ebey.dev"],
          service: [
            { id: "#atproto_pds", type: "AtprotoPersonalDataServer", serviceEndpoint: PDS },
          ],
        }),
      );
    }
    if (url.includes("collection=dev.atpm.alpha.stage")) {
      return options.staged === null
        ? Promise.resolve(Response.json({ error: "RecordNotFound" }, { status: 400 }))
        : Promise.resolve(Response.json(options.staged ?? stageRecord()));
    }
    if (url.includes("collection=dev.atpm.alpha.package")) {
      return options.published === null
        ? Promise.resolve(Response.json({ error: "RecordNotFound" }, { status: 400 }))
        : Promise.resolve(Response.json({ value: options.published ?? packageRecord(["0.0.15"]) }));
    }
    return Promise.resolve(new Response("not found", { status: 404 }));
  });
}

const env = {} as Cloudflare.Env;
const ctx = {} as ExecutionContext;

describe("staged version tokens", () => {
  test("round-trip, and carry the record revision", () => {
    const token = formatAtpmStagedVersion(RKEY, RECORD_CID);
    expect(isAtpmStagedVersion(token)).toBe(true);
    expect(parseAtpmStagedVersion(token)).toEqual({ rkey: RKEY, recordCid: RECORD_CID });
  });

  test("the no-baseline sentinel is not mistaken for a staged candidate", () => {
    expect(isAtpmStagedVersion(ATPM_NO_BASELINE_VERSION)).toBe(false);
    expect(parseAtpmStagedVersion(ATPM_NO_BASELINE_VERSION)).toBeNull();
  });

  test("reject malformed tokens", () => {
    for (const value of [
      "0.0.15",
      "staged.",
      "staged.NOTATID.bafyrei",
      `staged.${RKEY}`,
      `staged.${RKEY}.../../x`,
    ]) {
      expect(parseAtpmStagedVersion(value), value).toBeNull();
    }
  });

  test("read as something a person can understand in the version picker", () => {
    expect(diffRefLabel(formatAtpmStagedVersion(RKEY, RECORD_CID))).toBe("staged candidate");
    expect(diffRefLabel(ATPM_NO_BASELINE_VERSION)).toBe("no published release");
    expect(diffRefLabel("0.0.15")).toBe("0.0.15");
  });
});

describe("staged record content address", () => {
  test("re-derives the DAG-CBOR CID instead of trusting the PDS echo", async () => {
    const record = stageRecord();
    expect(await atpmRecordCid(record.value)).toBe(RECORD_CID);
    await expect(assertAtpmRecordCid(record.value, RECORD_CID)).resolves.toBeUndefined();

    await expect(
      assertAtpmRecordCid({ ...record.value, version: "9.9.9" }, RECORD_CID),
    ).rejects.toMatchObject({ status: 502 });
  });
});

describe("staged candidate findings", () => {
  function staged(overrides: Partial<AtpmStagedVersion> = {}): AtpmStagedVersion {
    return {
      rkey: RKEY,
      uri: `at://${DID}/dev.atpm.alpha.stage/${RKEY}`,
      recordCid: RECORD_CID,
      declaredName: "@ebey.dev/counter",
      version: "0.0.16",
      declaredManifestName: "@ebey.dev/counter",
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

  function metadataFindings(
    candidate: AtpmStagedVersion,
    verifiedHandle: string | null = "ebey.dev",
  ) {
    return atpmStagedFindings({
      staged: { ...candidate, shasum: candidate.declaredShasum },
      manifest: { name: candidate.declaredName, version: candidate.version } as any,
      archiveSha1: null,
      archiveSha512: null,
      trustPublisher: null,
      baseline: null,
      baselineArchiveSha512: null,
      verifiedHandle,
    });
  }

  test("checks the staged meta name that the published projection cannot carry", () => {
    const findings = metadataFindings(staged({ declaredManifestName: "@attacker.dev/counter" }));
    expect(findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ ruleId: "stage.metadata-mismatch", severity: "critical" }),
      ]),
    );
  });

  test("checks a candidate's scope against the currently verified publisher handle", () => {
    const findings = metadataFindings(
      staged({
        declaredName: "@attacker.dev/counter",
        declaredManifestName: "@attacker.dev/counter",
      }),
    );
    expect(findings[0]?.evidence).toContain("is not the publisher's handle @ebey.dev");
  });

  test("fails closed when a candidate's publisher has no verified handle", () => {
    const findings = metadataFindings(staged(), null);
    expect(findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          ruleId: "stage.metadata-mismatch",
          severity: "critical",
          evidence: expect.stringContaining("publisher has no handle"),
        }),
      ]),
    );
  });

  test("warns before approval would replace verified provenance", () => {
    const baselineArchiveSha512 = "ab".repeat(64);
    const baseline: AtpmVersion = {
      version: "0.0.15",
      cid: CID,
      size: 604,
      mimeType: "application/gzip",
      createdAt: "2026-08-12T06:28:24.000Z",
      declaredName: "@ebey.dev/counter",
      declaredVersion: "0.0.15",
      declaredShasum: null,
      declaredTarball: `${PDS}/xrpc/com.atproto.sync.getBlob?did=${DID}&cid=${CID}`,
      declaredIntegrity: null,
      provenance: {
        status: "verified",
        provenance: {
          sourceRepository: "https://github.com/ebey/counter",
          sourceRef: "refs/tags/v0.0.15",
          sourceCommit: "1".repeat(40),
          workflowPath: ".github/workflows/publish.yml",
          runInvocation: "https://github.com/ebey/counter/actions/runs/1/attempts/1",
          runnerEnvironment: "github-hosted",
          repositoryVisibility: "public",
          subjectName: atpmPurl("@ebey.dev/counter", "0.0.15"),
          subjectSha512: baselineArchiveSha512,
          logIndex: "1",
          signedAt: "2026-08-12T06:28:24.000Z",
        },
      },
    };

    const findings = atpmStagedFindings({
      staged: { ...staged(), shasum: null },
      manifest: { name: "@ebey.dev/counter", version: "0.0.16" } as any,
      archiveSha1: null,
      archiveSha512: null,
      trustPublisher: null,
      baseline,
      baselineArchiveSha512,
      verifiedHandle: "ebey.dev",
    });

    expect(findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          ruleId: "atpm.trusted-publishing-lost",
          severity: "medium",
          evidence: expect.stringContaining("previous version was built by"),
        }),
      ]),
    );
  });
});

describe("resolveAtpmStagedReview", () => {
  afterEach(() => vi.unstubAllGlobals());

  test("builds a review URL from just the account and the record key", async () => {
    // This is the whole contract with atpm's dashboard: it already has both
    // values, so linking requires no call back to Drydock.
    stubNetwork();
    const resolved = await resolveAtpmStagedReview(env, ctx, {
      publisher: "@ebey.dev",
      rkey: RKEY,
    });
    expect(resolved.reviewPath).toBe(
      `/diff/atpm/${DID}/counter/0.0.15/${formatAtpmStagedVersion(RKEY, RECORD_CID)}`,
    );
    expect(resolved.version).toBe("0.0.16");
    expect(resolved.baselineVersion).toBe("0.0.15");
    expect(resolved.displayName).toBe("@ebey.dev/counter");
  });

  test("accepts the DID form as readily as the handle", async () => {
    stubNetwork();
    const resolved = await resolveAtpmStagedReview(env, ctx, { publisher: DID, rkey: RKEY });
    expect(resolved.packageName).toBe(`${DID}/counter`);
  });

  test("reviews a first release against nothing rather than failing", async () => {
    stubNetwork({ published: null });
    const resolved = await resolveAtpmStagedReview(env, ctx, {
      publisher: "@ebey.dev",
      rkey: RKEY,
    });
    expect(resolved.baselineVersion).toBeNull();
    expect(resolved.reviewPath).toContain(`/${ATPM_NO_BASELINE_VERSION}/`);
  });

  test("reports an approved or withdrawn candidate as gone", async () => {
    // atpm deletes the staged record on approval, so this is the expected end
    // state of every one of these links rather than a broken one.
    stubNetwork({ staged: null });
    await expect(
      resolveAtpmStagedReview(env, ctx, { publisher: "@ebey.dev", rkey: RKEY }),
    ).rejects.toMatchObject({ status: 404 });
  });

  test("refuses a publisher that is not addressable", async () => {
    await expect(
      resolveAtpmStagedReview(env, ctx, { publisher: "@localhost", rkey: RKEY }),
    ).rejects.toMatchObject({ status: 400 });
  });
});

describe("selectBaselineVersion", () => {
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

  test("prefers what the candidate would displace", () => {
    expect(
      selectBaselineVersion(published(["0.0.14", "0.0.15"], { latest: "0.0.14" }), {
        version: "0.0.16",
        tag: "latest",
      }),
    ).toBe("0.0.14");
  });

  test("falls back to the immediate predecessor", () => {
    expect(
      selectBaselineVersion(published(["0.0.14", "0.0.15", "1.0.0"]), {
        version: "0.0.16",
        tag: "next",
      }),
    ).toBe("0.0.15");
  });

  test("has nothing to compare a first release against", () => {
    expect(selectBaselineVersion(published([]), { version: "0.0.1", tag: "latest" })).toBeNull();
  });
});
