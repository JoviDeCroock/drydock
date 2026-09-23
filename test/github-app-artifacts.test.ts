import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  type WorkflowArtifactSource,
  evaluateGithubArtifactEgress,
  fetchReleaseBundleWithToken,
  processReleaseBundleWithToken,
} from "../server/lib/github-app/artifacts";
import { buildZip, concatBytes, type ZipEntry } from "./helpers/archive-fixtures";
import { stubGithubFetch } from "./helpers/github-fetch-stub";

function stubArtifacts(options: StubOptions) {
  const artifacts = options.artifacts ?? [
    {
      id: options.artifactId ?? ARTIFACT_ID,
      name: options.artifactName ?? ARTIFACT_NAME,
      bundleZip: options.bundleZip,
      expired: false,
    },
  ];
  return stubGithubFetch({
    artifacts: artifacts.map((artifact) => ({
      ...artifact,
      bundleZip: artifact.bundleZip ?? undefined,
    })),
    artifactsResponse: options.artifactsResponse,
    contentLength: options.contentLength,
  });
}

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
  const wheelBytes = buildZip([
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
  bundleZip: Uint8Array<ArrayBuffer>;
}> {
  const wheel = makeWheelBytes("demo-package", "1.2.0");
  const wheelBytes = opts?.mutateWheel ? opts.mutateWheel(wheel.bytes) : wheel.bytes;
  const wheelSha = await sha256Hex(wheelBytes);

  const entries: ZipEntry[] = [];
  if (opts?.includeWheel !== false) {
    entries.push({ path: wheel.path, body: wheelBytes });
  }
  if (opts?.extraEntries) entries.push(...opts.extraEntries);
  const bundleZip = buildZip(entries);
  return { wheel: { bytes: wheelBytes, path: wheel.path }, wheelSha, bundleZip };
}

// ── Fetch stub ───────────────────────────────────────────────────────────────

interface StubOptions {
  bundleZip: Uint8Array<ArrayBuffer> | null;
  artifacts?: Array<{
    id: number;
    name: string;
    bundleZip: Uint8Array<ArrayBuffer> | null;
    expired?: boolean;
  }>;
  artifactsResponse?: () => Response;
  artifactId?: number;
  artifactName?: string;
  contentLength?: number | null;
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
    const calls = stubArtifacts({ bundleZip: fixture.bundleZip });

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
    stubArtifacts({ bundleZip: fixture.bundleZip });

    const bundle = await fetchReleaseBundleWithToken(TOKEN, source(), classifyArtifact);

    const paths = bundle.artifacts.map((artifact) => artifact.path).sort();
    expect(paths).toEqual([sdistPath, fixture.wheel.path].sort());
    const sdist = bundle.artifacts.find((artifact) => artifact.path === sdistPath);
    expect(sdist?.kind).toBe("sdist");
    expect(sdist?.sha256).toBe(await sha256Hex(sdistBytes));
    // SHA-1 of the same bytes, in npm's `dist.shasum` encoding.
    expect(sdist?.sha1).toBe(createHash("sha1").update(sdistBytes).digest("hex"));
  });

  test("collects reviewable files across every non-expired workflow artifact", async () => {
    const first = await buildFixture();
    const secondWheel = makeWheelBytes("other-package", "2.0.0");
    const secondZip = buildZip([{ path: secondWheel.path, body: secondWheel.bytes }]);
    stubArtifacts({
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
          bundleZip: buildZip([{ path: "dist/expired-1.0.0.tar.gz", body: "expired" }]),
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
        bundleZip: buildZip([{ path: wheel.path, body: wheel.bytes }]),
      };
    });
    artifacts.push({
      id: ARTIFACT_ID + 100,
      name: "unrelated-build-output",
      bundleZip: buildZip([{ path: "dist/unrelated-1.0.0.tar.gz", body: "ignored" }]),
    });
    stubArtifacts({ bundleZip: null, artifacts });

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
        bundleZip: buildZip([{ path: wheel.path, body: wheel.bytes }]),
      },
      {
        id: ARTIFACT_ID + 1,
        name: `${ARTIFACT_NAME}-macos`,
        bundleZip: buildZip([
          { path: wheel.path, body: concatBytes([wheel.bytes, new Uint8Array([0])]) },
        ]),
      },
    ];
    stubArtifacts({ bundleZip: null, artifacts });

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
    const bundleZip = buildZip([{ path: wheel.path, body: wheel.bytes }]);
    stubArtifacts({
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
        bundleZip: buildZip([{ path: wheel.path, body: wheel.bytes }]),
      };
    });
    stubArtifacts({ bundleZip: null, artifacts });

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
    stubArtifacts({ bundleZip: fixture.bundleZip });

    const bundle = await fetchReleaseBundleWithToken(TOKEN, source(), classifyArtifact);

    expect(bundle.artifacts).toHaveLength(1);
    expect(bundle.artifacts[0]?.path).toBe(fixture.wheel.path);
  });

  test("bundle_empty when the bundle has no wheel or sdist files", async () => {
    const fixture = await buildFixture({
      includeWheel: false,
      extraEntries: [{ path: "drydock-sha256.txt", body: "placeholder\n" }],
    });
    stubArtifacts({ bundleZip: fixture.bundleZip });

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
    const bundleZip = buildZip(entries);
    stubArtifacts({ bundleZip });

    await expect(
      fetchReleaseBundleWithToken(TOKEN, source(), classifyArtifact),
    ).rejects.toMatchObject({
      code: "bundle_too_large",
    });
  });

  test("bundle_unavailable when an explicit artifact name does not exist", async () => {
    const fixture = await buildFixture();
    stubArtifacts({ bundleZip: fixture.bundleZip, artifactName: "something-else" });

    await expect(
      fetchReleaseBundleWithToken(TOKEN, source({ artifactName: ARTIFACT_NAME }), classifyArtifact),
    ).rejects.toMatchObject({
      name: "WorkflowArtifactError",
      code: "bundle_unavailable",
    });
  });

  test("bundle_unavailable when list-artifacts returns 404", async () => {
    stubArtifacts({
      bundleZip: null,
      artifactsResponse: () => new Response("missing", { status: 404 }),
    });

    await expect(
      fetchReleaseBundleWithToken(TOKEN, source(), classifyArtifact),
    ).rejects.toMatchObject({
      code: "bundle_unavailable",
    });
  });

  test("bundle_unavailable when the artifact listing is truncated by the page cap", async () => {
    // Every page advertises another one, so the walk stops on the page cap with
    // a `next` still outstanding. The matching artifact is present and readable
    // on page one — the point is that a listing we could not finish must not
    // resolve to the subset we happened to see, because the shard that is
    // missing is exactly the one an attacker would add last.
    const fixture = await buildFixture();
    let page = 0;
    stubArtifacts({
      bundleZip: fixture.bundleZip,
      artifactsResponse: () => {
        page += 1;
        return new Response(
          JSON.stringify({
            total_count: 1,
            artifacts: [{ id: ARTIFACT_ID, name: ARTIFACT_NAME, size_in_bytes: 1, expired: false }],
          }),
          {
            status: 200,
            headers: {
              "content-type": "application/json",
              link: `<https://api.github.com/repos/o/r/actions/runs/1/artifacts?page=${page + 1}>; rel="next"`,
            },
          },
        );
      },
    });

    await expect(
      fetchReleaseBundleWithToken(TOKEN, source(), classifyArtifact),
    ).rejects.toMatchObject({
      name: "WorkflowArtifactError",
      code: "bundle_unavailable",
    });
    // Bounded by the page cap rather than following `next` forever.
    expect(page).toBeLessThanOrEqual(10);
  });

  test("bundle_unavailable when the artifact listing stops at an off-host pagination link", async () => {
    // The host veto refuses to send the installation token to whatever a forged
    // `Link` names. Refusing to walk the chain still leaves the rest of the
    // listing unread, so it has to fail closed the same way the page cap does —
    // otherwise the one case the veto exists for is the one that resolves to a
    // subset.
    const fixture = await buildFixture();
    let page = 0;
    stubArtifacts({
      bundleZip: fixture.bundleZip,
      artifactsResponse: () => {
        page += 1;
        return new Response(
          JSON.stringify({
            total_count: 1,
            artifacts: [{ id: ARTIFACT_ID, name: ARTIFACT_NAME, size_in_bytes: 1, expired: false }],
          }),
          {
            status: 200,
            headers: {
              "content-type": "application/json",
              link: `<https://attacker.example/repos/o/r/actions/runs/1/artifacts?page=2>; rel="next"`,
            },
          },
        );
      },
    });

    await expect(
      fetchReleaseBundleWithToken(TOKEN, source(), classifyArtifact),
    ).rejects.toMatchObject({
      name: "WorkflowArtifactError",
      code: "bundle_unavailable",
    });
    // The vetoed link was never fetched.
    expect(page).toBe(1);
  });

  test("bundle_too_large when content-length exceeds the cap", async () => {
    const fixture = await buildFixture();
    stubArtifacts({
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
    const bundle = buildZip([{ path: "../../etc/passwd", body: sneaky.bytes }]);
    stubArtifacts({ bundleZip: bundle });

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
