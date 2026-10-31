import { env } from "cloudflare:test";
import { afterEach, describe, expect, test, vi } from "vitest";
import {
  upsertNpmConnection,
  updateNpmConnectionValidation,
} from "../../server/db/npm-connections";
import { encryptNpmToken } from "../../server/lib/ecosystems/npm/connection";
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

async function readiness(owner: SeededUser, scanId: string) {
  const res = await call(
    buildTestApp(mountScans, owner),
    "GET",
    `/api/v1/scans/${scanId}/dependency-readiness`,
  );
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
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
