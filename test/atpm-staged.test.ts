import { afterEach, describe, expect, test, vi } from "vitest";
import { atpmStagedFindings } from "../server/lib/ecosystems/atpm/findings";
import type { AtpmRepoIdentity } from "../server/lib/ecosystems/atpm/identity";
import {
  fetchAtpmStagedVersion,
  isValidAtpmStageRkey,
  listAtpmStagedVersions,
  parseStageRecord,
  type AtpmStagedVersion,
} from "../server/lib/ecosystems/atpm/stage-record";
import {
  formatAtpmStageId,
  isAtpmStageId,
  parseAtpmStageId,
} from "../server/lib/ecosystems/atpm/stage-ref";
import { UUID_NAMESPACE_URL, uuidV5 } from "../server/lib/platform/uuid";
import { PublicDiffError } from "../server/lib/public-diff/error";

const DID = "did:plc:twegdcgytckr5cxm57gyruxa";
const PDS = "https://shiitake.us-east.host.bsky.network";
const CID = "bafkreibrz4xmz6sbraw6h2mtchh5xq7jqghrjhr3yyyub3wbyrvmyjg2bm";
const RKEY = "3lmabcdefghij";
const RECORD_CID = "bafyreih5wqzfvyjyw2djzp2zaqf2wmn3tjq4vg6nxbwjqz6c5xkxq6snqi";

const identity: AtpmRepoIdentity = {
  did: DID,
  pds: PDS,
  handle: "ebey.dev",
  handleMethod: "dns",
};

function stageRecord(overrides: Record<string, unknown> = {}, rkey = RKEY) {
  return {
    uri: `at://${DID}/dev.atpm.alpha.stage/${rkey}`,
    cid: RECORD_CID,
    value: {
      $type: "dev.atpm.alpha.stage",
      createdAt: "2026-08-13T06:28:24.000Z",
      name: "@ebey.dev/counter",
      version: "0.0.16",
      tags: { latest: "0.0.16" },
      blob: { $type: "blob", ref: { $link: CID }, size: 604, mimeType: "application/gzip" },
      meta: {
        name: "@ebey.dev/counter",
        version: "0.0.16",
        dist: {
          shasum: "53dde734249b5c8de540b4f86254273caa000ec5",
          tarball: `${PDS}/xrpc/com.atproto.sync.getBlob?did=${DID}&cid=${CID}`,
        },
      },
      ...overrides,
    },
  };
}

function stubFetch(handler: (url: string) => Response) {
  const calls: string[] = [];
  vi.stubGlobal("fetch", (input: RequestInfo | URL) => {
    const url = String(input);
    calls.push(url);
    return Promise.resolve(handler(url));
  });
  return calls;
}

describe("uuidV5", () => {
  // Cross-checked against Python's uuid.uuid5, which is an independent
  // implementation of the same RFC: the value has to match atpm's byte for
  // byte or the id Drydock shows would not approve the release it reviewed.
  test("matches an independent implementation in the URL namespace", async () => {
    expect(await uuidV5("https://example.com", UUID_NAMESPACE_URL)).toBe(
      "4fd35a71-71ef-5a55-a9d9-aa75c889a6d0",
    );
    expect(
      await uuidV5(`at://${DID}/dev.atpm.alpha.stage/${RKEY}/${RECORD_CID}`, UUID_NAMESPACE_URL),
    ).toBe("e852a96a-83f5-5c21-97c4-dce5b2f116ad");
  });

  test("rejects a namespace that is not a UUID", async () => {
    await expect(uuidV5("x", "not-a-uuid")).rejects.toThrow(/invalid UUID/);
  });
});

describe("atpm stage references", () => {
  test("round-trips the canonical spelling", () => {
    const stageId = formatAtpmStageId(DID, RKEY);
    expect(stageId).toBe(`atpm:${DID}:${RKEY}`);
    expect(isAtpmStageId(stageId)).toBe(true);
    expect(parseAtpmStageId(stageId)).toEqual({ did: DID, rkey: RKEY, approveId: null, stageId });
  });

  test("round-trips an approval-bound discovery reference", () => {
    const approveId = "e852a96a-83f5-5c21-97c4-dce5b2f116ad";
    const stageId = formatAtpmStageId(DID, RKEY, approveId.toUpperCase());
    expect(stageId).toBe(`atpm:${DID}:${RKEY}:${approveId}`);
    expect(parseAtpmStageId(stageId)).toEqual({ did: DID, rkey: RKEY, approveId, stageId });
  });

  test("accepts the did:web form", () => {
    expect(parseAtpmStageId(`atpm:did:web:example.com:${RKEY}`)?.did).toBe("did:web:example.com");
  });

  test("rejects references that are not addressable", () => {
    for (const value of [
      "",
      "some-npm-stage-id",
      `atpm:${DID}`,
      `atpm:${DID}:NOT-A-TID`,
      // A DID method with no atproto resolution path.
      `atpm:did:key:z6Mk:${RKEY}`,
      // Hosts this deployment will not talk to, rejected at the same gate the
      // public surface uses rather than three hops later.
      `atpm:did:web:localhost:${RKEY}`,
      `atpm:did:web:127.0.0.1:${RKEY}`,
    ]) {
      expect(parseAtpmStageId(value), value).toBeNull();
    }
  });

  test("record keys must be TIDs", () => {
    expect(isValidAtpmStageRkey(RKEY)).toBe(true);
    expect(isValidAtpmStageRkey("3lmabcdefghi")).toBe(false);
    expect(isValidAtpmStageRkey("../../etc/passwd")).toBe(false);
  });
});

describe("parseStageRecord", () => {
  test("reduces a candidate and derives the id that approves it", async () => {
    const parsed = await parseStageRecord(identity, stageRecord());
    expect(parsed).toMatchObject({
      rkey: RKEY,
      declaredName: "@ebey.dev/counter",
      declaredManifestName: "@ebey.dev/counter",
      version: "0.0.16",
      declaredVersion: "0.0.16",
      tag: "latest",
      cid: CID,
      declaredShasum: "53dde734249b5c8de540b4f86254273caa000ec5",
      provenance: { status: "absent" },
    });
    expect(parsed?.stageId).toBe("e852a96a-83f5-5c21-97c4-dce5b2f116ad");
  });

  test("refuses an entry attributed to another repository", async () => {
    const record = stageRecord();
    record.uri = "at://did:plc:someoneelse00000000000000/dev.atpm.alpha.stage/3lmabcdefghij";
    expect(await parseStageRecord(identity, record)).toBeNull();
  });

  test("refuses an entry from another collection", async () => {
    const record = stageRecord();
    record.uri = `at://${DID}/app.bsky.feed.post/${RKEY}`;
    expect(await parseStageRecord(identity, record)).toBeNull();
  });

  test("drops candidates that do not contain a reviewable release", async () => {
    const cases: Array<Record<string, unknown>> = [
      { blob: undefined },
      { blob: { $type: "blob", ref: { $link: "../../etc/passwd" }, size: 1, mimeType: "x" } },
      { blob: { $type: "blob", ref: { $link: CID }, size: -1, mimeType: "x" } },
      { meta: undefined },
      { meta: { version: "0.0.16", dist: {} } },
      { meta: { name: "@ebey.dev/counter", dist: {} } },
      { name: undefined },
      { version: "bad/version" },
      { createdAt: "yesterday" },
      { $type: "app.bsky.feed.post" },
      // A malformed digest claim must not collapse into the same state as an
      // absent one, which would silence the mismatch finding.
      { meta: { name: "x", version: "1", dist: { shasum: "nope" } } },
    ];
    for (const overrides of cases) {
      expect(
        await parseStageRecord(identity, stageRecord(overrides)),
        JSON.stringify(overrides),
      ).toBeNull();
    }
  });
});

describe("listAtpmStagedVersions", () => {
  afterEach(() => vi.unstubAllGlobals());

  test("reads a repository's pending candidates, newest first", async () => {
    stubFetch(() =>
      Response.json({
        records: [stageRecord({}, "3lmaaaaaaaaaa"), stageRecord({}, "3lmzzzzzzzzzz")],
      }),
    );
    const staged = await listAtpmStagedVersions(identity);
    expect(staged.map((entry) => entry.rkey)).toEqual(["3lmzzzzzzzzzz", "3lmaaaaaaaaaa"]);
  });

  test("skips a malformed candidate without hiding the rest", async () => {
    stubFetch(() => Response.json({ records: [{ uri: "nope" }, stageRecord()] }));
    const staged = await listAtpmStagedVersions(identity);
    expect(staged.map((entry) => entry.rkey)).toEqual([RKEY]);
  });

  test("stops paginating rather than crawling a repository unbounded", async () => {
    const calls = stubFetch(() =>
      Response.json({ records: [stageRecord()], cursor: "always-more" }),
    );
    await listAtpmStagedVersions(identity);
    expect(calls.length).toBe(5);
  });

  test("treats an empty collection as no candidates", async () => {
    stubFetch(() => Response.json({ error: "RecordNotFound" }, { status: 400 }));
    expect(await listAtpmStagedVersions(identity)).toEqual([]);
  });

  test("fails closed when the repository cannot be read", async () => {
    stubFetch(() => new Response("nope", { status: 500 }));
    await expect(listAtpmStagedVersions(identity)).rejects.toThrow(PublicDiffError);
  });

  test("rejects a PDS page larger than the requested record limit", async () => {
    stubFetch(() => Response.json({ records: Array.from({ length: 101 }, () => stageRecord()) }));
    await expect(listAtpmStagedVersions(identity)).rejects.toMatchObject({ status: 502 });
  });

  test("verifies provenance only for the newest 64 staged records", async () => {
    const alphabet = "234567abcdefghijklmnopqrstuvwxyz";
    const tid = (index: number) => {
      let encoded = "";
      let value = index;
      for (let i = 0; i < 10; i++) {
        encoded = alphabet[value % alphabet.length] + encoded;
        value = Math.floor(value / alphabet.length);
      }
      return `3lm${encoded}`;
    };
    const records = Array.from({ length: 65 }, (_, index) => {
      const record = stageRecord({}, tid(index));
      (record.value.meta.dist as Record<string, unknown>).attestations = {
        provenance: { mediaType: "invalid" },
      };
      return record;
    });
    stubFetch(() => Response.json({ records }));

    const staged = await listAtpmStagedVersions(identity);
    expect(staged.filter((candidate) => candidate.provenance.status === "invalid")).toHaveLength(
      64,
    );
    expect(
      staged.filter((candidate) => candidate.provenance.status === "not-evaluated"),
    ).toHaveLength(1);
  });
});

describe("fetchAtpmStagedVersion", () => {
  afterEach(() => vi.unstubAllGlobals());

  test("reads one candidate by record key", async () => {
    stubFetch(() => Response.json(stageRecord()));
    expect((await fetchAtpmStagedVersion(identity, RKEY)).version).toBe("0.0.16");
  });

  test("rejects a response for a different staged record key", async () => {
    stubFetch(() => Response.json(stageRecord({}, "3lmzzzzzzzzzz")));
    await expect(fetchAtpmStagedVersion(identity, RKEY)).rejects.toMatchObject({ status: 502 });
  });

  test("reports an approved or withdrawn candidate as gone", async () => {
    stubFetch(() => Response.json({ error: "RecordNotFound" }, { status: 400 }));
    await expect(fetchAtpmStagedVersion(identity, RKEY)).rejects.toMatchObject({ status: 404 });
  });

  test("rejects a record key that is not a TID before making a request", async () => {
    const calls = stubFetch(() => Response.json({}));
    await expect(fetchAtpmStagedVersion(identity, "../../x")).rejects.toMatchObject({
      status: 400,
    });
    expect(calls).toEqual([]);
  });
});

describe("atpmStagedFindings", () => {
  function staged(overrides: Partial<AtpmStagedVersion> = {}) {
    return {
      declaredName: "@ebey.dev/counter",
      declaredManifestName: "@ebey.dev/counter",
      version: "0.0.16",
      declaredVersion: "0.0.16",
      provenance: { status: "absent" } as const,
      shasum: "53dde734249b5c8de540b4f86254273caa000ec5",
      ...overrides,
    };
  }
  const manifest = { name: "@ebey.dev/counter", version: "0.0.16" } as never;

  test("a candidate that agrees with its tarball produces nothing", () => {
    expect(
      atpmStagedFindings({
        staged: staged(),
        manifest,
        archiveSha1: "53dde734249b5c8de540b4f86254273caa000ec5",
        archiveSha512: null,
        trustPublisher: null,
        verifiedHandle: "ebey.dev",
      }),
    ).toEqual([]);
  });

  test("flags a candidate whose tarball is not the one it declares", () => {
    const findings = atpmStagedFindings({
      staged: staged(),
      manifest,
      archiveSha1: "f".repeat(40),
      archiveSha512: null,
      trustPublisher: null,
      verifiedHandle: "ebey.dev",
    });
    expect(findings.map((f) => f.ruleId)).toEqual(["stage.tarball-digest-mismatch"]);
  });

  test("flags a candidate staged under someone else's scope", () => {
    // atpm's own stage endpoint rejects this, so a candidate carrying it could
    // not have been staged through atpm at all.
    const findings = atpmStagedFindings({
      staged: staged({
        declaredName: "@someone.else/counter",
        declaredManifestName: "@someone.else/counter",
      }),
      manifest: { name: "@someone.else/counter", version: "0.0.16" } as never,
      archiveSha1: null,
      archiveSha512: null,
      trustPublisher: null,
      verifiedHandle: "ebey.dev",
    });
    expect(findings[0].ruleId).toBe("stage.metadata-mismatch");
    expect(findings[0].evidence).toContain("is not the publisher's handle @ebey.dev");
  });

  test("does not invent a scope disagreement when no handle was proven", () => {
    expect(
      atpmStagedFindings({
        staged: staged({
          declaredName: "@someone.else/counter",
          declaredManifestName: "@someone.else/counter",
        }),
        manifest: { name: "@someone.else/counter", version: "0.0.16" } as never,
        archiveSha1: null,
        archiveSha512: null,
        trustPublisher: null,
        verifiedHandle: null,
      }),
    ).toEqual([]);
  });

  test("flags a candidate whose manifest disagrees with the record", () => {
    const findings = atpmStagedFindings({
      staged: staged({ declaredVersion: "9.9.9" }),
      manifest,
      archiveSha1: null,
      archiveSha512: null,
      trustPublisher: null,
      verifiedHandle: "ebey.dev",
    });
    expect(findings[0].evidence).toContain("staged meta.version 9.9.9");
  });

  test("flags an embedded manifest name that disagrees with the tarball", () => {
    const findings = atpmStagedFindings({
      staged: staged({ declaredManifestName: "@ebey.dev/copied" }),
      manifest,
      archiveSha1: null,
      archiveSha512: null,
      trustPublisher: null,
      verifiedHandle: "ebey.dev",
    });
    expect(findings[0].evidence).toContain("staged meta.name @ebey.dev/copied");
  });
});
