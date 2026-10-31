import { afterEach, describe, expect, test, vi } from "vitest";
import { validateNpmCredential } from "../server/lib/ecosystems/npm/connection";
import {
  checkStagedPublishAccess,
  fetchStagedPublishDetails,
  listStagedPublishes,
} from "../server/lib/ecosystems/npm/staged-publishes";
import { fetchNpmVersionStatus } from "../server/lib/ecosystems/npm/version-status";
import { fetchPackageMetadata } from "../server/lib/ecosystems/npm/registry";
import { fetchPublishedTarballStream } from "../server/lib/ecosystems/npm/published-tarball";
import { createVerdaccioFake, verdaccioStage } from "./helpers/verdaccio-registry";

vi.mock("cloudflare:workers", () => ({ WorkerEntrypoint: class {} }));
const { evaluateNpmStageGatewayRequest } = await import("../server/lib/sandbox");

// Verdaccio is typically run behind a reverse proxy, often under a subpath.
const REGISTRY = "https://npm.example.test/verdaccio";
const TOKEN = "verdaccio-read-only-token-0123456789";
const STAGE_ID = "ac71d8df-f98f-442a-9aad-59f9ee6b878b";

function installFake(overrides: Partial<Parameters<typeof createVerdaccioFake>[0]> = {}) {
  const fake = createVerdaccioFake({
    registryUrl: REGISTRY,
    token: TOKEN,
    stages: [verdaccioStage({ id: STAGE_ID })],
    ...overrides,
  });
  vi.stubGlobal("fetch", vi.fn(fake.fetch));
  return fake;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Verdaccio staged publishing", () => {
  test("validates a read-only token, with Verdaccio's whole-body 200 for a ranged tarball probe", async () => {
    const fake = installFake();

    const validation = await validateNpmCredential(REGISTRY, TOKEN, { stageId: STAGE_ID });

    expect(validation).toMatchObject({
      ok: true,
      status: "valid",
      capabilities: {
        registryAuth: true,
        whoami: "alice",
        stagedListAccess: true,
        stagedViewAccess: true,
        stagedTarballAccess: true,
        stagedTarballStatus: 200,
        registryUrl: REGISTRY,
      },
    });
    expect(fake.requests.every((request) => request.authorization === `Bearer ${TOKEN}`)).toBe(
      true,
    );
  });

  test("a stage the token's user may not publish is a 404 that fails validation without reading as an auth failure", async () => {
    installFake({ hiddenStageIds: [STAGE_ID] });

    const validation = await validateNpmCredential(REGISTRY, TOKEN, { stageId: STAGE_ID });

    expect(validation.ok).toBe(false);
    expect(validation.capabilities).toMatchObject({
      registryAuth: true,
      stagedListAccess: true,
      stagedViewStatus: 404,
      stagedTarballStatus: 404,
    });
  });

  test("pages the zero-based list and reads Verdaccio's stage records", async () => {
    const stages = Array.from({ length: 3 }, (_, index) =>
      verdaccioStage({
        id: `00000000-0000-4000-8000-00000000000${index}`,
        packageName: "@drydock-test/bulk",
        version: `2.0.${index}`,
      }),
    );
    const fake = installFake({ stages });

    const first = await listStagedPublishes(REGISTRY, TOKEN, { perPage: 2 });
    const second = await listStagedPublishes(REGISTRY, TOKEN, { perPage: 2, page: 1 });

    expect(first).toMatchObject({ page: 0, perPage: 2, total: 3 });
    expect(second).toMatchObject({ page: 1, perPage: 2, total: 3 });
    expect([...first.items, ...second.items].map((item) => item.version)).toEqual([
      "2.0.0",
      "2.0.1",
      "2.0.2",
    ]);
    expect(first.items[0]).toEqual({
      id: stages[0].id,
      packageName: "@drydock-test/bulk",
      version: "2.0.0",
      tag: "latest",
      access: "public",
      actor: "bob",
      actorType: "user",
      createdAt: "2026-10-31T14:49:35.777Z",
      shasum: "3a3cd7e49d16f447f0e14a482d0c0e9bcc343457",
    });
    expect(fake.requests.map((request) => new URL(request.url).pathname)).toEqual([
      "/verdaccio/-/stage",
      "/verdaccio/-/stage",
    ]);
  });

  test("reads the stage detail, which carries no manifest, so the tarball stays the manifest source", async () => {
    installFake();

    const details = await fetchStagedPublishDetails(REGISTRY, TOKEN, STAGE_ID);

    expect(details).toMatchObject({
      id: STAGE_ID,
      packageName: "drydock-verd-demo",
      version: "1.1.0",
      shasum: "3a3cd7e49d16f447f0e14a482d0c0e9bcc343457",
      packageJson: null,
    });
  });

  test("a stage approved or rejected after listing is skipped, not admitted", async () => {
    installFake({ vanishedStageIds: [STAGE_ID] });

    await expect(checkStagedPublishAccess(REGISTRY, TOKEN, STAGE_ID)).resolves.toMatchObject({
      allowed: false,
      status: 404,
    });
  });

  test("Verdaccio's version status only says staged or published; a rejected stage stays unknown", async () => {
    installFake({
      stages: [verdaccioStage({ id: STAGE_ID, version: "1.2.0" })],
      published: { "drydock-verd-demo": ["1.1.0"] },
    });

    await expect(
      fetchNpmVersionStatus(REGISTRY, TOKEN, "drydock-verd-demo", "1.1.0"),
    ).resolves.toEqual({ ok: true, status: "published" });
    await expect(
      fetchNpmVersionStatus(REGISTRY, TOKEN, "drydock-verd-demo", "1.2.0"),
    ).resolves.toEqual({ ok: true, status: "staged" });
    // Rejecting deletes the stage record; Verdaccio has no `deleted` status.
    await expect(
      fetchNpmVersionStatus(REGISTRY, TOKEN, "drydock-verd-demo", "1.3.0"),
    ).resolves.toEqual({ ok: false, reason: "not_found", httpStatus: 404 });
  });

  test("the stage gateway credentials only registry endpoints below the base path", () => {
    const tarball = `${REGISTRY}/-/stage/${STAGE_ID}/tarball`;
    for (const registry of [REGISTRY, `${REGISTRY}/`]) {
      expect(evaluateNpmStageGatewayRequest(tarball, "GET", registry)).toEqual({
        allowed: true,
        credentialed: true,
        kind: "staged-tarball",
      });
      expect(
        evaluateNpmStageGatewayRequest(`${REGISTRY}/@drydock-test%2fpkg`, "GET", registry),
      ).toEqual({ allowed: true, credentialed: true, kind: "package-metadata" });
    }
    for (const url of [
      "https://npm.example.test/@drydock-test%2fpkg",
      "https://npm.example.test/verdaccio",
      `https://npm.example.test/-/stage/${STAGE_ID}/tarball`,
      `https://npm.example.test/other/-/stage/${STAGE_ID}/tarball`,
      `https://npm.example.test/verdaccio-evil/-/stage/${STAGE_ID}/tarball`,
      `https://npm.example.test/verdaccio/../-/stage/${STAGE_ID}/tarball`,
      `https://npm.example.test:8443/verdaccio/-/stage/${STAGE_ID}/tarball`,
      `http://npm.example.test/verdaccio/-/stage/${STAGE_ID}/tarball`,
      `https://attacker.example/verdaccio/-/stage/${STAGE_ID}/tarball`,
    ]) {
      expect(evaluateNpmStageGatewayRequest(url, "GET", REGISTRY)).toEqual({
        allowed: false,
        credentialed: false,
        kind: "blocked",
      });
    }
  });

  test("the stage gateway refuses traversal the URL parser leaves encoded", () => {
    for (const registry of [REGISTRY, "https://npm.example.test"]) {
      for (const path of [
        "/-/stage/..%2f..%2f..%2f..%2fadmin/tarball",
        "/-/stage/..%5c..%5cadmin/tarball",
        "/-/stage/..;/admin/tarball",
        "/-/stage/%252e%252e%252fadmin/tarball",
        `/-/stage/${STAGE_ID}%2f..%2f..%2fadmin/tarball`,
        `/-/stage/${STAGE_ID}/..%2f..%2fadmin/tarball`,
        "/..%2f..%2fadmin",
        "/..%5cadmin",
        "/..;",
        "/%252e%252e",
        "/@scope%2f..%2fadmin",
        // No dot segment, but not a stage tarball or a package name either.
        `/-/stage/${STAGE_ID}/extra/tarball`,
        "/-/stage/admin%2fsecrets/tarball",
        "/_admin",
        "/pkg%3Fx",
      ]) {
        expect(
          evaluateNpmStageGatewayRequest(`${registry}${path}`, "GET", registry),
          `${registry}${path}`,
        ).toEqual({ allowed: false, credentialed: false, kind: "blocked" });
      }
    }
  });

  test("no credentialed registry read follows a same-origin redirect out of the base path with the token", async () => {
    let adminHits = 0;
    const leaked: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async function respond(
        input: RequestInfo | URL,
        init?: RequestInit,
      ): Promise<Response> {
        const request = new Request(input, init);
        const url = new URL(request.url);
        if (url.pathname.startsWith("/admin/")) {
          adminHits++;
          if (request.headers.get("authorization")) leaked.push(url.pathname);
          return new Response("{}", { status: 404 });
        }
        // Models workerd's default `follow`, which keeps Authorization on a
        // same-origin hop: for a registry under a path, the rest of its origin.
        if (request.redirect === "follow") {
          return respond(new URL("/admin/y", url), { headers: request.headers });
        }
        return new Response(null, { status: 302, headers: { location: "/admin/y" } });
      }),
    );

    await validateNpmCredential(REGISTRY, TOKEN, { stageId: STAGE_ID });
    await listStagedPublishes(REGISTRY, TOKEN).catch(() => null);
    await fetchStagedPublishDetails(REGISTRY, TOKEN, STAGE_ID).catch(() => null);
    await checkStagedPublishAccess(REGISTRY, TOKEN, STAGE_ID);
    await fetchNpmVersionStatus(REGISTRY, TOKEN, "drydock-verd-demo", "1.1.0");
    await fetchPackageMetadata({} as Cloudflare.Env, "drydock-verd-demo", {
      npmRegistry: REGISTRY,
      npmToken: TOKEN,
    }).catch(() => null);
    await fetchPublishedTarballStream(
      `${REGISTRY}/drydock-verd-demo/-/drydock-verd-demo-1.1.0.tgz`,
      {
        registryUrl: REGISTRY,
        npmToken: TOKEN,
      },
    ).catch(() => null);

    // Every read above reached the redirect target, so none passed vacuously.
    expect(adminHits).toBeGreaterThanOrEqual(10);
    expect(leaked).toEqual([]);
  });
});
