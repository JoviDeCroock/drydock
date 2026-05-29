import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  fetchReleaseBundleWithToken,
  type WorkflowArtifactSource,
} from "../../server/lib/github-app-artifacts";

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

async function buildFixture(opts?: {
  extraEntries?: ZipEntry[];
  mutateWheel?: (bytes: Uint8Array) => Uint8Array;
  omitManifest?: boolean;
  manifestRaw?: string;
  declareWheelKind?: "wheel" | "sdist";
}): Promise<{
  wheel: FakeWheel;
  manifestRaw: string;
  bundleZip: Uint8Array;
}> {
  const wheel = makeWheelBytes("demo-package", "1.2.0");
  const wheelBytes = opts?.mutateWheel ? opts.mutateWheel(wheel.bytes) : wheel.bytes;
  const wheelSha = await sha256Hex(wheelBytes);

  const manifestObject = {
    schema: "drydock.release-artifacts.v1",
    ecosystem: "pypi",
    package: "demo-package",
    version: "1.2.0",
    artifacts: [
      {
        path: wheel.path,
        sha256: wheelSha,
        // The PyPI adapter's parsePyPiReleaseManifest infers kind from the
        // suffix; we don't include "kind" in the JSON.
      },
    ],
  };
  const manifestRaw = opts?.manifestRaw ?? JSON.stringify(manifestObject, null, 2);

  const entries: ZipEntry[] = [];
  if (!opts?.omitManifest) {
    entries.push({ path: "drydock-manifest.json", body: manifestRaw });
  }
  entries.push({ path: wheel.path, body: wheelBytes });
  if (opts?.extraEntries) entries.push(...opts.extraEntries);
  const bundleZip = makeZip(entries);
  return { wheel: { bytes: wheelBytes, path: wheel.path }, manifestRaw, bundleZip };
}

// ── Fetch stub ───────────────────────────────────────────────────────────────

interface StubOptions {
  bundleZip: Uint8Array | null;
  artifactsResponse?: () => Response;
  artifactId?: number;
  artifactName?: string;
  contentLength?: number | null;
}

function stubGithubFetch(options: StubOptions) {
  const calls: { url: string; authorization: string | null }[] = [];
  const artifactsBody = JSON.stringify({
    total_count: 1,
    artifacts: [
      {
        id: options.artifactId ?? ARTIFACT_ID,
        name: options.artifactName ?? ARTIFACT_NAME,
        size_in_bytes: options.bundleZip?.length ?? 0,
        expired: false,
      },
    ],
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
        if (!options.bundleZip) {
          return new Response("not found", { status: 404 });
        }
        const headers: Record<string, string> = {
          "content-type": "application/zip",
        };
        if (options.contentLength !== null) {
          headers["content-length"] = String(options.contentLength ?? options.bundleZip.length);
        }
        return new Response(options.bundleZip, { status: 200, headers });
      }
      throw new Error(`unexpected fetch in test: ${request.url}`);
    }),
  );
  return calls;
}

function source(): WorkflowArtifactSource {
  return {
    installationExternalId: "1010",
    repositoryFullName: REPO,
    runId: RUN_ID,
  };
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("fetchReleaseBundleWithToken", () => {
  test("returns the manifest and verified wheel bytes on the happy path", async () => {
    const fixture = await buildFixture();
    const calls = stubGithubFetch({ bundleZip: fixture.bundleZip });

    const bundle = await fetchReleaseBundleWithToken(TOKEN, source());

    expect(bundle.manifest.package).toBe("demo-package");
    expect(bundle.manifest.version).toBe("1.2.0");
    expect(bundle.artifactName).toBe(ARTIFACT_NAME);
    expect(bundle.artifactId).toBe(ARTIFACT_ID);
    expect(bundle.artifacts).toHaveLength(1);
    expect(bundle.artifacts[0]?.path).toBe(fixture.wheel.path);
    expect(bundle.artifacts[0]?.kind).toBe("wheel");
    expect(bundle.artifacts[0]?.bytes).toEqual(fixture.wheel.bytes);
    expect(calls.every((call) => call.authorization === `Bearer ${TOKEN}`)).toBe(true);
  });

  test("bundle_unavailable when no artifact with that name exists", async () => {
    const fixture = await buildFixture();
    stubGithubFetch({ bundleZip: fixture.bundleZip, artifactName: "something-else" });

    await expect(fetchReleaseBundleWithToken(TOKEN, source())).rejects.toMatchObject({
      name: "WorkflowArtifactError",
      code: "bundle_unavailable",
    });
  });

  test("bundle_unavailable when list-artifacts returns 404", async () => {
    stubGithubFetch({
      bundleZip: null,
      artifactsResponse: () => new Response("missing", { status: 404 }),
    });

    await expect(fetchReleaseBundleWithToken(TOKEN, source())).rejects.toMatchObject({
      code: "bundle_unavailable",
    });
  });

  test("bundle_too_large when content-length exceeds the cap", async () => {
    const fixture = await buildFixture();
    stubGithubFetch({
      bundleZip: fixture.bundleZip,
      contentLength: 26 * 1024 * 1024,
    });

    await expect(fetchReleaseBundleWithToken(TOKEN, source())).rejects.toMatchObject({
      code: "bundle_too_large",
    });
  });

  test("manifest_missing when the zip lacks drydock-manifest.json", async () => {
    const fixture = await buildFixture({ omitManifest: true });
    stubGithubFetch({ bundleZip: fixture.bundleZip });

    await expect(fetchReleaseBundleWithToken(TOKEN, source())).rejects.toMatchObject({
      code: "manifest_missing",
    });
  });

  test("manifest_invalid when the manifest JSON is malformed", async () => {
    const fixture = await buildFixture({ manifestRaw: "{ not json" });
    stubGithubFetch({ bundleZip: fixture.bundleZip });

    await expect(fetchReleaseBundleWithToken(TOKEN, source())).rejects.toMatchObject({
      code: "manifest_invalid",
    });
  });

  test("manifest_artifact_mismatch when the bundle has an extra wheel not declared in the manifest", async () => {
    const sneaky = makeWheelBytes("evil-package", "9.9.9");
    const fixture = await buildFixture({
      extraEntries: [{ path: sneaky.path, body: sneaky.bytes }],
    });
    stubGithubFetch({ bundleZip: fixture.bundleZip });

    await expect(fetchReleaseBundleWithToken(TOKEN, source())).rejects.toMatchObject({
      code: "manifest_artifact_mismatch",
    });
  });

  test("artifact_kind_unsupported when the bundle has an undeclared dist file", async () => {
    const fixture = await buildFixture({
      extraEntries: [{ path: "dist/demo_package-1.2.0.zip", body: "not reviewed" }],
    });
    stubGithubFetch({ bundleZip: fixture.bundleZip });

    await expect(fetchReleaseBundleWithToken(TOKEN, source())).rejects.toMatchObject({
      code: "artifact_kind_unsupported",
    });
  });

  test("allows the workflow checksum support file outside the manifest", async () => {
    const fixture = await buildFixture({
      extraEntries: [{ path: "drydock-sha256.txt", body: "placeholder\n" }],
    });
    stubGithubFetch({ bundleZip: fixture.bundleZip });

    const bundle = await fetchReleaseBundleWithToken(TOKEN, source());

    expect(bundle.artifacts).toHaveLength(1);
    expect(bundle.artifacts[0]?.path).toBe(fixture.wheel.path);
  });

  test("manifest_artifact_mismatch when manifest declares a path the bundle omits", async () => {
    const realWheel = makeWheelBytes("demo-package", "1.2.0");
    const realSha = await sha256Hex(realWheel.bytes);
    const declaredButAbsent = "dist/demo_package-1.2.0-py3-none-any.whl";
    const manifestRaw = JSON.stringify({
      schema: "drydock.release-artifacts.v1",
      ecosystem: "pypi",
      package: "demo-package",
      version: "1.2.0",
      artifacts: [
        { path: declaredButAbsent, sha256: realSha },
        {
          path: "dist/demo_package-1.2.0.tar.gz",
          sha256: "b".repeat(64),
        },
      ],
    });
    const bundle = makeZip([
      { path: "drydock-manifest.json", body: manifestRaw },
      { path: declaredButAbsent, body: realWheel.bytes },
    ]);
    stubGithubFetch({ bundleZip: bundle });

    await expect(fetchReleaseBundleWithToken(TOKEN, source())).rejects.toMatchObject({
      code: "manifest_artifact_mismatch",
    });
  });

  test("artifact_digest_mismatch when a declared artifact's bytes differ from the manifest sha256", async () => {
    const fixture = await buildFixture({
      mutateWheel: (bytes) => {
        // After we mutate, the manifest sha256 (computed over original bytes
        // in `buildFixture`) won't match the bundled bytes. Build the
        // manifest before mutation, mutate after.
        return bytes;
      },
    });
    // Replace the wheel entry with a tampered copy that does not match the
    // recorded sha256.
    const tamperedWheel = makeWheelBytes("demo-package", "1.2.0").bytes;
    tamperedWheel[tamperedWheel.length - 5] ^= 0xff;
    const tamperedBundle = makeZip([
      { path: "drydock-manifest.json", body: fixture.manifestRaw },
      { path: fixture.wheel.path, body: tamperedWheel },
    ]);
    stubGithubFetch({ bundleZip: tamperedBundle });

    await expect(fetchReleaseBundleWithToken(TOKEN, source())).rejects.toMatchObject({
      code: "artifact_digest_mismatch",
    });
  });

  test("artifact_path_unsafe when the bundle includes a traversal path", async () => {
    const sneaky = makeWheelBytes("demo-package", "1.2.0");
    const bundle = makeZip([
      { path: "drydock-manifest.json", body: "{}" },
      { path: "../../etc/passwd", body: sneaky.bytes },
    ]);
    stubGithubFetch({ bundleZip: bundle });

    await expect(fetchReleaseBundleWithToken(TOKEN, source())).rejects.toMatchObject({
      code: "artifact_path_unsafe",
    });
  });
});
