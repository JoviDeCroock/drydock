import { env, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { afterEach, expect, test, vi } from "vitest";
import { createDb } from "../../server/db/client";
import {
  updateNpmConnectionValidation,
  upsertNpmConnection,
} from "../../server/db/npm-connections";
import { listScans } from "../../server/db/scans";
import { encryptNpmToken } from "../../server/lib/ecosystems/npm/connection";
import type { QueueMessage } from "../../server/lib/scan/job";
import { stagedPublishesRoutes } from "../../server/routes/staged-publishes";
import type { Bindings } from "../../server/types";
import { createVerdaccioFake, verdaccioStage } from "../helpers/verdaccio-registry";
import { buildTestApp } from "./helpers/app";
import { seedUser } from "./helpers/seed";

const REGISTRY = "https://npm.example.test/verdaccio";
const TOKEN = "verdaccio-read-only-token-0123456789";

afterEach(() => {
  vi.unstubAllGlobals();
});

test("Check npm discovers every page of a path-prefixed Verdaccio and skips a stage that vanished after listing", async () => {
  const owner = await seedUser();
  const db = createDb(env.DB);
  await upsertNpmConnection(db, {
    organizationId: owner.organizationId,
    registryUrl: REGISTRY,
    label: "Verdaccio",
    createdByUserId: owner.userId,
    ...(await encryptNpmToken(env, TOKEN)),
  });
  await updateNpmConnectionValidation(db, {
    organizationId: owner.organizationId,
    validationStatus: "valid",
    validatedAt: new Date(),
  });
  // Discovery asks for 50 per page; Verdaccio pages from zero, so the 51st
  // stage is only reachable through `page=1`.
  const stages = Array.from({ length: 51 }, (_, index) =>
    verdaccioStage({
      id: `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
      packageName: `@drydock-test/pkg-${index}`,
      version: "1.0.0",
    }),
  );
  const vanished = stages[1].id;
  const fake = createVerdaccioFake({
    registryUrl: REGISTRY,
    token: TOKEN,
    stages,
    vanishedStageIds: [vanished],
  });
  vi.stubGlobal("fetch", vi.fn(fake.fetch));
  const queue = { send: vi.fn(async (_message: QueueMessage) => undefined) };
  const app = buildTestApp((root) => {
    root.route("/api/v1/staged-publishes", stagedPublishesRoutes);
  }, owner);

  const ctx = createExecutionContext();
  const res = await app.fetch(
    new Request("http://test.local/api/v1/staged-publishes/scan", { method: "POST" }),
    { ...env, SCAN_QUEUE: queue } as unknown as Bindings,
    ctx,
  );
  await waitOnExecutionContext(ctx);

  expect(res.status).toBe(202);
  expect(await res.json()).toMatchObject({ found: 51, created: 50, skipped: 1 });
  const listPages = fake.requests
    .map((request) => new URL(request.url))
    .filter((url) => url.pathname === "/verdaccio/-/stage")
    .map((url) => url.searchParams.get("page"));
  expect(listPages).toEqual([null, "1"]);
  expect(queue.send).toHaveBeenCalledTimes(50);
  const { scans } = await listScans(db, owner.organizationId, { limit: 100 });
  expect(scans.map((scan) => scan.stageId)).not.toContain(vanished);
  expect(scans.find((scan) => scan.stageId === stages[50].id)).toMatchObject({
    packageName: "@drydock-test/pkg-50",
    stagedVersion: "1.0.0",
  });
  // Every credentialed request stayed on the connection's own registry path.
  expect(
    fake.requests.every(
      (request) =>
        request.url.startsWith(`${REGISTRY}/`) && request.authorization === `Bearer ${TOKEN}`,
    ),
  ).toBe(true);
});
