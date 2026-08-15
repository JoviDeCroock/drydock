import { afterEach, describe, expect, test, vi } from "vitest";
import { atpmRecordFindings } from "../server/lib/ecosystems/atpm/findings";
import {
  assertPublicHttpsUrl,
  isValidAtpmPackageName,
  normalizeAtpmPackageName,
  parseAtpmPackageName,
  resolveAtpmRepoIdentity,
} from "../server/lib/ecosystems/atpm/identity";
import {
  assertAtpmBlobDigest,
  atpmBlobUrl,
  isValidAtpmVersion,
  listAtpmVersions,
  parseAtpmPackageRecord,
  requireAtpmVersion,
  type AtpmPackage,
} from "../server/lib/ecosystems/atpm/record";
import { PublicDiffError } from "../server/lib/public-diff/error";

// Shapes taken from a live record: at://did:plc:twegdcgytckr5cxm57gyruxa
// /dev.atpm.alpha.package/counter, published by @ebey.dev.
const DID = "did:plc:twegdcgytckr5cxm57gyruxa";
const PDS = "https://shiitake.us-east.host.bsky.network";
const CID_A = "bafkreibrz4xmz6sbraw6h2mtchh5xq7jqghrjhr3yyyub3wbyrvmyjg2bm";
const CID_B = "bafkreigjbauo4x6rqpuxkksb2fmsldns47tlbb3lgvxqxypqc4wdes5gvu";

function versionEntry(version: string, cid: string, extra: Record<string, unknown> = {}) {
  return {
    $type: "dev.atpm.alpha.package#version",
    version,
    createdAt: "2026-08-13T06:28:24.000Z",
    blob: { $type: "blob", ref: { $link: cid }, size: 604, mimeType: "application/gzip" },
    meta: {
      name: "@ebey.dev/counter",
      version,
      // The real record carries the whole npm manifest here, including a readme
      // and a base64 Sigstore bundle. None of it survives parsing.
      readme: "x".repeat(4096),
      dist: {
        shasum: "53dde734249b5c8de540b4f86254273caa000ec5",
        tarball: `${PDS}/xrpc/com.atproto.sync.getBlob?did=${DID}&cid=${cid}`,
        attestations: { provenance: { dsseEnvelope: { payload: "y".repeat(4096) } } },
      },
      ...extra,
    },
  };
}

const RECORD = {
  $type: "dev.atpm.alpha.package",
  createdAt: "2026-01-01T00:00:00.000Z",
  tags: { latest: "0.0.15" },
  versions: [versionEntry("0.0.15", CID_A), versionEntry("0.0.14", CID_B)],
};

describe("parseAtpmPackageName", () => {
  test("reads the handle form and canonicalizes the handle", () => {
    expect(parseAtpmPackageName("@Ebey.Dev/counter")).toEqual({
      authority: { kind: "handle", handle: "ebey.dev" },
      name: "counter",
      packageName: "@ebey.dev/counter",
    });
  });

  test("reads the DID form for both atproto DID methods", () => {
    expect(parseAtpmPackageName(`${DID}/counter`)?.authority).toEqual({ kind: "did", did: DID });
    expect(parseAtpmPackageName("did:web:example.com/counter")?.authority).toEqual({
      kind: "did",
      did: "did:web:example.com",
    });
  });

  test("rejects names atpm cannot address", () => {
    for (const name of [
      "counter", // unscoped: every atpm package is published under an identity
      "@ebey.dev", // no record key
      "@ebey.dev/", // empty record key
      "@ebey.dev/a/b", // a record key is one segment
      "@localhost/counter", // a handle needs at least two labels
      "@ebey.dev/.hidden",
      "@ebey.dev/..",
      "@ebey.dev/Counter", // record keys here are lowercase npm names
      "did:key:z6Mk/counter", // not a DID method atproto resolves
      "did:web:localhost/counter",
      "did:web:127.0.0.1/counter",
      "did:web:example.com%3A8443/counter", // a port smuggled past did:web
      "did:plc:short/counter",
      "@1.2.3.4/counter", // an IP literal is not a handle
      // A handle is a domain we have to be willing to fetch, so the host policy
      // applies to it too — `alice.test` is atproto's dev-env handle and has no
      // public resolution path.
      "@alice.test/counter",
      "@pds.local/counter",
      "@publisher.alt/counter",
      "@publisher.arpa/counter",
      "@publisher.example/counter",
      "@publisher.invalid/counter",
      "@publisher.onion/counter",
      "",
    ]) {
      expect(parseAtpmPackageName(name), name).toBeNull();
      expect(isValidAtpmPackageName(name), name).toBe(false);
    }
  });

  test("normalization folds the authority but never the record key", () => {
    // Handles are case-insensitive; atproto record keys are not, so folding the
    // name would let two distinct records collide on one cache entry.
    expect(normalizeAtpmPackageName("@EBEY.DEV/counter")).toBe("@ebey.dev/counter");
    expect(normalizeAtpmPackageName(` @ebey.dev/counter `)).toBe("@ebey.dev/counter");
  });
});

describe("assertPublicHttpsUrl", () => {
  test("accepts an ordinary PDS endpoint", () => {
    expect(assertPublicHttpsUrl(PDS, "PDS endpoint").origin).toBe(PDS);
  });

  test("rejects every shape that points somewhere other than the public internet", () => {
    // A DID document names its own PDS, so this is the boundary between "fetch
    // a publisher's server" and "probe whatever the publisher names".
    for (const url of [
      "http://example.com",
      "https://127.0.0.1",
      "https://[::1]",
      "https://localhost",
      "https://pds.local",
      "https://pds.internal",
      "https://pds.alt",
      "https://pds.arpa",
      "https://pds.example",
      "https://pds.invalid",
      "https://pds.onion",
      "https://metadata", // single-label: resolves via a private search domain
      "https://example.com:9200", // port probing
      "https://user:pass@example.com",
      "ftp://example.com",
      "not a url",
    ]) {
      expect(() => assertPublicHttpsUrl(url, "PDS endpoint"), url).toThrow(PublicDiffError);
    }
  });
});

describe("parseAtpmPackageRecord", () => {
  test("keeps only the fields a diff and its integrity checks read", () => {
    const parsed = parseAtpmPackageRecord(RECORD);
    expect(parsed?.tags).toEqual({ latest: "0.0.15" });
    expect(parsed?.versions[0]).toEqual({
      version: "0.0.15",
      cid: CID_A,
      size: 604,
      mimeType: "application/gzip",
      createdAt: "2026-08-13T06:28:24.000Z",
      declaredName: "@ebey.dev/counter",
      declaredVersion: "0.0.15",
      declaredShasum: "53dde734249b5c8de540b4f86254273caa000ec5",
    });
    // The readme and the attestation bundle are the bulk of a real record and
    // are never read, so they must not reach the cache.
    expect(JSON.stringify(parsed)).not.toContain("xxxx");
    expect(JSON.stringify(parsed)).not.toContain("yyyy");
  });

  test("drops unusable version entries without hiding the rest of the package", () => {
    const parsed = parseAtpmPackageRecord({
      ...RECORD,
      versions: [
        ...RECORD.versions,
        { version: "0.0.13" }, // no blob: describes a release, does not contain one
        { version: "0.0.12", blob: { ref: { $link: "../../etc/passwd" } } },
        versionEntry("bad/version", CID_A),
        versionEntry(`1.${"0".repeat(128)}`, CID_A),
        { blob: { ref: { $link: CID_A } } }, // no version
        { ...versionEntry("0.0.11", CID_A), createdAt: undefined },
        { ...versionEntry("0.0.10", CID_A), meta: undefined },
        { ...versionEntry("0.0.9", CID_A), meta: "not a manifest" },
        { ...versionEntry("0.0.8", CID_A), meta: {} },
        {
          ...versionEntry("0.0.7", CID_A),
          blob: { ref: { $link: CID_A }, size: 604, mimeType: "application/gzip" },
        },
        {
          ...versionEntry("0.0.6", CID_A),
          blob: { $type: "blob", ref: { $link: CID_A }, size: -1, mimeType: "application/gzip" },
        },
        {
          ...versionEntry("0.0.5", CID_A),
          blob: { $type: "blob", ref: { $link: CID_A }, size: 604, mimeType: "" },
        },
        "nonsense",
      ],
    });
    expect(parsed?.versions.map((entry) => entry.version)).toEqual(["0.0.15", "0.0.14"]);
  });

  test("rejects values that are not an atpm package record", () => {
    expect(parseAtpmPackageRecord(null)).toBeNull();
    expect(parseAtpmPackageRecord([])).toBeNull();
    expect(parseAtpmPackageRecord({ ...RECORD, $type: undefined })).toBeNull();
    expect(parseAtpmPackageRecord({ $type: "app.bsky.feed.post", versions: [] })).toBeNull();
    expect(parseAtpmPackageRecord({ $type: "dev.atpm.alpha.package" })).toBeNull();
    expect(parseAtpmPackageRecord({ ...RECORD, createdAt: undefined })).toBeNull();
    expect(parseAtpmPackageRecord({ ...RECORD, createdAt: "not-a-datetime" })).toBeNull();
    expect(parseAtpmPackageRecord({ ...RECORD, tags: undefined })).toBeNull();
    expect(parseAtpmPackageRecord({ ...RECORD, tags: [] })).toBeNull();
  });

  test("rejects duplicate readable versions rather than choosing one blob", () => {
    expect(
      parseAtpmPackageRecord({
        ...RECORD,
        versions: [versionEntry("1.0.0", CID_A), versionEntry("1.0.0", CID_B)],
      }),
    ).toBeNull();
  });
});

describe("isValidAtpmVersion", () => {
  test("accepts registry version strings and rejects path/control shapes", () => {
    expect(isValidAtpmVersion("3.0.0-rc.1+build.4")).toBe(true);
    expect(isValidAtpmVersion("bad/version")).toBe(false);
    expect(isValidAtpmVersion("line\nbreak")).toBe(false);
    expect(isValidAtpmVersion(`1.${"0".repeat(128)}`)).toBe(false);
  });
});

describe("listAtpmVersions", () => {
  const pkg = parseAtpmPackageRecord({
    ...RECORD,
    tags: { latest: "2.0.0", next: "3.0.0-rc.1" },
    versions: [
      // Deliberately out of order, with a backport published after the major
      // bump — the publisher writes this array, so it cannot drive the picker.
      versionEntry("1.9.1", CID_A),
      versionEntry("3.0.0-rc.1", CID_B),
      versionEntry("2.0.0", CID_A),
      versionEntry("1.9.0", CID_B),
    ],
  }) as AtpmPackage;

  test("orders newest-first by semver", () => {
    expect(listAtpmVersions(pkg).versions.map((entry) => entry.version)).toEqual([
      "3.0.0-rc.1",
      "2.0.0",
      "1.9.1",
      "1.9.0",
    ]);
  });

  test("surfaces dist-tags and suggests latest against its semver predecessor", () => {
    const listed = listAtpmVersions(pkg);
    expect(listed.versions.find((entry) => entry.version === "2.0.0")?.distTags).toEqual([
      "latest",
    ]);
    expect(listed.versions.find((entry) => entry.version === "3.0.0-rc.1")?.distTags).toEqual([
      "next",
    ]);
    // Not 3.0.0-rc.1: `latest` is what an unqualified install resolves to.
    expect(listed.suggested).toEqual({ from: "1.9.1", to: "2.0.0" });
  });

  test("a single-version package has no pair to suggest", () => {
    const single = parseAtpmPackageRecord({
      ...RECORD,
      tags: { latest: "1.0.0" },
      versions: [versionEntry("1.0.0", CID_A)],
    }) as AtpmPackage;
    expect(listAtpmVersions(single).suggested).toBeNull();
  });

  test("ignores a latest tag that does not name an available release", () => {
    const staleLatest = parseAtpmPackageRecord({
      ...RECORD,
      tags: { latest: "9.9.9" },
      versions: [versionEntry("2.0.0", CID_A), versionEntry("1.9.1", CID_B)],
    }) as AtpmPackage;

    expect(listAtpmVersions(staleLatest).suggested).toEqual({ from: "1.9.1", to: "2.0.0" });
  });
});

describe("requireAtpmVersion", () => {
  test("404s an unknown version the way a registry would", () => {
    const pkg = parseAtpmPackageRecord(RECORD) as AtpmPackage;
    expect(requireAtpmVersion(pkg, "0.0.14").cid).toBe(CID_B);
    expect(() => requireAtpmVersion(pkg, "9.9.9")).toThrow(PublicDiffError);
  });
});

describe("atpmBlobUrl", () => {
  const identity = { did: DID, pds: PDS, handle: "ebey.dev", handleMethod: "dns" as const };

  test("builds the blob URL from the resolved PDS and the content address", () => {
    // Never from the record's own `meta.dist.tarball`: that is a
    // publisher-written string, and following it would let a record name any
    // host as the source of the bytes presented as this package's release.
    expect(atpmBlobUrl(identity, CID_A)).toBe(
      `${PDS}/xrpc/com.atproto.sync.getBlob?did=did%3Aplc%3Atwegdcgytckr5cxm57gyruxa&cid=${CID_A}`,
    );
  });

  test("rejects a CID that is not a canonical base32 CIDv1", () => {
    for (const cid of ["../../etc/passwd", "QmLegacyBase58", "bafkrei!!", ""]) {
      expect(() => atpmBlobUrl(identity, cid), cid).toThrow(PublicDiffError);
    }
  });
});

describe("assertAtpmBlobDigest", () => {
  test("accepts only bytes whose SHA-256 matches the blob CID", () => {
    expect(() =>
      assertAtpmBlobDigest(
        CID_A,
        "31cf2eccfa41882de3e99311cfdbc3e9818f149e3bc63140eec1c46acc24da0b",
      ),
    ).not.toThrow();
    expect(() => assertAtpmBlobDigest(CID_A, "0".repeat(64))).toThrow(PublicDiffError);
    expect(() => assertAtpmBlobDigest(CID_A, null)).toThrow(PublicDiffError);
  });
});

describe("atpmRecordFindings", () => {
  const entry = {
    version: "1.0.0",
    cid: CID_A,
    size: 604,
    mimeType: "application/gzip",
    createdAt: "2026-08-13T06:28:24.000Z",
    declaredName: "@ebey.dev/counter",
    declaredVersion: "1.0.0",
    declaredShasum: "53dde734249b5c8de540b4f86254273caa000ec5",
  };
  const manifest = { name: "@ebey.dev/counter", version: "1.0.0" };

  test("a record that agrees with its tarball produces nothing", () => {
    expect(
      atpmRecordFindings({
        entry,
        manifest,
        archiveSha1: "53dde734249b5c8de540b4f86254273caa000ec5",
        recordName: "counter",
      }),
    ).toEqual([]);
  });

  test("flags a tarball that does not hash to the digest the record declares", () => {
    const findings = atpmRecordFindings({
      entry,
      manifest,
      archiveSha1: "f".repeat(40),
      recordName: "counter",
    });
    expect(findings).toHaveLength(1);
    expect(findings[0].ruleId).toBe("stage.tarball-digest-mismatch");
    expect(findings[0].severity).toBe("critical");
  });

  test("stays silent when a digest is missing on either side", () => {
    // Absence of evidence, not a mismatch: accusing a publisher of shipping
    // different bytes must rest on two digests that both exist.
    expect(
      atpmRecordFindings({
        entry: { ...entry, declaredShasum: null },
        manifest,
        archiveSha1: "f".repeat(40),
        recordName: "counter",
      }),
    ).toEqual([]);
    expect(
      atpmRecordFindings({
        entry,
        manifest,
        archiveSha1: null,
        recordName: "counter",
      }),
    ).toEqual([]);
  });

  test("flags a record whose metadata does not match the tarball's manifest", () => {
    const findings = atpmRecordFindings({
      entry: { ...entry, declaredName: "@ebey.dev/counter", declaredVersion: "1.0.0" },
      manifest: { name: "left-pad", version: "9.9.9" },
      archiveSha1: null,
      recordName: "counter",
    });
    expect(findings).toHaveLength(1);
    expect(findings[0].ruleId).toBe("stage.metadata-mismatch");
    expect(findings[0].evidence).toContain("left-pad");
    expect(findings[0].evidence).toContain("9.9.9");
  });

  test("binds package names to the stable record key", () => {
    expect(
      atpmRecordFindings({
        entry,
        manifest,
        archiveSha1: null,
        recordName: "counter",
      }),
    ).toEqual([]);
    expect(
      atpmRecordFindings({
        entry,
        manifest: { name: "@someone.else/other", version: "1.0.0" },
        archiveSha1: null,
        recordName: "counter",
      }),
    ).toHaveLength(1);
  });

  test("does not compare historical release names with the publisher's current handle", () => {
    const historicalName = "@old-handle.example/counter";
    expect(
      atpmRecordFindings({
        entry: { ...entry, declaredName: historicalName },
        manifest: { name: historicalName, version: "1.0.0" },
        archiveSha1: null,
        recordName: "counter",
      }),
    ).toEqual([]);
  });

  test("binds both metadata names to the record key", () => {
    const wrongName = "@ebey.dev/not-counter";
    const findings = atpmRecordFindings({
      entry: { ...entry, declaredName: wrongName },
      manifest: { name: wrongName, version: "1.0.0" },
      archiveSha1: null,
      recordName: "counter",
    });

    expect(findings).toHaveLength(1);
    expect(findings[0].evidence).toContain("record meta.name @ebey.dev/not-counter");
    expect(findings[0].evidence).toContain("package.json name @ebey.dev/not-counter");
  });
});

describe("resolveAtpmRepoIdentity", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const didDocument = {
    id: DID,
    alsoKnownAs: ["at://ebey.dev"],
    service: [
      { id: "#atproto_pds", type: "AtprotoPersonalDataServer", serviceEndpoint: PDS },
      // A second service that is not the repository must be ignored.
      { id: "#bsky_notif", type: "BskyNotificationService", serviceEndpoint: "https://notif.test" },
    ],
  };

  function stubFetch(routes: Record<string, () => Response>) {
    const calls: string[] = [];
    vi.stubGlobal("fetch", (input: RequestInfo | URL) => {
      const url = String(input);
      calls.push(url);
      for (const [prefix, respond] of Object.entries(routes)) {
        if (url.startsWith(prefix)) return Promise.resolve(respond());
      }
      return Promise.resolve(new Response("not found", { status: 404 }));
    });
    return calls;
  }

  const dnsAnswer = () => Response.json({ Answer: [{ type: 16, data: `"did=${DID}"` }] });
  const plcAnswer = () => Response.json(didDocument);

  test("resolves a handle through DNS and reports which mechanism proved it", async () => {
    const calls = stubFetch({
      "https://cloudflare-dns.com/dns-query": dnsAnswer,
      "https://plc.directory/": plcAnswer,
    });
    await expect(
      resolveAtpmRepoIdentity(parseAtpmPackageName("@ebey.dev/counter")!),
    ).resolves.toEqual({ did: DID, pds: PDS, handle: "ebey.dev", handleMethod: "dns" });
    // The well-known fallback is not consulted once DNS answers.
    expect(calls.some((url) => url.includes("/.well-known/atproto-did"))).toBe(false);
  });

  test("falls back to the well-known endpoint when DNS has no claim", async () => {
    stubFetch({
      "https://cloudflare-dns.com/dns-query": () => Response.json({ Answer: [] }),
      "https://ebey.dev/.well-known/atproto-did": () => new Response(`${DID}\n`),
      "https://plc.directory/": plcAnswer,
    });
    await expect(
      resolveAtpmRepoIdentity(parseAtpmPackageName("@ebey.dev/counter")!),
    ).resolves.toMatchObject({ did: DID, handleMethod: "well-known" });
  });

  test("refuses a handle the DID document does not claim back", async () => {
    // Without this check any domain could point _atproto at someone else's DID
    // and serve their packages under its own name.
    stubFetch({
      "https://cloudflare-dns.com/dns-query": dnsAnswer,
      "https://plc.directory/": () =>
        Response.json({ ...didDocument, alsoKnownAs: ["at://someone.else"] }),
    });
    await expect(
      resolveAtpmRepoIdentity(parseAtpmPackageName("@ebey.dev/counter")!),
    ).rejects.toThrow(/does not verify/);
  });

  test("refuses a requested handle that appears only as a secondary alias", async () => {
    stubFetch({
      "https://cloudflare-dns.com/dns-query": dnsAnswer,
      "https://plc.directory/": () =>
        Response.json({
          ...didDocument,
          alsoKnownAs: ["at://primary.dev", "at://ebey.dev"],
        }),
    });
    await expect(
      resolveAtpmRepoIdentity(parseAtpmPackageName("@ebey.dev/counter")!),
    ).rejects.toThrow(/does not verify/);
  });

  test("refuses a DID document that describes a different subject", async () => {
    stubFetch({
      "https://cloudflare-dns.com/dns-query": dnsAnswer,
      "https://plc.directory/": () =>
        Response.json({ ...didDocument, id: "did:plc:aaaaaaaaaaaaaaaaaaaaaaaa" }),
    });
    await expect(
      resolveAtpmRepoIdentity(parseAtpmPackageName("@ebey.dev/counter")!),
    ).rejects.toThrow(/different DID/);
  });

  test("refuses a PDS endpoint that does not name a public host", async () => {
    stubFetch({
      "https://cloudflare-dns.com/dns-query": dnsAnswer,
      "https://plc.directory/": () =>
        Response.json({
          ...didDocument,
          service: [
            {
              id: "#atproto_pds",
              type: "AtprotoPersonalDataServer",
              serviceEndpoint: "http://169.254.169.254",
            },
          ],
        }),
    });
    await expect(
      resolveAtpmRepoIdentity(parseAtpmPackageName("@ebey.dev/counter")!),
    ).rejects.toThrow(PublicDiffError);
  });

  test("refuses PDS service endpoints with URL components beyond the origin", async () => {
    for (const serviceEndpoint of [
      `${PDS}/tenant`,
      `${PDS}?tenant=one`,
      `${PDS}#tenant`,
      `${PDS}?`,
      `${PDS}#`,
    ]) {
      stubFetch({
        "https://cloudflare-dns.com/dns-query": dnsAnswer,
        "https://plc.directory/": () =>
          Response.json({
            ...didDocument,
            service: [
              {
                id: "#atproto_pds",
                type: "AtprotoPersonalDataServer",
                serviceEndpoint,
              },
            ],
          }),
      });
      await expect(
        resolveAtpmRepoIdentity(parseAtpmPackageName("@ebey.dev/counter")!),
        serviceEndpoint,
      ).rejects.toThrow(/must be an origin/);
    }
  });

  test("accepts a fully qualified atproto PDS service id", async () => {
    stubFetch({
      "https://cloudflare-dns.com/dns-query": dnsAnswer,
      "https://plc.directory/": () =>
        Response.json({
          ...didDocument,
          service: [
            {
              id: `${DID}#atproto_pds`,
              type: "AtprotoPersonalDataServer",
              serviceEndpoint: PDS,
            },
          ],
        }),
    });
    await expect(
      resolveAtpmRepoIdentity(parseAtpmPackageName("@ebey.dev/counter")!),
    ).resolves.toMatchObject({ pds: PDS });
  });

  test("ignores a service id that merely ends with the PDS fragment", async () => {
    stubFetch({
      "https://cloudflare-dns.com/dns-query": dnsAnswer,
      "https://plc.directory/": () =>
        Response.json({
          ...didDocument,
          service: [
            {
              id: "https://attacker.example#atproto_pds",
              type: "AtprotoPersonalDataServer",
              serviceEndpoint: PDS,
            },
          ],
        }),
    });
    await expect(
      resolveAtpmRepoIdentity(parseAtpmPackageName("@ebey.dev/counter")!),
    ).rejects.toThrow(/declares no atproto PDS/);
  });

  test("refuses a redirect from a public resolver to a private target", async () => {
    const calls = stubFetch({
      "https://cloudflare-dns.com/dns-query": dnsAnswer,
      "https://plc.directory/": () =>
        new Response(null, {
          status: 302,
          headers: { location: "http://169.254.169.254/latest" },
        }),
    });

    await expect(
      resolveAtpmRepoIdentity(parseAtpmPackageName("@ebey.dev/counter")!),
    ).rejects.toThrow(PublicDiffError);
    expect(calls).not.toContain("http://169.254.169.254/latest");
  });

  test("a DID-addressed lookup proves the document's claimed handle in reverse", async () => {
    // The canonical form is DID-addressed, so without this the page would have
    // no handle to show. `alsoKnownAs` is written by the DID's own controller,
    // so it is resolved back and kept only when it returns this same DID.
    stubFetch({
      "https://plc.directory/": plcAnswer,
      "https://cloudflare-dns.com/dns-query": dnsAnswer,
    });
    await expect(resolveAtpmRepoIdentity(parseAtpmPackageName(`${DID}/counter`)!)).resolves.toEqual(
      { did: DID, pds: PDS, handle: "ebey.dev", handleMethod: "dns" },
    );
  });

  test("drops a claimed handle that resolves to somebody else", async () => {
    // A repository claiming a handle it does not control must not borrow that
    // name on the page; the DID stands on its own instead.
    stubFetch({
      "https://plc.directory/": plcAnswer,
      "https://cloudflare-dns.com/dns-query": () =>
        Response.json({ Answer: [{ type: 16, data: '"did=did:plc:aaaaaaaaaaaaaaaaaaaaaaaa"' }] }),
    });
    await expect(
      resolveAtpmRepoIdentity(parseAtpmPackageName(`${DID}/counter`)!),
    ).resolves.toMatchObject({ did: DID, handle: null, handleMethod: null });
  });

  test("falls back to the DID when the document claims no handle at all", async () => {
    stubFetch({
      "https://plc.directory/": () => Response.json({ ...didDocument, alsoKnownAs: [] }),
    });
    await expect(
      resolveAtpmRepoIdentity(parseAtpmPackageName(`${DID}/counter`)!),
    ).resolves.toMatchObject({ did: DID, handle: null });
  });

  test("checks only the first claimed handle, so a long alsoKnownAs is not a fan-out", async () => {
    const calls = stubFetch({
      "https://plc.directory/": () =>
        Response.json({
          ...didDocument,
          alsoKnownAs: ["at://a.example", "at://b.example", "at://c.example"],
        }),
      "https://cloudflare-dns.com/dns-query": () => Response.json({ Answer: [] }),
      "https://a.example/.well-known/atproto-did": () => new Response("did:plc:nope"),
    });
    await expect(
      resolveAtpmRepoIdentity(parseAtpmPackageName(`${DID}/counter`)!),
    ).resolves.toMatchObject({ handle: null });
    expect(calls.filter((url) => url.includes("b.example") || url.includes("c.example"))).toEqual(
      [],
    );
  });

  test("treats two conflicting DNS claims as no claim at all", async () => {
    stubFetch({
      "https://cloudflare-dns.com/dns-query": () =>
        Response.json({
          Answer: [
            { type: 16, data: `"did=${DID}"` },
            { type: 16, data: '"did=did:plc:aaaaaaaaaaaaaaaaaaaaaaaa"' },
          ],
        }),
      "https://plc.directory/": plcAnswer,
    });
    // No well-known record either, so the whole resolution fails rather than
    // guessing which account owns the handle.
    await expect(
      resolveAtpmRepoIdentity(parseAtpmPackageName("@ebey.dev/counter")!),
    ).rejects.toThrow(/does not resolve/);
  });

  test("resolves did:web through the domain's own web server", async () => {
    stubFetch({
      "https://example.com/.well-known/did.json": () =>
        Response.json({ ...didDocument, id: "did:web:example.com" }),
    });
    await expect(
      resolveAtpmRepoIdentity(parseAtpmPackageName("did:web:example.com/counter")!),
    ).resolves.toMatchObject({ did: "did:web:example.com", pds: PDS });
  });
});
