import { env } from "cloudflare:test";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { createDb } from "../../server/db/client";
import {
  updateNpmConnectionValidation,
  upsertNpmConnection,
} from "../../server/db/npm-connections";
import { ensurePersonalOrganization } from "../../server/db/organizations";
import { createScanJob, persistScan, recordScanDecision } from "../../server/db/scans";
import * as schema from "../../server/db/schema";
import { encryptNpmToken } from "../../server/lib/ecosystems/npm/connection";
import { resolveNpmReleaseOutcomes } from "../../server/lib/ecosystems/npm/release-outcome";
import { refineStagedFailure } from "../../server/lib/scan/job";

const REGISTRY_URL = "https://registry.npmjs.org";
const TOKEN = "npm_test_token_0123456789";
const PACKAGE = "@drydock/example";
const VERSION = "1.4.0";

interface Seeded {
  organizationId: string;
  userId: string;
}

async function seedOrg(): Promise<Seeded> {
  const db = createDb(env.DB);
  const now = new Date();
  const userId = `user_${crypto.randomUUID()}`;
  await db.insert(schema.user).values({
    id: userId,
    name: "Registry Status Tester",
    email: `${userId}@example.com`,
    emailVerified: true,
    createdAt: now,
    updatedAt: now,
  });
  const organizationId = await ensurePersonalOrganization(db, { userId });
  const encrypted = await encryptNpmToken(env, TOKEN);
  await upsertNpmConnection(db, {
    organizationId,
    registryUrl: REGISTRY_URL,
    label: "npm registry",
    createdByUserId: userId,
    ...encrypted,
  });
  await updateNpmConnectionValidation(db, {
    organizationId,
    validationStatus: "valid",
    validatedAt: now,
  });
  return { organizationId, userId };
}

/** A completed review, which is the only kind the sweep asks npm about. */
async function seedCompletedScan(
  org: Seeded,
  overrides: { stageId?: string; version?: string; createdAt?: Date } = {},
) {
  const db = createDb(env.DB);
  const scanId = crypto.randomUUID();
  const stageId = overrides.stageId ?? `stage-${scanId.slice(0, 8)}`;
  await createScanJob(db, {
    id: scanId,
    stageId,
    organizationId: org.organizationId,
    ownerUserId: org.userId,
    packageName: PACKAGE,
    stagedVersion: overrides.version ?? VERSION,
  });
  await persistScan(db, {
    id: scanId,
    stageId,
    organizationId: org.organizationId,
    ownerUserId: org.userId,
    packageJson: { name: PACKAGE, version: overrides.version ?? VERSION },
    risk: "low",
    status: "complete",
    summary: { diff: [] },
    ai: null,
    files: [],
    diff: [],
    findings: [],
  });
  if (overrides.createdAt) {
    await db
      .update(schema.scans)
      .set({ createdAt: overrides.createdAt })
      .where(eq(schema.scans.id, scanId));
  }
  return { scanId, stageId };
}

async function readScan(scanId: string) {
  const rows = await createDb(env.DB)
    .select()
    .from(schema.scans)
    .where(eq(schema.scans.id, scanId))
    .limit(1);
  return rows[0]!;
}

function stubRegistry(handler: (url: string) => Response) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL) =>
    handler(typeof input === "string" ? input : input instanceof URL ? input.href : input.url),
  );
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function statusResponse(status: string) {
  return new Response(JSON.stringify({ packageName: PACKAGE, version: VERSION, status }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

describe("registry version status resolution", () => {
  beforeEach(async () => {
    const db = createDb(env.DB);
    await db.delete(schema.scans);
    await db.delete(schema.npmConnections);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  test("records npm's status against the reviewed release", async () => {
    const org = await seedOrg();
    const { scanId } = await seedCompletedScan(org);
    stubRegistry(() => statusResponse("blocked"));

    const result = await resolveNpmReleaseOutcomes({
      db: createDb(env.DB),
      env,
      organizationId: org.organizationId,
      ownerUserId: org.userId,
      connection: { token: TOKEN, registryUrl: REGISTRY_URL },
    });

    expect(result).toMatchObject({ checked: 1, resolved: 1, statuses: { blocked: 1 } });
    const scan = await readScan(scanId);
    expect(scan.registryVersionStatus).toBe("blocked");
    expect(scan.registryVersionStatusAt).toBeTruthy();
  });

  test("a 404 leaves the status unset but still stamps the attempt", async () => {
    // npm answers 404 for an unknown version and an unauthorized one alike.
    // Recording either as a status would invent a verdict; not stamping the
    // attempt would re-ask on every sweep forever.
    const org = await seedOrg();
    const { scanId } = await seedCompletedScan(org);
    stubRegistry(() => new Response(JSON.stringify({ error: "not found" }), { status: 404 }));

    const result = await resolveNpmReleaseOutcomes({
      db: createDb(env.DB),
      env,
      organizationId: org.organizationId,
      ownerUserId: org.userId,
      connection: { token: TOKEN, registryUrl: REGISTRY_URL },
    });

    expect(result).toMatchObject({ checked: 1, resolved: 0 });
    const scan = await readScan(scanId);
    expect(scan.registryVersionStatus).toBeNull();
    expect(scan.registryVersionStatusAt).toBeTruthy();
  });

  test("stops asking once npm's answer is terminal", async () => {
    const org = await seedOrg();
    await seedCompletedScan(org);
    const fetchMock = stubRegistry(() => statusResponse("published"));
    const args = {
      db: createDb(env.DB),
      env,
      organizationId: org.organizationId,
      ownerUserId: org.userId,
      connection: { token: TOKEN, registryUrl: REGISTRY_URL },
    };

    await resolveNpmReleaseOutcomes(args);
    const second = await resolveNpmReleaseOutcomes(args);

    expect(second.checked).toBe(0);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test("keeps asking while npm is still validating", async () => {
    const org = await seedOrg();
    await seedCompletedScan(org);
    stubRegistry(() => statusResponse("validating"));
    const args = {
      db: createDb(env.DB),
      env,
      organizationId: org.organizationId,
      ownerUserId: org.userId,
      connection: { token: TOKEN, registryUrl: REGISTRY_URL },
    };

    await resolveNpmReleaseOutcomes(args);
    // One sweep later. The recheck floor is a floor, not a schedule — the
    // on-demand "Check npm" button runs this too, so a repeat within minutes
    // deliberately does not re-ask.
    const second = await resolveNpmReleaseOutcomes({
      ...args,
      now: new Date(Date.now() + 20 * 60 * 1000),
    });

    expect(second.checked).toBe(1);
  });

  test("does not chase releases older than the age floor", async () => {
    const org = await seedOrg();
    await seedCompletedScan(org, { createdAt: new Date(Date.now() - 90 * 24 * 60 * 60 * 1000) });
    const fetchMock = stubRegistry(() => statusResponse("published"));

    const result = await resolveNpmReleaseOutcomes({
      db: createDb(env.DB),
      env,
      organizationId: org.organizationId,
      ownerUserId: org.userId,
      connection: { token: TOKEN, registryUrl: REGISTRY_URL },
    });

    expect(result.checked).toBe(0);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test("nudges once when we approved a release npm is still holding", async () => {
    const org = await seedOrg();
    const { scanId } = await seedCompletedScan(org);
    const db = createDb(env.DB);
    await recordScanDecision(db, {
      scanId,
      organizationId: org.organizationId,
      decision: "publish",
      decidedByUserId: org.userId,
    });
    // Backdate the approval past the grace period, so this reads as forgotten
    // rather than as a publish still in progress.
    await db
      .update(schema.scans)
      .set({ decidedAt: new Date(Date.now() - 12 * 60 * 60 * 1000) })
      .where(eq(schema.scans.id, scanId));
    stubRegistry(() => statusResponse("staged"));
    const args = {
      db,
      env,
      organizationId: org.organizationId,
      ownerUserId: org.userId,
      connection: { token: TOKEN, registryUrl: REGISTRY_URL },
    };

    const first = await resolveNpmReleaseOutcomes(args);
    expect(first.reminded).toBe(1);
    expect((await readScan(scanId)).registryPublishReminderAt).toBeTruthy();

    // The hourly recheck will select this row again; it must not re-send.
    await db
      .update(schema.scans)
      .set({ registryVersionStatusAt: new Date(Date.now() - 6 * 60 * 60 * 1000) })
      .where(eq(schema.scans.id, scanId));
    const second = await resolveNpmReleaseOutcomes(args);
    expect(second.checked).toBe(1);
    expect(second.reminded).toBe(0);
  });

  test("does not nudge about a release we never approved", async () => {
    const org = await seedOrg();
    const { scanId } = await seedCompletedScan(org);
    stubRegistry(() => statusResponse("staged"));

    const result = await resolveNpmReleaseOutcomes({
      db: createDb(env.DB),
      env,
      organizationId: org.organizationId,
      ownerUserId: org.userId,
      connection: { token: TOKEN, registryUrl: REGISTRY_URL },
    });

    expect(result.reminded).toBe(0);
    expect((await readScan(scanId)).registryPublishReminderAt).toBeNull();
  });

  test("scopes lookups to the asking organization", async () => {
    const [mine, theirs] = await Promise.all([seedOrg(), seedOrg()]);
    await seedCompletedScan(theirs);
    const fetchMock = stubRegistry(() => statusResponse("published"));

    const result = await resolveNpmReleaseOutcomes({
      db: createDb(env.DB),
      env,
      organizationId: mine.organizationId,
      ownerUserId: mine.userId,
      connection: { token: TOKEN, registryUrl: REGISTRY_URL },
    });

    expect(result.checked).toBe(0);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("staged failure refinement", () => {
  const unavailable = {
    code: "staged_tarball_unavailable",
    message: "The staged tarball could not be accessed with this organization's npm token.",
    retryable: false,
  };

  beforeEach(async () => {
    const db = createDb(env.DB);
    await db.delete(schema.scans);
    await db.delete(schema.npmConnections);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  async function refine(org: Seeded, scanId: string, stageId: string) {
    return refineStagedFailure(
      env,
      createDb(env.DB),
      { scanId, stageId, organizationId: org.organizationId, actorUserId: org.userId },
      unavailable,
    );
  }

  test.each([
    ["published", "staged_release_published"],
    ["deleted", "staged_release_withdrawn"],
    ["blocked", "staged_release_blocked"],
  ])("a %s release stops being blamed on the token", async (status, code) => {
    const org = await seedOrg();
    const { scanId, stageId } = await seedCompletedScan(org);
    stubRegistry(() => statusResponse(status));

    const refined = await refine(org, scanId, stageId);

    expect(refined.error.code).toBe(code);
    expect(refined.error.message).not.toContain("token");
    expect(refined.registryStatus).toBe(status);
  });

  test.each(["staged", "validating"])(
    "a release npm still has (%s) really is a token problem",
    async (status) => {
      const org = await seedOrg();
      const { scanId, stageId } = await seedCompletedScan(org);
      stubRegistry(() => statusResponse(status));

      const refined = await refine(org, scanId, stageId);

      expect(refined.error).toEqual(unavailable);
      expect(refined.registryStatus).toBe(status);
    },
  );

  test("an unanswerable lookup leaves the original classification alone", async () => {
    const org = await seedOrg();
    const { scanId, stageId } = await seedCompletedScan(org);
    stubRegistry(() => new Response(null, { status: 404 }));

    const refined = await refine(org, scanId, stageId);

    expect(refined.error).toEqual(unavailable);
    expect(refined.registryStatus).toBeNull();
  });

  test("a registry outage cannot turn into a different failure", async () => {
    const org = await seedOrg();
    const { scanId, stageId } = await seedCompletedScan(org);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("connection reset");
      }),
    );

    const refined = await refine(org, scanId, stageId);

    expect(refined.error).toEqual(unavailable);
  });

  test("leaves every other failure code untouched without calling npm", async () => {
    const org = await seedOrg();
    const { scanId, stageId } = await seedCompletedScan(org);
    const fetchMock = stubRegistry(() => statusResponse("published"));
    const other = { code: "archive_too_large", message: "too big", retryable: false };

    const refined = await refineStagedFailure(
      env,
      createDb(env.DB),
      { scanId, stageId, organizationId: org.organizationId, actorUserId: org.userId },
      other,
    );

    expect(refined.error).toEqual(other);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test("does not ask npm about a workflow-gate review", async () => {
    // Gate reviews span three ecosystems; npm's stage lifecycle says nothing
    // about a PyPI or VS Code release.
    const org = await seedOrg();
    const { scanId, stageId } = await seedCompletedScan(org);
    const fetchMock = stubRegistry(() => statusResponse("published"));

    const refined = await refineStagedFailure(
      env,
      createDb(env.DB),
      {
        scanId,
        stageId,
        organizationId: org.organizationId,
        actorUserId: org.userId,
        source: "workflow_gate",
      },
      unavailable,
    );

    expect(refined.error).toEqual(unavailable);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
