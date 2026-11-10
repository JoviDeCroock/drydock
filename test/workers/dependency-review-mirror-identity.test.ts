import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { afterEach, describe, expect, test, vi } from "vitest";
import {
  verifyMirrorBump,
  verifyPublicPin,
} from "../../server/lib/dependency-review/mirror-identity";
import type { DependencyBump } from "../../server/lib/dependency-review/types";
import { createPackumentExtractor } from "../../server/lib/ecosystems/npm/packument-stream";
import {
  projectPackumentExtract,
  projectRegistryMetadata,
} from "../../server/lib/ecosystems/npm/registry";

afterEach(() => {
  vi.restoreAllMocks();
});

async function digest(algorithm: "SHA-512" | "SHA-256", seed: string): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest(algorithm, new TextEncoder().encode(seed)));
}
const sha512 = async (seed: string) =>
  `sha512-${btoa(String.fromCharCode(...(await digest("SHA-512", seed))))}`;
const hex = async (seed: string) =>
  [...(await digest("SHA-256", seed))].map((b) => b.toString(16).padStart(2, "0")).join("");

// COMPARE_CACHE is unbound in tests; a fresh map per test keeps reads cold.
function fakeKv(): KVNamespace {
  const store = new Map<string, string>();
  return {
    async get(key: string, options?: { type?: string }) {
      const raw = store.get(key);
      if (raw === undefined) return null;
      return options?.type === "json" ? JSON.parse(raw) : raw;
    },
    async put(key: string, value: string) {
      store.set(key, value);
    },
  } as unknown as KVNamespace;
}

type Route = (url: URL) => Response;

function stubRegistry(route: Route) {
  return vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const request = new Request(input as RequestInfo, init);
    return route(new URL(request.url));
  });
}

async function verify(
  bump: DependencyBump,
  overrides: Partial<Cloudflare.Env> = {},
  check = verifyMirrorBump,
) {
  const ctx = createExecutionContext();
  try {
    return await check(
      {
        ...env,
        COMPARE_CACHE: fakeKv(),
        NPM_REGISTRY: "https://registry.npmjs.org",
        ...overrides,
      } as Cloudflare.Env,
      ctx,
      bump,
    );
  } finally {
    await waitOnExecutionContext(ctx);
  }
}

function npmBump(
  fromVersion: string | null,
  toVersion: string,
  fromHashes: string[] | null,
  toHashes: string[],
  name = "left-pad",
): DependencyBump {
  return {
    ecosystem: "npm",
    name,
    fromVersion,
    toVersion,
    direct: true,
    lockfilePath: "package-lock.json",
    privateSource: true,
    mirror: { fromHashes, toHashes },
  };
}

async function packument(versions: Record<string, string | null>) {
  return Response.json({
    name: "left-pad",
    "dist-tags": { latest: "1.1.0" },
    versions: Object.fromEntries(
      Object.entries(versions).map(([version, integrity]) => [
        version,
        {
          name: "left-pad",
          version,
          dist: {
            tarball: `https://registry.npmjs.org/left-pad/-/left-pad-${version}.tgz`,
            shasum: "0".repeat(40),
            ...(integrity === null ? {} : { integrity }),
          },
        },
      ]),
    ),
  });
}

describe("verifyMirrorBump: npm", () => {
  async function registry(versions: Record<string, string | null>) {
    const body = await (await packument(versions)).text();
    return stubRegistry((url) =>
      url.host === "registry.npmjs.org" && url.pathname === "/left-pad"
        ? new Response(body, { headers: { "content-type": "application/json" } })
        : new Response("not found", { status: 404 }),
    );
  }

  test("both sides match the public sha512", async () => {
    const [a, b] = [await sha512("1.0.0"), await sha512("1.1.0")];
    const fetchSpy = await registry({
      "1.0.0": a,
      "1.1.0": `${b} sha1-AAAAAAAAAAAAAAAAAAAAAAAAAAA=`,
    });
    expect(await verify(npmBump("1.0.0", "1.1.0", [a], [b]))).toBe(true);
    // Anonymous, public host only.
    for (const [input, init] of fetchSpy.mock.calls) {
      const request = new Request(input as RequestInfo, init);
      expect(new URL(request.url).host).toBe("registry.npmjs.org");
      expect(request.headers.get("authorization")).toBeNull();
    }
  });

  test("a mismatch on either side fails", async () => {
    const [a, b, evil] = [await sha512("1.0.0"), await sha512("1.1.0"), await sha512("evil")];
    await registry({ "1.0.0": a, "1.1.0": b });
    expect(await verify(npmBump("1.0.0", "1.1.0", [a], [evil]))).toBe(false);
    expect(await verify(npmBump("1.0.0", "1.1.0", [evil], [b]))).toBe(false);
    // Every pinned hash must match, not just one of them.
    expect(await verify(npmBump("1.0.0", "1.1.0", [a], [b, evil]))).toBe(false);
  });

  test("a release without integrity, or not published, fails", async () => {
    const a = await sha512("1.0.0");
    await registry({ "1.0.0": a, "1.1.0": null });
    expect(await verify(npmBump("1.0.0", "1.1.0", [a], [await sha512("1.1.0")]))).toBe(false);
    expect(await verify(npmBump("1.0.0", "9.9.9", [a], [await sha512("9.9.9")]))).toBe(false);
  });

  test("a new package checks its one side", async () => {
    const b = await sha512("1.1.0");
    await registry({ "1.1.0": b });
    expect(await verify(npmBump(null, "1.1.0", null, [b]))).toBe(true);
    // A from version without hashes, or hashes without one, is malformed.
    expect(await verify(npmBump("1.0.0", "1.1.0", null, [b]))).toBe(false);
    expect(await verify(npmBump(null, "1.1.0", [b], [b]))).toBe(false);
    expect(await verify(npmBump(null, "1.1.0", null, []))).toBe(false);
  });

  test("no egress, no fetch", async () => {
    const fetchSpy = await registry({ "1.1.0": await sha512("1.1.0") });
    const bump = npmBump(null, "1.1.0", null, [await sha512("1.1.0")]);
    expect(await verify(bump, { NPM_REGISTRY: "https://npm.internal.example" })).toBe(false);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  test("a failed or missing read fails", async () => {
    const bump = npmBump(null, "1.1.0", null, [await sha512("1.1.0")]);
    stubRegistry(() => new Response("forbidden", { status: 403 }));
    expect(await verify(bump)).toBe(false);
    vi.restoreAllMocks();
    stubRegistry(() => new Response("not found", { status: 404 }));
    expect(await verify(bump)).toBe(false);
    vi.restoreAllMocks();
    stubRegistry(() => new Response("{", { headers: { "content-type": "application/json" } }));
    expect(await verify(bump)).toBe(false);
  });

  test("an invalid name or version, a non-mirror bump, or a remote one fails without a fetch", async () => {
    const fetchSpy = await registry({ "1.1.0": await sha512("1.1.0") });
    const hashes = [await sha512("1.1.0")];
    expect(await verify(npmBump(null, "1.1.0", null, hashes, "Left-Pad"))).toBe(false);
    expect(await verify(npmBump(null, "https://pkg.pr.new/left-pad@1", null, hashes))).toBe(false);
    const { mirror: _, ...plain } = npmBump(null, "1.1.0", null, hashes);
    expect(await verify(plain)).toBe(false);
    expect(await verify({ ...npmBump(null, "1.1.0", null, hashes), remoteSource: true })).toBe(
      false,
    );
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe("verifyMirrorBump: PyPI", () => {
  function pypiBump(
    fromVersion: string | null,
    toVersion: string,
    fromHashes: string[] | null,
    toHashes: string[],
  ): DependencyBump {
    return {
      ecosystem: "pypi",
      name: "requests",
      fromVersion,
      toVersion,
      direct: false,
      lockfilePath: "uv.lock",
      privateSource: true,
      mirror: { fromHashes, toHashes },
    };
  }

  async function pypi(releases: Record<string, string[]>) {
    const files = async (version: string, seeds: string[]) =>
      Promise.all(
        seeds.map(async (seed) => ({
          filename: `requests-${version}-${seed}.whl`,
          packagetype: "bdist_wheel",
          url: `https://files.pythonhosted.org/packages/${seed}.whl`,
          digests: { sha256: (await hex(seed)).toUpperCase() },
        })),
      );
    const body = JSON.stringify({
      info: { name: "requests", version: "2.32.0" },
      releases: Object.fromEntries(
        await Promise.all(
          Object.entries(releases).map(async ([version, seeds]) => [
            version,
            await files(version, seeds),
          ]),
        ),
      ),
    });
    return stubRegistry((url) =>
      url.host === "pypi.org" && url.pathname === "/pypi/requests/json"
        ? new Response(body, { headers: { "content-type": "application/json" } })
        : new Response("not found", { status: 404 }),
    );
  }
  const pin = async (seed: string) => `sha256:${await hex(seed)}`;

  test("every pinned file is among the release's files; a subset is enough", async () => {
    const fetchSpy = await pypi({ "2.31.0": ["a", "b"], "2.32.0": ["c", "d", "e"] });
    const bump = pypiBump("2.31.0", "2.32.0", [await pin("a")], [await pin("c"), await pin("e")]);
    expect(await verify(bump)).toBe(true);
    for (const [input, init] of fetchSpy.mock.calls) {
      const request = new Request(input as RequestInfo, init);
      expect(new URL(request.url).host).toBe("pypi.org");
      expect(request.headers.get("authorization")).toBeNull();
    }
  });

  test("a file the release does not list fails, on either side", async () => {
    await pypi({ "2.31.0": ["a"], "2.32.0": ["c"] });
    expect(
      await verify(
        pypiBump("2.31.0", "2.32.0", [await pin("a")], [await pin("c"), await pin("x")]),
      ),
    ).toBe(false);
    expect(await verify(pypiBump("2.31.0", "2.32.0", [await pin("c")], [await pin("c")]))).toBe(
      false,
    );
  });

  test("an empty pin list never matches", async () => {
    await pypi({ "2.32.0": ["c"] });
    expect(await verify(pypiBump(null, "2.32.0", null, []))).toBe(false);
  });

  test("a PEP 440 equivalent spelling resolves to the release", async () => {
    await pypi({ "2.0": ["a"], "2.1": ["b"] });
    expect(await verify(pypiBump("2.0.0", "2.1.0", [await pin("a")], [await pin("b")]))).toBe(true);
  });

  test("an unknown release fails", async () => {
    await pypi({ "2.31.0": ["a"] });
    expect(await verify(pypiBump(null, "9.0.0", null, [await pin("a")]))).toBe(false);
  });
});

describe("verifyPublicPin", () => {
  const pinned = (toVersion: string, pinnedHashes: string[]): DependencyBump => ({
    ecosystem: "npm",
    name: "left-pad",
    fromVersion: null,
    toVersion,
    direct: true,
    lockfilePath: "package-lock.json",
    repinned: true,
    pinnedHashes,
  });
  const check = (bump: DependencyBump, overrides: Partial<Cloudflare.Env> = {}) =>
    verify(bump, overrides, verifyPublicPin);
  async function registry(versions: Record<string, string>) {
    const body = await (await packument(versions)).text();
    return stubRegistry((url) =>
      url.host === "registry.npmjs.org" && url.pathname === "/left-pad"
        ? new Response(body, { headers: { "content-type": "application/json" } })
        : new Response("not found", { status: 404 }),
    );
  }

  test("the lockfile's pin is what the public registry published", async () => {
    const b = await sha512("1.1.0");
    const fetchSpy = await registry({ "1.1.0": b });
    expect(await check(pinned("1.1.0", [b]))).toBe(true);
    expect(
      await check({ ...pinned("1.1.0", [b]), fromVersion: "1.0.0", repinned: undefined }),
    ).toBe(true);
    for (const [input, init] of fetchSpy.mock.calls) {
      const request = new Request(input as RequestInfo, init);
      expect(new URL(request.url).host).toBe("registry.npmjs.org");
      expect(request.headers.get("authorization")).toBeNull();
    }
  });

  test("a pin the public registry did not publish fails", async () => {
    const b = await sha512("1.1.0");
    await registry({ "1.1.0": b });
    expect(await check(pinned("1.1.0", [await sha512("evil")]))).toBe(false);
    expect(await check(pinned("1.1.0", [b, await sha512("evil")]))).toBe(false);
    expect(await check(pinned("9.9.9", [b]))).toBe(false);
  });

  test("nothing to prove, or a bump that is not public, fails without a fetch", async () => {
    const b = await sha512("1.1.0");
    const fetchSpy = await registry({ "1.1.0": b });
    const { pinnedHashes: _, ...unpinned } = pinned("1.1.0", [b]);
    for (const bump of <DependencyBump[]>[
      unpinned,
      pinned("1.1.0", []),
      { ...pinned("1.1.0", [b]), privateSource: true },
      { ...pinned("1.1.0", [b]), privateSource: true, remoteSource: true },
      { ...pinned("1.1.0", [b]), mirror: { fromHashes: null, toHashes: [b] } },
      { ...pinned("1.1.0", [b]), name: "Left-Pad" },
    ]) {
      expect(await check(bump)).toBe(false);
    }
    expect(
      await check(pinned("1.1.0", [b]), { NPM_REGISTRY: "https://npm.internal.example" }),
    ).toBe(false);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  test("PyPI: every pinned sha256 is among the release's files", async () => {
    const body = JSON.stringify({
      info: { name: "requests", version: "2.32.0" },
      releases: {
        "2.32.0": await Promise.all(
          ["c", "d"].map(async (seed) => ({
            filename: `requests-2.32.0-${seed}.whl`,
            packagetype: "bdist_wheel",
            url: `https://files.pythonhosted.org/packages/${seed}.whl`,
            digests: { sha256: await hex(seed) },
          })),
        ),
      },
    });
    stubRegistry((url) =>
      url.host === "pypi.org" && url.pathname === "/pypi/requests/json"
        ? new Response(body, { headers: { "content-type": "application/json" } })
        : new Response("not found", { status: 404 }),
    );
    const bump = (): DependencyBump => ({
      ecosystem: "pypi",
      name: "requests",
      fromVersion: "2.31.0",
      toVersion: "2.32.0",
      direct: false,
      lockfilePath: "uv.lock",
      pinnedHashes: [],
    });
    const pin = async (seed: string) => `sha256:${await hex(seed)}`;
    expect(await check({ ...bump(), pinnedHashes: [await pin("c")] })).toBe(true);
    expect(await check({ ...bump(), pinnedHashes: [await pin("c"), await pin("x")] })).toBe(false);
  });
});

describe("packument integrity projection", () => {
  test("the streamed projection keeps integrity when asked, like the parsed one", async () => {
    const doc = {
      versions: {
        "1.0.0": { dist: { tarball: "t", integrity: await sha512("x") } },
        "1.1.0": { dist: { integrity: 7 } },
        "1.2.0": { dist: { integrity: "a", tarball: 1 } },
      },
    };
    const bytes = new TextEncoder().encode(JSON.stringify(doc));
    const withIntegrity = createPackumentExtractor({ integrityField: true });
    withIntegrity.write(bytes);
    expect(projectPackumentExtract(withIntegrity.end())).toEqual(projectRegistryMetadata(doc));
    const without = createPackumentExtractor();
    without.write(bytes);
    expect(projectPackumentExtract(without.end()).versions?.["1.0.0"]).toEqual({
      dist: { tarball: "t" },
      hasProvenance: false,
    });
  });
});
