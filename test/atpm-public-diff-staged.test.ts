import { afterEach, describe, expect, test, vi } from "vitest";
import {
  ATPM_NO_BASELINE_VERSION,
  formatAtpmStagedVersion,
} from "../server/lib/ecosystems/atpm/stage-ref";
import { atpmRecordCid } from "../server/lib/ecosystems/atpm/stage-record";

const sandboxMock = vi.hoisted(() => ({ downloadInSandbox: vi.fn() }));

vi.mock("cloudflare:workers", () => ({ WorkerEntrypoint: class {} }));
vi.mock("../server/lib/sandbox.ts", async () => ({
  ...(await vi.importActual("../server/lib/sandbox.ts")),
  downloadInSandbox: sandboxMock.downloadInSandbox,
}));

const { atpmPublicDiff } = await import("../server/lib/ecosystems/atpm/public-diff");

const DID = "did:plc:twegdcgytckr5cxm57gyruxa";
const PDS = "https://shiitake.us-east.host.bsky.network";
const CID = "bafkreibrz4xmz6sbraw6h2mtchh5xq7jqghrjhr3yyyub3wbyrvmyjg2bm";
const RKEY = "3lmabcdefghij";

async function stageRecord() {
  const value = {
    $type: "dev.atpm.alpha.stage",
    createdAt: "2026-08-13T06:28:24.000Z",
    name: "@ebey.dev/counter",
    version: "0.0.1",
    tags: { latest: "0.0.1" },
    blob: { $type: "blob", ref: { $link: CID }, size: 604, mimeType: "application/gzip" },
    meta: {
      name: "@ebey.dev/counter",
      version: "0.0.1",
      dist: { tarball: `${PDS}/xrpc/com.atproto.sync.getBlob?did=${DID}&cid=${CID}` },
    },
  };
  return {
    uri: `at://${DID}/dev.atpm.alpha.stage/${RKEY}`,
    cid: await atpmRecordCid(value),
    value,
  };
}

describe("atpm staged public diff", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    sandboxMock.downloadInSandbox.mockReset();
  });

  test("loads a first release without requiring a published package record", async () => {
    const staged = await stageRecord();
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
        return Promise.resolve(Response.json(staged));
      }
      if (
        url.includes("collection=dev.atpm.alpha.package") ||
        url.includes("collection=dev.atpm.alpha.trustPublisher")
      ) {
        return Promise.resolve(Response.json({ error: "RecordNotFound" }, { status: 400 }));
      }
      return Promise.resolve(new Response("not found", { status: 404 }));
    });
    sandboxMock.downloadInSandbox.mockResolvedValue({
      files: [
        {
          path: "package.json",
          size: 52,
          sha256: "manifest",
          flags: [],
          textSample: JSON.stringify({ name: "@ebey.dev/counter", version: "0.0.1" }),
        },
      ],
      packageJson: { name: "@ebey.dev/counter", version: "0.0.1" },
      suspiciousEntries: [],
      archiveSha1: null,
      archiveSha256: "31cf2eccfa41882de3e99311cfdbc3e9818f149e3bc63140eec1c46acc24da0b",
      archiveSha512: "11".repeat(64),
    });

    const sources = await atpmPublicDiff.acquire({} as Cloudflare.Env, {} as ExecutionContext, {
      ecosystem: "atpm",
      packageName: `${DID}/counter`,
      fromVersion: ATPM_NO_BASELINE_VERSION,
      toVersion: formatAtpmStagedVersion(RKEY, staged.cid),
      registryUrl: "at://",
    });

    expect(sources.from.files).toEqual([]);
    expect(sources.to.packageJson).toMatchObject({ version: "0.0.1" });
    expect(sources.notices).toEqual(
      expect.arrayContaining([expect.stringContaining("first release")]),
    );
    expect(sources.provenance).toEqual(
      expect.arrayContaining([
        {
          label: "Record",
          value: `at://${DID}/dev.atpm.alpha.stage/${RKEY}`,
        },
      ]),
    );
  });
});
