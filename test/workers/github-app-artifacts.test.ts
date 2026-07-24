import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  type WorkflowArtifactSource,
  evaluateGithubArtifactEgress,
  fetchReleaseBundleWithToken,
  processReleaseBundleWithToken,
} from "../../server/lib/github-app/artifacts";

const TOKEN = "ghs_installation_test_token";
const REPO = "octo/example";
const RUN_ID = 4242;
const ARTIFACT_ID = 99999;
const ARTIFACT_NAME = "pypi-release-candidate";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.unstubAllGlobals();
});

beforeEach(() => {
  vi.unstubAllGlobals();
});

// ── Tiny store-only ZIP builder (no deflate; matches existing readZipArchive
// expectations of compressionMethod === 0) ────────────────────────────────────

interface ZipEntry {
  path: string;
  body: Uint8Array | string;
}

function makeZip(entries: ZipEntry[]): Uint8Array {
  const encoder = new TextEncoder();
  const records: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;
  for (const entry of entries) {
    const body = typeof entry.body === "string" ? encoder.encode(entry.body) : entry.body;
    const nameBytes = encoder.encode(entry.path);
    const crc = crc32(body);
    const local = new Uint8Array(30 + nameBytes.length + body.length);
    const localView = new DataView(local.buffer);
    localView.setUint32(0, 0x04034b50, true);
    localView.setUint16(4, 20, true); // version needed
    localView.setUint16(6, 0, true); // flags
    localView.setUint16(8, 0, true); // method = stored
    localView.setUint16(10, 0, true); // time
    localView.setUint16(12, 0, true); // date
    localView.setUint32(14, crc, true);
    localView.setUint32(18, body.length, true);
    localView.setUint32(22, body.length, true);
    localView.setUint16(26, nameBytes.length, true);
    localView.setUint16(28, 0, true); // extra
    local.set(nameBytes, 30);
    local.set(body, 30 + nameBytes.length);
    records.push(local);

    const c = new Uint8Array(46 + nameBytes.length);
    const cView = new DataView(c.buffer);
    cView.setUint32(0, 0x02014b50, true);
    cView.setUint16(4, 20, true); // version made by
    cView.setUint16(6, 20, true); // version needed
    cView.setUint16(8, 0, true); // flags
    cView.setUint16(10, 0, true); // method = stored
    cView.setUint16(12, 0, true);
    cView.setUint16(14, 0, true);
    cView.setUint32(16, crc, true);
    cView.setUint32(20, body.length, true);
    cView.setUint32(24, body.length, true);
    cView.setUint16(28, nameBytes.length, true);
    cView.setUint16(30, 0, true);
    cView.setUint16(32, 0, true); // comment
    cView.setUint16(34, 0, true); // disk
    cView.setUint16(36, 0, true); // internal attrs
    cView.setUint32(38, 0, true); // external attrs
    cView.setUint32(42, offset, true);
    c.set(nameBytes, 46);
    central.push(c);
    offset += local.length;
  }
  const centralStart = offset;
  const centralBytes = concat(central);
  const eocd = new Uint8Array(22);
  const eocdView = new DataView(eocd.buffer);
  eocdView.setUint32(0, 0x06054b50, true);
  eocdView.setUint16(4, 0, true);
  eocdView.setUint16(6, 0, true);
  eocdView.setUint16(8, entries.length, true);
  eocdView.setUint16(10, entries.length, true);
  eocdView.setUint32(12, centralBytes.length, true);
  eocdView.setUint32(16, centralStart, true);
  eocdView.setUint16(20, 0, true);
  return concat([...records, centralBytes, eocd]);
}

function concat(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
  let cursor = 0;
  for (const part of parts) {
    out.set(part, cursor);
    cursor += part.length;
  }
  return out;
}

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let i = 0; i < 8; i += 1) {
      crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes as BufferSource);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

// ── Bundle fixture helpers ───────────────────────────────────────────────────

interface FakeWheel {
  bytes: Uint8Array;
  path: string;
}

function makeWheelBytes(name: string, version: string): FakeWheel {
  // A wheel is a ZIP. We embed minimal METADATA + RECORD entries so the PyPI
  // adapter would later be able to parse them; this test only needs the bytes
  // for digest verification.
  const path = `dist/${name.replace(/-/g, "_")}-${version}-py3-none-any.whl`;
  const wheelBytes = makeZip([
    {
      path: `${name.replace(/-/g, "_")}-${version}.dist-info/METADATA`,
      body: `Metadata-Version: 2.3\nName: ${name}\nVersion: ${version}\n`,
    },
    {
      path: `${name.replace(/-/g, "_")}-${version}.dist-info/WHEEL`,
      body: "Wheel-Version: 1.0\nRoot-Is-Purelib: true\nTag: py3-none-any\n",
    },
    {
      path: `${name.replace(/-/g, "_")}-${version}.dist-info/RECORD`,
      body: "",
    },
  ]);
  return { bytes: wheelBytes, path };
}

// The bundle no longer carries a `drydock-manifest.json`: the release set is
// simply the wheel/sdist files the bundle contains.
async function buildFixture(opts?: {
  extraEntries?: ZipEntry[];
  mutateWheel?: (bytes: Uint8Array) => Uint8Array;
  includeWheel?: boolean;
}): Promise<{
  wheel: FakeWheel;
  wheelSha: string;
  bundleZip: Uint8Array;
}> {
  const wheel = makeWheelBytes("demo-package", "1.2.0");
  const wheelBytes = opts?.mutateWheel ? opts.mutateWheel(wheel.bytes) : wheel.bytes;
  const wheelSha = await sha256Hex(wheelBytes);

  const entries: ZipEntry[] = [];
  if (opts?.includeWheel !== false) {
    entries.push({ path: wheel.path, body: wheelBytes });
  }
  if (opts?.extraEntries) entries.push(...opts.extraEntries);
  const bundleZip = makeZip(entries);
  return { wheel: { bytes: wheelBytes, path: wheel.path }, wheelSha, bundleZip };
}

// ── Fetch stub ───────────────────────────────────────────────────────────────

interface StubOptions {
  bundleZip: Uint8Array | null;
  artifacts?: Array<{
    id: number;
    name: string;
    bundleZip: Uint8Array | null;
    expired?: boolean;
  }>;
  artifactsResponse?: () => Response;
  artifactId?: number;
  artifactName?: string;
  contentLength?: number | null;
}

function stubGithubFetch(options: StubOptions) {
  const calls: { url: string; authorization: string | null }[] = [];
  const artifacts = options.artifacts ?? [
    {
      id: options.artifactId ?? ARTIFACT_ID,
      name: options.artifactName ?? ARTIFACT_NAME,
      bundleZip: options.bundleZip,
      expired: false,
    },
  ];
  const artifactsBody = JSON.stringify({
    total_count: artifacts.length,
    artifacts: artifacts.map((artifact) => ({
      id: artifact.id,
      name: artifact.name,
      size_in_bytes: artifact.bundleZip?.length ?? 0,
      expired: artifact.expired === true,
    })),
  });
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = input instanceof Request ? input : new Request(input, init);
      calls.push({
        url: request.url,
        authorization: request.headers.get("authorization"),
      });
      if (request.url.includes("/actions/runs/")) {
        if (options.artifactsResponse) return options.artifactsResponse();
        return new Response(artifactsBody, {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (request.url.includes("/actions/artifacts/")) {
        const match = request.url.match(/\/actions\/artifacts\/(\d+)\/zip$/);
        const artifactId = match ? Number.parseInt(match[1], 10) : Number.NaN;
        const artifact = artifacts.find((candidate) => candidate.id === artifactId);
        if (!artifact?.bundleZip) {
          return new Response("not found", { status: 404 });
        }
        const headers: Record<string, string> = {
          "content-type": "application/zip",
        };
        if (options.contentLength !== null) {
          headers["content-length"] = String(options.contentLength ?? artifact.bundleZip.length);
        }
        return new Response(artifact.bundleZip, { status: 200, headers });
      }
      throw new Error(`unexpected fetch in test: ${request.url}`);
    }),
  );
  return calls;
}

function source(overrides: Partial<WorkflowArtifactSource> = {}): WorkflowArtifactSource {
  return {
    installationExternalId: "1010",
    repositoryFullName: REPO,
    runId: RUN_ID,
    ...overrides,
  };
}

// The shared fetcher is ecosystem-agnostic; the workflow-gate adapter supplies
// this. These tests use a wheel/sdist classifier to exercise the release-set
// collection without coupling to a specific adapter. The classifier tags each
// kept entry with its ecosystem so a monorepo bundle can fan out per-ecosystem.
function classifyArtifact(path: string): { ecosystem: string; kind: string } | null {
  const lower = path.toLowerCase();
  if (lower.endsWith(".whl")) return { ecosystem: "pypi", kind: "wheel" };
  if (lower.endsWith(".tar.gz") || lower.endsWith(".tgz"))
    return { ecosystem: "pypi", kind: "sdist" };
  return null;
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("fetchReleaseBundleWithToken", () => {
  test("returns the verified wheel bytes on the happy path", async () => {
    const fixture = await buildFixture();
    const calls = stubGithubFetch({ bundleZip: fixture.bundleZip });

    const bundle = await fetchReleaseBundleWithToken(TOKEN, source(), classifyArtifact);

    expect(bundle.artifactName).toBe(ARTIFACT_NAME);
    expect(bundle.artifactId).toBe(ARTIFACT_ID);
    expect(bundle.artifacts).toHaveLength(1);
    expect(bundle.artifacts[0]?.path).toBe(fixture.wheel.path);
    expect(bundle.artifacts[0]?.kind).toBe("wheel");
    expect(bundle.artifacts[0]?.ecosystem).toBe("pypi");
    expect(bundle.artifacts[0]?.bytes).toEqual(fixture.wheel.bytes);
    expect(bundle.artifacts[0]?.sha256).toBe(fixture.wheelSha);
    expect(calls.every((call) => call.authorization === `Bearer ${TOKEN}`)).toBe(true);
  });

  test("collects every wheel and sdist in the bundle as the release set", async () => {
    const sdistPath = "dist/demo_package-1.2.0.tar.gz";
    const sdistBytes = new TextEncoder().encode("opaque sdist bytes");
    const fixture = await buildFixture({
      extraEntries: [{ path: sdistPath, body: sdistBytes }],
    });
    stubGithubFetch({ bundleZip: fixture.bundleZip });

    const bundle = await fetchReleaseBundleWithToken(TOKEN, source(), classifyArtifact);

    const paths = bundle.artifacts.map((artifact) => artifact.path).sort();
    expect(paths).toEqual([sdistPath, fixture.wheel.path].sort());
    const sdist = bundle.artifacts.find((artifact) => artifact.path === sdistPath);
    expect(sdist?.kind).toBe("sdist");
    expect(sdist?.sha256).toBe(await sha256Hex(sdistBytes));
  });

  test("collects reviewable files across every non-expired workflow artifact", async () => {
    const first = await buildFixture();
    const secondWheel = makeWheelBytes("other-package", "2.0.0");
    const secondZip = makeZip([{ path: secondWheel.path, body: secondWheel.bytes }]);
    stubGithubFetch({
      bundleZip: null,
      artifacts: [
        {
          id: ARTIFACT_ID,
          name: "alpha-upload",
          bundleZip: first.bundleZip,
        },
        {
          id: ARTIFACT_ID + 1,
          name: "beta-upload",
          bundleZip: secondZip,
        },
        {
          id: ARTIFACT_ID + 2,
          name: "expired-upload",
          bundleZip: makeZip([{ path: "dist/expired-1.0.0.tar.gz", body: "expired" }]),
          expired: true,
        },
      ],
    });

    const bundle = await fetchReleaseBundleWithToken(TOKEN, source(), classifyArtifact);

    expect(bundle.artifactName).toBe("all");
    expect(bundle.artifactSizeBytes).toBe(first.bundleZip.length + secondZip.length);
    const paths = bundle.artifacts.map((artifact) => artifact.path).sort();
    expect(paths).toEqual([first.wheel.path, secondWheel.path].sort());
  });

  test("processes a NumPy-sized shard family one release file at a time", async () => {
    const artifacts = Array.from({ length: 44 }, (_, index) => {
      const wheel = makeWheelBytes("demo-package", `1.2.${index}`);
      return {
        id: ARTIFACT_ID + index,
        name: `${ARTIFACT_NAME}-${String(index).padStart(2, "0")}`,
        bundleZip: makeZip([{ path: wheel.path, body: wheel.bytes }]),
      };
    });
    artifacts.push({
      id: ARTIFACT_ID + 100,
      name: "unrelated-build-output",
      bundleZip: makeZip([{ path: "dist/unrelated-1.0.0.tar.gz", body: "ignored" }]),
    });
    stubGithubFetch({ bundleZip: null, artifacts });

    let activeProcessors = 0;
    let maxActiveProcessors = 0;
    const bundle = await processReleaseBundleWithToken(
      TOKEN,
      source({ artifactNamePrefix: ARTIFACT_NAME }),
      classifyArtifact,
      async (artifact) => {
        activeProcessors += 1;
        maxActiveProcessors = Math.max(maxActiveProcessors, activeProcessors);
        await Promise.resolve();
        activeProcessors -= 1;
        return { path: artifact.path, sha256: artifact.sha256 };
      },
    );

    expect(bundle.artifacts).toHaveLength(44);
    expect(bundle.artifactName).toBe("all");
    expect(maxActiveProcessors).toBe(1);
    expect(bundle.artifacts.every((artifact) => artifact.path.endsWith(".whl"))).toBe(true);
  });

  test("fails closed when two shards carry the same path with different bytes", async () => {
    const wheel = makeWheelBytes("demo-package", "1.2.0");
    const artifacts = [
      {
        id: ARTIFACT_ID,
        name: `${ARTIFACT_NAME}-linux`,
        bundleZip: makeZip([{ path: wheel.path, body: wheel.bytes }]),
      },
      {
        id: ARTIFACT_ID + 1,
        name: `${ARTIFACT_NAME}-macos`,
        bundleZip: makeZip([
          { path: wheel.path, body: concat([wheel.bytes, new Uint8Array([0])]) },
        ]),
      },
    ];
    stubGithubFetch({ bundleZip: null, artifacts });

    await expect(
      processReleaseBundleWithToken(
        TOKEN,
        source({ artifactNamePrefix: ARTIFACT_NAME }),
        classifyArtifact,
        async (artifact) => artifact,
      ),
    ).rejects.toThrow(/appears in more than one artifact upload/);
  });

  test("accepts a distribution re-uploaded byte-identically across shards", async () => {
    // A matrix leg that runs a full `python -m build` ships the sdist next to
    // its wheel, so the same sdist can arrive from several shards.
    const wheel = makeWheelBytes("demo-package", "1.2.0");
    const bundleZip = makeZip([{ path: wheel.path, body: wheel.bytes }]);
    stubGithubFetch({
      bundleZip: null,
      artifacts: [
        { id: ARTIFACT_ID, name: `${ARTIFACT_NAME}-linux`, bundleZip },
        { id: ARTIFACT_ID + 1, name: `${ARTIFACT_NAME}-macos`, bundleZip },
      ],
    });

    const bundle = await processReleaseBundleWithToken(
      TOKEN,
      source({ artifactNamePrefix: ARTIFACT_NAME }),
      classifyArtifact,
      async (artifact) => artifact,
    );

    expect(bundle.artifacts).toHaveLength(1);
    expect(bundle.artifacts[0]?.path).toBe(wheel.path);
  });

  test("keeps the single-upload budget when no artifact name narrows the run", async () => {
    // An auto-detect release target supplies neither name nor prefix, so every
    // non-expired upload on the run matches. The shard-family budget must not
    // apply there or an unrelated CI run would be downloaded wholesale.
    const artifacts = Array.from({ length: 21 }, (_, index) => {
      const wheel = makeWheelBytes("demo-package", `1.2.${index}`);
      return {
        id: ARTIFACT_ID + index,
        name: `unrelated-build-output-${index}`,
        bundleZip: makeZip([{ path: wheel.path, body: wheel.bytes }]),
      };
    });
    stubGithubFetch({ bundleZip: null, artifacts });

    await expect(
      processReleaseBundleWithToken(
        TOKEN,
        source(),
        classifyArtifact,
        async (artifact) => artifact,
      ),
    ).rejects.toThrow(/more than 20 release files/);
  });

  test("ignores non-artifact files in the bundle", async () => {
    const fixture = await buildFixture({
      extraEntries: [
        { path: "drydock-sha256.txt", body: "placeholder\n" },
        { path: "dist/demo_package-1.2.0.zip", body: "not a wheel or sdist" },
        { path: "README.md", body: "# notes\n" },
      ],
    });
    stubGithubFetch({ bundleZip: fixture.bundleZip });

    const bundle = await fetchReleaseBundleWithToken(TOKEN, source(), classifyArtifact);

    expect(bundle.artifacts).toHaveLength(1);
    expect(bundle.artifacts[0]?.path).toBe(fixture.wheel.path);
  });

  test("bundle_empty when the bundle has no wheel or sdist files", async () => {
    const fixture = await buildFixture({
      includeWheel: false,
      extraEntries: [{ path: "drydock-sha256.txt", body: "placeholder\n" }],
    });
    stubGithubFetch({ bundleZip: fixture.bundleZip });

    await expect(
      fetchReleaseBundleWithToken(TOKEN, source(), classifyArtifact),
    ).rejects.toMatchObject({
      code: "bundle_empty",
    });
  });

  test("bundle_too_large when the bundle declares more than 20 artifacts", async () => {
    const entries: ZipEntry[] = [];
    for (let index = 0; index < 21; index += 1) {
      entries.push({ path: `dist/demo_package-1.2.${index}.tar.gz`, body: `sdist ${index}` });
    }
    const bundleZip = makeZip(entries);
    stubGithubFetch({ bundleZip });

    await expect(
      fetchReleaseBundleWithToken(TOKEN, source(), classifyArtifact),
    ).rejects.toMatchObject({
      code: "bundle_too_large",
    });
  });

  test("bundle_unavailable when an explicit artifact name does not exist", async () => {
    const fixture = await buildFixture();
    stubGithubFetch({ bundleZip: fixture.bundleZip, artifactName: "something-else" });

    await expect(
      fetchReleaseBundleWithToken(TOKEN, source({ artifactName: ARTIFACT_NAME }), classifyArtifact),
    ).rejects.toMatchObject({
      name: "WorkflowArtifactError",
      code: "bundle_unavailable",
    });
  });

  test("bundle_unavailable when list-artifacts returns 404", async () => {
    stubGithubFetch({
      bundleZip: null,
      artifactsResponse: () => new Response("missing", { status: 404 }),
    });

    await expect(
      fetchReleaseBundleWithToken(TOKEN, source(), classifyArtifact),
    ).rejects.toMatchObject({
      code: "bundle_unavailable",
    });
  });

  test("bundle_too_large when content-length exceeds the cap", async () => {
    const fixture = await buildFixture();
    stubGithubFetch({
      bundleZip: fixture.bundleZip,
      contentLength: 26 * 1024 * 1024,
    });

    await expect(
      fetchReleaseBundleWithToken(TOKEN, source(), classifyArtifact),
    ).rejects.toMatchObject({
      code: "bundle_too_large",
    });
  });

  test("artifact_path_unsafe when the bundle includes a traversal path", async () => {
    const sneaky = makeWheelBytes("demo-package", "1.2.0");
    const bundle = makeZip([{ path: "../../etc/passwd", body: sneaky.bytes }]);
    stubGithubFetch({ bundleZip: bundle });

    await expect(
      fetchReleaseBundleWithToken(TOKEN, source(), classifyArtifact),
    ).rejects.toMatchObject({
      code: "artifact_path_unsafe",
    });
  });

  test("drops the installation token on the redirect to the storage host", async () => {
    const fixture = await buildFixture();
    const storageUrl =
      "https://productionresultssa4.blob.core.windows.net/actions-results/run/artifacts/candidate.zip?sig=abc";
    const calls: { url: string; authorization: string | null }[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const request = input instanceof Request ? input : new Request(input, init);
        calls.push({ url: request.url, authorization: request.headers.get("authorization") });
        if (request.url.includes("/actions/runs/")) {
          return new Response(
            JSON.stringify({
              total_count: 1,
              artifacts: [
                {
                  id: ARTIFACT_ID,
                  name: ARTIFACT_NAME,
                  size_in_bytes: fixture.bundleZip.length,
                  expired: false,
                },
              ],
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        }
        if (request.url.endsWith(`/actions/artifacts/${ARTIFACT_ID}/zip`)) {
          return new Response(null, { status: 302, headers: { location: storageUrl } });
        }
        if (request.url === storageUrl) {
          return new Response(fixture.bundleZip, {
            status: 200,
            headers: {
              "content-type": "application/zip",
              "content-length": String(fixture.bundleZip.length),
            },
          });
        }
        throw new Error(`unexpected fetch in test: ${request.url}`);
      }),
    );

    const bundle = await fetchReleaseBundleWithToken(TOKEN, source(), classifyArtifact);
    expect(bundle.artifacts).toHaveLength(1);

    const apiCalls = calls.filter((call) => call.url.startsWith("https://api.github.com/"));
    const storageCalls = calls.filter((call) => call.url === storageUrl);
    expect(apiCalls.length).toBeGreaterThan(0);
    expect(apiCalls.every((call) => call.authorization === `Bearer ${TOKEN}`)).toBe(true);
    expect(storageCalls).toHaveLength(1);
    expect(storageCalls[0]?.authorization).toBeNull();
  });

  test("fails closed without leaking the token when a download redirects off the allowlist", async () => {
    const fixture = await buildFixture();
    const evilUrl = "https://evil.example.com/candidate.zip";
    const calls: { url: string; authorization: string | null }[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const request = input instanceof Request ? input : new Request(input, init);
        calls.push({ url: request.url, authorization: request.headers.get("authorization") });
        if (request.url.includes("/actions/runs/")) {
          return new Response(
            JSON.stringify({
              total_count: 1,
              artifacts: [
                {
                  id: ARTIFACT_ID,
                  name: ARTIFACT_NAME,
                  size_in_bytes: fixture.bundleZip.length,
                  expired: false,
                },
              ],
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        }
        if (request.url.endsWith(`/actions/artifacts/${ARTIFACT_ID}/zip`)) {
          return new Response(null, { status: 302, headers: { location: evilUrl } });
        }
        throw new Error(`unexpected fetch in test: ${request.url}`);
      }),
    );

    await expect(
      fetchReleaseBundleWithToken(TOKEN, source(), classifyArtifact),
    ).rejects.toMatchObject({
      code: "bundle_unavailable",
    });
    expect(calls.some((call) => call.url === evilUrl)).toBe(false);
  });
});

describe("evaluateGithubArtifactEgress", () => {
  test("credentials only api.github.com", () => {
    expect(evaluateGithubArtifactEgress("https://api.github.com/repos/o/r/actions")).toEqual({
      allowed: true,
      credentialed: true,
      host: "api.github.com",
    });
  });

  test("allows the artifact storage host without credentials", () => {
    expect(
      evaluateGithubArtifactEgress("https://prod.actions.githubusercontent.com/blob/x.zip?sig=1"),
    ).toEqual({
      allowed: true,
      credentialed: false,
      host: "actions.githubusercontent.com",
    });
    expect(
      evaluateGithubArtifactEgress(
        "https://productionresultssa4.blob.core.windows.net/actions-results/run/artifacts/x.zip?sig=1",
      ),
    ).toEqual({
      allowed: true,
      credentialed: false,
      host: "blob.core.windows.net",
    });
  });

  test("blocks other hosts and non-https schemes", () => {
    expect(evaluateGithubArtifactEgress("https://evil.example.com/x.zip").allowed).toBe(false);
    expect(evaluateGithubArtifactEgress("http://api.github.com/x").allowed).toBe(false);
    // A look-alike host must not satisfy the suffix check.
    expect(
      evaluateGithubArtifactEgress("https://actions.githubusercontent.com.evil.com/x").allowed,
    ).toBe(false);
    expect(
      evaluateGithubArtifactEgress("https://productionresultssa4.blob.core.windows.net/x").allowed,
    ).toBe(false);
    expect(evaluateGithubArtifactEgress("not a url").allowed).toBe(false);
  });
});
