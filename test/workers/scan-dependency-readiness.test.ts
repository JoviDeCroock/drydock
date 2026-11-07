import { createExecutionContext, env } from "cloudflare:test";
import { afterEach, describe, expect, test, vi } from "vitest";
import {
  upsertNpmConnection,
  updateNpmConnectionValidation,
} from "../../server/db/npm-connections";
import { computeCompareMetadataCacheKey } from "../../server/lib/compare-cache";
import { createNpmBroker } from "../../server/lib/ecosystems/npm/broker";
import { encryptNpmToken } from "../../server/lib/ecosystems/npm/connection";
import { fetchPackageVersionsMany } from "../../server/lib/ecosystems/npm/package-versions";
import type { AdapterContext } from "../../server/lib/ecosystems/package-adapter";
import { scansRoutes } from "../../server/routes/scans";
import { buildTestApp, call, type TestApp } from "./helpers/app";
import { type SeededUser, seedCompletedScan, seedUser, seedWorkflowGate } from "./helpers/seed";

const REGISTRY = "https://registry.npmjs.org";
const TOKEN = "npm_dependency_readiness_token_AAAA";
const mountScans = (app: TestApp) => app.route("/api/v1/scans", scansRoutes);

interface RegistryCall {
  url: string;
  authorization: string | null;
}

// Packuments keyed by package name, stage records keyed by stage id; anything
// else answers 404 like npm does.
function stubRegistry(
  packuments: Record<string, unknown>,
  options: { failFor?: string[]; stages?: Record<string, unknown> } = {},
) {
  const calls: RegistryCall[] = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const request = new Request(input as RequestInfo, init as RequestInit);
    calls.push({ url: request.url, authorization: request.headers.get("authorization") });
    const name = decodeURIComponent(new URL(request.url).pathname.slice(1));
    if (options.failFor?.includes(name)) return new Response("unavailable", { status: 503 });
    const stage = name.startsWith("-/stage/") ? options.stages?.[name.slice(8)] : undefined;
    const body = stage ?? packuments[name];
    if (!body) return new Response("not found", { status: 404 });
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  });
  return calls;
}

// Raw packument responses by package name, for bodies JSON cannot describe:
// declared lengths, streams that stall or never end. Stage records are 404.
function stubRawRegistry(
  respond: (name: string, signal?: AbortSignal | null) => Response | Promise<Response>,
) {
  const names: string[] = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const request = new Request(input as RequestInfo, init as RequestInit);
    const name = decodeURIComponent(new URL(request.url).pathname.slice(1));
    if (name.startsWith("-/stage/")) return new Response("not found", { status: 404 });
    names.push(name);
    return respond(name, (init as RequestInit | undefined)?.signal);
  });
  return names;
}

// A body that sends `head` and then never another byte.
function stalledBody(head = '{"versions":{') {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(head));
    },
  });
}

function packument(versions: string[], latest = versions.at(-1)) {
  return {
    "dist-tags": latest ? { latest } : {},
    versions: Object.fromEntries(versions.map((v) => [v, { dist: { tarball: `${REGISTRY}/x` } }])),
  };
}

async function seedConnection(owner: SeededUser, registryUrl = REGISTRY) {
  const encrypted = await encryptNpmToken(env, TOKEN);
  await upsertNpmConnection(owner.db, {
    organizationId: owner.organizationId,
    registryUrl,
    label: "test registry",
    createdByUserId: owner.userId,
    ...encrypted,
  });
  await updateNpmConnectionValidation(owner.db, {
    organizationId: owner.organizationId,
    validationStatus: "valid",
  });
}

function seedStagedScan(
  owner: SeededUser,
  name: string,
  version: string,
  manifest: Record<string, unknown> = {},
  stageId?: string,
) {
  return seedCompletedScan(owner, {
    ...(stageId ? { stageId } : {}),
    packageJson: { name, version, ...manifest },
    job: {
      source: "auto_discovery",
      registryUrl: REGISTRY,
      packageName: name,
      stagedVersion: version,
    },
  });
}

async function readiness(
  owner: SeededUser,
  scanId: string,
  options: { kv?: KVNamespace; query?: string } = {},
) {
  const res = await call(
    buildTestApp(mountScans, owner),
    "GET",
    `/api/v1/scans/${scanId}/dependency-readiness${options.query ?? ""}`,
    options.kv ? { envOverride: { COMPARE_CACHE: options.kv } } : {},
  );
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

// In-memory COMPARE_CACHE (unbound in tests), keyed exactly as production.
function fakeKv() {
  const store = new Map<string, string>();
  const binding = {
    async get(key: string, options?: { type?: string }) {
      const raw = store.get(key);
      if (raw === undefined) return null;
      return options?.type === "json" ? JSON.parse(raw) : raw;
    },
    async put(key: string, value: string) {
      store.set(key, value);
    },
  } as unknown as KVNamespace;
  const versionsKey = (scope: string, name: string) =>
    computeCompareMetadataCacheKey({
      registryUrl: REGISTRY,
      packageName: name,
      cacheScope: `${scope}|versions`,
    });
  return {
    store,
    binding,
    async seed(scope: string, name: string, value: unknown) {
      store.set(await versionsKey(scope, name), JSON.stringify(value));
    },
    async read(scope: string, name: string) {
      const raw = store.get(await versionsKey(scope, name));
      return raw === undefined ? undefined : JSON.parse(raw);
    },
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("GET /api/v1/scans/:id/dependency-readiness", () => {
  test("names the organization's own staged dependency to approve first", async () => {
    const owner = await seedUser();
    await seedConnection(owner);
    const stagedB = await seedStagedScan(owner, "b", "2.0.0");
    const scanId = await seedStagedScan(owner, "a", "2.0.0", {
      dependencies: { b: "^2.0.0", c: "^1.0.0" },
    });
    const calls = stubRegistry({ b: packument(["1.0.0"]), c: packument(["1.2.0"]) });

    const { status, body } = await readiness(owner, scanId);

    expect(status).toBe(200);
    expect(body).toMatchObject({
      status: "checked",
      declared: 2,
      notRegistry: 0,
      credentialed: true,
    });
    expect(body.issues).toEqual([
      {
        name: "b",
        spec: "^2.0.0",
        section: "dependencies",
        kind: "staged",
        staged: { scanId: stagedB, version: "2.0.0", decision: null, registryVersionStatus: null },
      },
    ]);
    // Packument reads only, on the captured registry, with the org's credential.
    expect(calls.length).toBeGreaterThan(0);
    for (const registryCall of calls) {
      expect(registryCall.url.startsWith(`${REGISTRY}/`)).toBe(true);
      expect(registryCall.authorization).toBe(`Bearer ${TOKEN}`);
    }
  });

  test("checks the manifest npm will install from: the stage record, not the tarball", async () => {
    const owner = await seedUser();
    await seedConnection(owner);
    const stageId = "stage-readiness-a-200";
    const scanId = await seedStagedScan(
      owner,
      "a",
      "2.0.0",
      { dependencies: { b: "^2.0.0" } },
      stageId,
    );
    const calls = stubRegistry(
      { d: packument(["0.9.0"]) },
      {
        stages: {
          [stageId]: {
            id: stageId,
            packageName: "a",
            version: "2.0.0",
            manifest: { name: "a", version: "2.0.0", dependencies: { d: "^1.0.0" } },
          },
        },
      },
    );

    const { body } = await readiness(owner, scanId);

    expect(body.issues).toEqual([
      expect.objectContaining({ name: "d", kind: "unpublished", packageFound: true }),
    ]);
    expect(calls.map((c) => c.url)).not.toContain(`${REGISTRY}/b`);
    for (const registryCall of calls) {
      expect(registryCall.authorization).toBe(`Bearer ${TOKEN}`);
    }
  });

  test("a staged review without a usable connection says it could not check", async () => {
    const owner = await seedUser();
    const scanId = await seedStagedScan(owner, "a", "2.0.0", { dependencies: { b: "^2.0.0" } });
    const calls = stubRegistry({});

    const { body } = await readiness(owner, scanId);

    expect(body).toEqual({ status: "unavailable", reason: "npm-connection-unavailable" });
    expect(calls).toEqual([]);
  });

  test("never offers another organization's stage", async () => {
    const owner = await seedUser();
    const other = await seedUser();
    await seedConnection(owner);
    await seedStagedScan(other, "b", "2.0.0");
    const scanId = await seedStagedScan(owner, "a", "2.0.0", { dependencies: { b: "^2.0.0" } });
    stubRegistry({ b: packument(["1.0.0"]) });

    const { body } = await readiness(owner, scanId);

    expect(body.issues).toEqual([
      expect.objectContaining({ name: "b", kind: "unpublished", packageFound: true }),
    ]);
  });

  test("a registry failure reads as could-not-check, not as a missing dependency", async () => {
    const owner = await seedUser();
    await seedConnection(owner);
    const scanId = await seedStagedScan(owner, "a", "2.0.0", { dependencies: { b: "^2.0.0" } });
    stubRegistry({}, { failFor: ["b"] });

    const { status, body } = await readiness(owner, scanId);

    expect(status).toBe(200);
    expect(body.issues).toEqual([
      expect.objectContaining({ name: "b", kind: "unchecked", reason: "lookup-failed" }),
    ]);
  });

  test("a staged review fails closed when the npm connection now points elsewhere", async () => {
    const owner = await seedUser();
    await seedConnection(owner, "https://npm.example.com");
    const scanId = await seedStagedScan(owner, "a", "2.0.0", { dependencies: { b: "^2.0.0" } });
    const calls = stubRegistry({ b: packument(["2.0.0"]) });

    const { body } = await readiness(owner, scanId);

    expect(body).toEqual({ status: "unavailable", reason: "npm-connection-changed" });
    expect(calls).toEqual([]);
  });

  test("a gated release's packages satisfy each other; without a connection reads are anonymous", async () => {
    const owner = await seedUser();
    const gateId = await seedWorkflowGate(owner, { decision: null });
    const gateSummary = {
      diff: [],
      stagedPublish: { mode: "workflow_gate", provenance: { ecosystem: "npm" } },
    };
    const gateScan = (name: string, version: string, manifest: Record<string, unknown> = {}) =>
      seedCompletedScan(owner, {
        packageJson: { name, version, ...manifest },
        summary: gateSummary,
        job: { source: "workflow_gate", gateId, packageName: name, stagedVersion: version },
      });
    await gateScan("b", "2.0.0");
    const scanId = await gateScan("a", "2.0.0", {
      dependencies: { b: "^2.0.0", c: "^3.0.0" },
    });
    const calls = stubRegistry({ c: packument(["2.9.0"]) });

    const { body } = await readiness(owner, scanId);

    expect(body).toMatchObject({ status: "checked", satisfiedByRelease: 1, credentialed: false });
    expect(body.issues).toEqual([
      expect.objectContaining({ name: "c", kind: "unpublished", packageFound: true }),
    ]);
    // One read: a cache miss is read once, never re-read as a revalidation.
    expect(calls.map((registryCall) => registryCall.url)).toEqual([`${REGISTRY}/c`]);
    expect(calls.every((registryCall) => registryCall.authorization === null)).toBe(true);
  });

  test("a credentialed cache hit in the organization's partition skips the registry", async () => {
    const owner = await seedUser();
    await seedConnection(owner);
    const scanId = await seedStagedScan(owner, "a", "2.0.0", { dependencies: { b: "^2.0.0" } });
    const kv = fakeKv();
    await kv.seed(`org:${owner.organizationId}`, "b", {
      status: "found",
      versions: ["2.1.0"],
      distTags: { latest: "2.1.0" },
    });
    // Another partition's answer must not be read for this organization.
    await kv.seed("public", "b", { status: "found", versions: ["1.0.0"], distTags: {} });
    const calls = stubRegistry({ b: packument(["1.0.0"]) });

    // A malformed resume offset is clamped, never an error.
    const { status, body } = await readiness(owner, scanId, {
      kv: kv.binding,
      query: "?offset=zz",
    });

    expect(status).toBe(200);
    expect(body).toMatchObject({ status: "checked", issues: [] });
    expect(calls.map((c) => c.url)).not.toContain(`${REGISTRY}/b`);
  });

  test("an anonymous gate review reads and writes only the public partition", async () => {
    const owner = await seedUser();
    const gateId = await seedWorkflowGate(owner, { decision: null });
    const scanId = await seedCompletedScan(owner, {
      packageJson: { name: "a", version: "2.0.0", dependencies: { c: "^3.0.0", d: "^1.0.0" } },
      summary: {
        diff: [],
        stagedPublish: { mode: "workflow_gate", provenance: { ecosystem: "npm" } },
      },
      job: { source: "workflow_gate", gateId, packageName: "a", stagedVersion: "2.0.0" },
    });
    const kv = fakeKv();
    await kv.seed("public", "c", { status: "found", versions: ["2.0.0"], distTags: {} });
    await kv.seed(`org:${owner.organizationId}`, "c", {
      status: "found",
      versions: ["3.0.0"],
      distTags: {},
    });
    const calls = stubRegistry({ d: packument(["1.0.0"]) });

    const { body } = await readiness(owner, scanId, { kv: kv.binding });

    // The public answer (no 3.x) is the one used; the org's is never read.
    expect(body).toMatchObject({ credentialed: false });
    expect(body.issues).toEqual([expect.objectContaining({ name: "c", kind: "unpublished" })]);
    // `c` was revalidated with leftover budget, `d` read once; both anonymously.
    expect(calls.every((c) => c.authorization === null)).toBe(true);
    expect(await kv.read("public", "d")).toMatchObject({ status: "found", versions: ["1.0.0"] });
    expect(await kv.read(`org:${owner.organizationId}`, "d")).toBeUndefined();
  });

  test("a packument larger than a few MiB is streamed and checked", async () => {
    const owner = await seedUser();
    await seedConnection(owner);
    const scanId = await seedStagedScan(owner, "a", "2.0.0", {
      peerDependencies: { typescript: "^5.9.0" },
    });
    // ~9 MB, like typescript's abbreviated packument: thousands of versions.
    const versions = Array.from({ length: 3_000 }, (_, i) => `5.${Math.floor(i / 100)}.${i % 100}`);
    const big = {
      "dist-tags": { latest: "5.29.99" },
      versions: Object.fromEntries(
        versions.map((v) => [
          v,
          { dist: { tarball: `${REGISTRY}/x` }, description: "d".repeat(3_000) },
        ]),
      ),
    };
    expect(JSON.stringify(big).length).toBeGreaterThan(8 * 1024 * 1024);
    stubRegistry({ typescript: big });

    const { body } = await readiness(owner, scanId, { kv: fakeKv().binding });

    expect(body).toMatchObject({ status: "checked", issues: [] });
  });

  test("a packument past the check's limit is too large to check: no retry, cached", async () => {
    const owner = await seedUser();
    await seedConnection(owner);
    const scanId = await seedStagedScan(owner, "a", "2.0.0", { dependencies: { huge: "^1.0.0" } });
    const versions = Object.fromEntries(
      Array.from({ length: 100_001 }, (_, i) => [`0.0.${i}`, {}]),
    );
    const calls = stubRegistry({ huge: { "dist-tags": {}, versions } });
    const kv = fakeKv();
    const failures = vi.spyOn(console, "warn");

    const first = await readiness(owner, scanId, { kv: kv.binding });

    expect(first.body.issues).toEqual([
      expect.objectContaining({ name: "huge", kind: "unchecked", reason: "too-large" }),
    ]);
    expect(first.body.nextOffset).toBeUndefined();
    expect(JSON.stringify(failures.mock.calls)).not.toContain("lookup_failed");
    expect(await kv.read(`org:${owner.organizationId}`, "huge")).toEqual({ status: "too-large" });

    const reads = calls.filter((c) => c.url === `${REGISTRY}/huge`).length;
    await readiness(owner, scanId, { kv: kv.binding });
    expect(calls.filter((c) => c.url === `${REGISTRY}/huge`)).toHaveLength(reads);
  });

  test("a declared body past the ceiling is too large without reading it", async () => {
    const owner = await seedUser();
    await seedConnection(owner);
    const scanId = await seedStagedScan(owner, "a", "2.0.0", { dependencies: { huge: "^1.0.0" } });
    // The body never ends: only the declared length can answer before the budget.
    stubRawRegistry(
      () =>
        new Response(stalledBody(), {
          headers: { "content-length": String(64 * 1024 * 1024 + 1) },
        }),
    );

    const { body } = await readiness(owner, scanId, { kv: fakeKv().binding });

    expect(body.issues).toEqual([
      expect.objectContaining({ name: "huge", kind: "unchecked", reason: "too-large" }),
    ]);
  });

  test("a streamed body past the ceiling is too large, with no length declared", async () => {
    const owner = await seedUser();
    await seedConnection(owner);
    const scanId = await seedStagedScan(owner, "a", "2.0.0", { dependencies: { huge: "^1.0.0" } });
    const encoder = new TextEncoder();
    const mib = new Uint8Array(1024 * 1024).fill(0x78);
    // A valid packument whose readme alone is past 64 MiB.
    stubRawRegistry(() => {
      let sent = 0;
      return new Response(
        new ReadableStream<Uint8Array>({
          pull(controller) {
            if (sent === 0) {
              controller.enqueue(encoder.encode('{"versions":{"1.0.0":{}},"readme":"'));
            }
            if (sent === 65) {
              controller.enqueue(encoder.encode('"}'));
              controller.close();
              return;
            }
            sent += 1;
            controller.enqueue(mib);
          },
        }),
      );
    });

    const { body } = await readiness(owner, scanId, { kv: fakeKv().binding });

    expect(body.issues).toEqual([
      expect.objectContaining({ name: "huge", kind: "unchecked", reason: "too-large" }),
    ]);
  });

  test("the client's offset decides where the registry reads start", async () => {
    const owner = await seedUser();
    await seedConnection(owner);
    const names = Array.from({ length: 45 }, (_, i) => `d${String(i).padStart(2, "0")}`);
    const scanId = await seedStagedScan(owner, "a", "2.0.0", {
      dependencies: Object.fromEntries(names.map((name) => [name, "^1.0.0"])),
    });
    const calls = stubRegistry(
      Object.fromEntries(names.map((name) => [name, packument(["1.0.0"])])),
    );
    const read = () =>
      calls
        .map((c) => decodeURIComponent(new URL(c.url).pathname.slice(1)))
        .filter((name) => !name.startsWith("-/stage/"));

    const first = await readiness(owner, scanId);
    expect(first.body.nextOffset).toBe(40);
    expect(read().sort()).toEqual(names.slice(0, 40));

    calls.length = 0;
    const resumed = await readiness(owner, scanId, { query: "?offset=40" });
    expect(read().sort()).toEqual([...names.slice(0, 35), ...names.slice(40)]);
    expect(resumed.body.nextOffset).toBe(35);
  });

  test("published-pair reviews are not applicable", async () => {
    const owner = await seedUser();
    const scanId = await seedCompletedScan(owner, {
      packageJson: { name: "a", version: "2.0.0", dependencies: { b: "^2.0.0" } },
      job: { source: "published" },
    });
    const calls = stubRegistry({});

    const { body } = await readiness(owner, scanId);

    expect(body).toEqual({ status: "not-applicable" });
    expect(calls).toEqual([]);
  });

  test("is organization-scoped: another organization's scan id is a 404", async () => {
    const owner = await seedUser();
    const intruder = await seedUser();
    const scanId = await seedStagedScan(owner, "a", "2.0.0", { dependencies: { b: "^2.0.0" } });
    const calls = stubRegistry({});

    const { status } = await readiness(intruder, scanId);

    expect(status).toBe(404);
    expect(calls).toEqual([]);
  });
});

describe("fetchPackageVersionsMany", () => {
  const source = { registryUrl: REGISTRY, cacheScope: "public" };

  test("a read that stalls in its body or its headers is abandoned at the budget", async () => {
    stubRawRegistry((name, signal) =>
      name === "body"
        ? new Response(stalledBody())
        : new Promise<Response>((_, reject) => {
            signal?.addEventListener("abort", () => reject(signal.reason));
          }),
    );
    const started = Date.now();

    const results = await fetchPackageVersionsMany(
      env,
      createExecutionContext(),
      source,
      ["body", "headers"],
      { concurrency: 2, budgetMs: 200 },
    );

    expect(Date.now() - started).toBeLessThan(5_000);
    expect(results.sort((a, b) => a.name.localeCompare(b.name))).toEqual([
      { name: "body", lookup: { status: "error" } },
      { name: "headers", lookup: { status: "error" } },
    ]);
  });

  test("a packument without versions has none published; a non-object one is unreadable", async () => {
    stubRawRegistry(
      (name) => new Response(name === "empty" ? '{"name":"empty"}' : '{"versions":"x"}'),
    );

    const results = await fetchPackageVersionsMany(
      env,
      createExecutionContext(),
      source,
      ["empty", "odd"],
      { concurrency: 1, budgetMs: 5_000 },
    );

    expect(results).toEqual([
      { name: "empty", lookup: { status: "found", versions: [], distTags: {} } },
      { name: "odd", lookup: { status: "error" } },
    ]);
  });
});

describe("npm broker fetchPackageVersionsBatch", () => {
  test("a credential that cannot be resolved fails every name, reading nothing", async () => {
    const owner = await seedUser();
    const names = stubRawRegistry(() => new Response("{}"));
    const broker = createNpmBroker(
      { env, executionCtx: createExecutionContext(), db: owner.db } as unknown as AdapterContext,
      { organizationId: owner.organizationId, registryUrl: REGISTRY },
    );

    const results = await broker.fetchPackageVersionsBatch(["a", "b"], {
      concurrency: 2,
      budgetMs: 5_000,
    });

    expect(results).toEqual([
      { name: "a", lookup: { status: "error" } },
      { name: "b", lookup: { status: "error" } },
    ]);
    expect(names).toEqual([]);
  });
});
