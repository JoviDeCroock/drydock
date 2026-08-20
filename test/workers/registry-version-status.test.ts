import { env } from "cloudflare:test";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { createDb } from "../../server/db/client";
import {
  updateNpmConnectionValidation,
  upsertNpmConnection,
} from "../../server/db/npm-connections";
import { ensurePersonalOrganization } from "../../server/db/organizations";
import {
  createScanJob,
  deleteFailedScan,
  markRegistryPublishReminderSent,
  markScanFailed,
  persistScan,
  recordRegistryVersionStatus,
  recordScanDecision,
  type ScanSource,
} from "../../server/db/scans";
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
  overrides: {
    stageId?: string;
    version?: string;
    createdAt?: Date;
    source?: ScanSource;
    registryUrl?: string | null;
  } = {},
) {
  const db = createDb(env.DB);
  const scanId = crypto.randomUUID();
  const stageId = overrides.stageId ?? `stage-${scanId.slice(0, 8)}`;
  await createScanJob(db, {
    id: scanId,
    stageId,
    organizationId: org.organizationId,
    ownerUserId: org.userId,
    source: overrides.source,
    packageName: PACKAGE,
    stagedVersion: overrides.version ?? VERSION,
    registryUrl: overrides.registryUrl === undefined ? REGISTRY_URL : overrides.registryUrl,
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

function stubRegistry(handler: (url: string) => Response | Promise<Response>) {
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
    expect(scan.registryVersionStatusAttemptedAt).toBeTruthy();
  });

  test("does not query an old scan through a replacement registry connection", async () => {
    const org = await seedOrg();
    const { scanId } = await seedCompletedScan(org, {
      registryUrl: "https://registry.example.test",
    });
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
    expect((await readScan(scanId)).registryVersionStatus).toBeNull();
  });

  test("records lifecycle status only on the newest scan for a restaged version", async () => {
    const org = await seedOrg();
    const newerCreatedAt = new Date(Date.now() - 60 * 1000);
    const older = await seedCompletedScan(org, {
      stageId: "stage-original",
      createdAt: new Date(newerCreatedAt.getTime() - 60 * 1000),
    });
    const newer = await seedCompletedScan(org, {
      stageId: "stage-restaged",
      createdAt: newerCreatedAt,
    });
    const fetchMock = stubRegistry(() => statusResponse("published"));

    const result = await resolveNpmReleaseOutcomes({
      db: createDb(env.DB),
      env,
      organizationId: org.organizationId,
      ownerUserId: org.userId,
      connection: { token: TOKEN, registryUrl: REGISTRY_URL },
    });

    expect(result).toMatchObject({ checked: 1, resolved: 1 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect((await readScan(older.scanId)).registryVersionStatus).toBeNull();
    expect((await readScan(newer.scanId)).registryVersionStatus).toBe("published");
  });

  test("does not revive a superseded stage after a newer failed scan is deleted", async () => {
    const org = await seedOrg();
    const older = await seedCompletedScan(org, { stageId: "stage-original" });
    const db = createDb(env.DB);
    const newerScanId = crypto.randomUUID();
    await createScanJob(db, {
      id: newerScanId,
      stageId: "stage-restaged",
      organizationId: org.organizationId,
      ownerUserId: org.userId,
      packageName: PACKAGE,
      stagedVersion: VERSION,
      registryUrl: REGISTRY_URL,
    });
    await markScanFailed(db, newerScanId, org.organizationId, { message: "unavailable" });
    await expect(deleteFailedScan(db, newerScanId, org.organizationId)).resolves.toMatchObject({
      outcome: "deleted",
    });
    const fetchMock = stubRegistry(() => statusResponse("published"));

    const result = await resolveNpmReleaseOutcomes({
      db,
      env,
      organizationId: org.organizationId,
      ownerUserId: org.userId,
      connection: { token: TOKEN, registryUrl: REGISTRY_URL },
    });

    expect(result.checked).toBe(0);
    expect(fetchMock).not.toHaveBeenCalled();
    expect((await readScan(older.scanId)).registryStatusSupersededAt).toBeTruthy();
  });

  test("does not annotate history when discovery sees a different live stage id", async () => {
    const org = await seedOrg();
    const { scanId } = await seedCompletedScan(org, { stageId: "stage-original" });
    const fetchMock = stubRegistry(() => statusResponse("staged"));

    const result = await resolveNpmReleaseOutcomes({
      db: createDb(env.DB),
      env,
      organizationId: org.organizationId,
      ownerUserId: org.userId,
      connection: { token: TOKEN, registryUrl: REGISTRY_URL },
      stagedItems: [{ id: "stage-restaged", packageName: PACKAGE, version: VERSION }],
    });

    expect(result.checked).toBe(0);
    expect(fetchMock).not.toHaveBeenCalled();
    expect((await readScan(scanId)).registryVersionStatus).toBeNull();
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
    expect(scan.registryVersionStatusAt).toBeNull();
    expect(scan.registryVersionStatusAttemptedAt).toBeTruthy();
  });

  test("an unresolved recheck preserves the last status npm actually returned", async () => {
    const org = await seedOrg();
    const { scanId } = await seedCompletedScan(org);
    const firstCheckedAt = new Date();
    const secondCheckedAt = new Date(firstCheckedAt.getTime() + 20 * 60 * 1000);
    stubRegistry(() => statusResponse("validating"));
    const args = {
      db: createDb(env.DB),
      env,
      organizationId: org.organizationId,
      ownerUserId: org.userId,
      connection: { token: TOKEN, registryUrl: REGISTRY_URL },
    };

    await resolveNpmReleaseOutcomes({ ...args, now: firstCheckedAt });
    stubRegistry(() => new Response(null, { status: 429 }));
    await resolveNpmReleaseOutcomes({ ...args, now: secondCheckedAt });

    const scan = await readScan(scanId);
    expect(scan.registryVersionStatus).toBe("validating");
    expect(scan.registryVersionStatusAt?.getTime()).toBe(firstCheckedAt.getTime());
    expect(scan.registryVersionStatusAttemptedAt?.getTime()).toBe(secondCheckedAt.getTime());
  });

  test("an older overlapping sweep cannot replace a newer registry result", async () => {
    const org = await seedOrg();
    const { scanId } = await seedCompletedScan(org);
    const db = createDb(env.DB);
    const older = new Date("2026-08-19T12:00:00.000Z");
    const newer = new Date("2026-08-19T12:01:00.000Z");

    await expect(
      recordRegistryVersionStatus(db, {
        scanId,
        organizationId: org.organizationId,
        status: "published",
        checkedAt: newer,
      }),
    ).resolves.toBe(true);
    await expect(
      recordRegistryVersionStatus(db, {
        scanId,
        organizationId: org.organizationId,
        status: "staged",
        checkedAt: older,
      }),
    ).resolves.toBe(false);

    const scan = await readScan(scanId);
    expect(scan.registryVersionStatus).toBe("published");
    expect(scan.registryVersionStatusAt?.getTime()).toBe(newer.getTime());
    expect(scan.registryVersionStatusAttemptedAt?.getTime()).toBe(newer.getTime());
  });

  test("stops asking once npm's answer is terminal", async () => {
    const org = await seedOrg();
    await seedCompletedScan(org);
    const fetchMock = stubRegistry(() => statusResponse("blocked"));
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

  test("rechecks a published version and records a later removal", async () => {
    const org = await seedOrg();
    const { scanId } = await seedCompletedScan(org);
    const publishedAt = new Date("2026-08-19T12:00:00.000Z");
    const args = {
      db: createDb(env.DB),
      env,
      organizationId: org.organizationId,
      ownerUserId: org.userId,
      connection: { token: TOKEN, registryUrl: REGISTRY_URL },
    };
    const fetchMock = stubRegistry(() => statusResponse("published"));

    await resolveNpmReleaseOutcomes({ ...args, now: publishedAt });
    const tooSoon = await resolveNpmReleaseOutcomes({
      ...args,
      now: new Date(publishedAt.getTime() + 60 * 60 * 1000),
    });
    expect(tooSoon.checked).toBe(0);

    fetchMock.mockImplementation(async () => statusResponse("deleted"));
    const rechecked = await resolveNpmReleaseOutcomes({
      ...args,
      now: new Date(publishedAt.getTime() + 25 * 60 * 60 * 1000),
    });

    expect(rechecked).toMatchObject({ checked: 1, resolved: 1, statuses: { deleted: 1 } });
    expect((await readScan(scanId)).registryVersionStatus).toBe("deleted");
    expect(fetchMock).toHaveBeenCalledTimes(2);
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

  test("does not ask npm about workflow-gate scans from other ecosystems", async () => {
    const org = await seedOrg();
    await seedCompletedScan(org, { source: "workflow_gate" });
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

  test("drains rows beyond one sweep's lookup budget", async () => {
    const org = await seedOrg();
    const versions = Array.from({ length: 17 }, (_, index) => `2.0.${index}`);
    for (const version of versions) await seedCompletedScan(org, { version });
    const seenVersions = new Set<string>();
    stubRegistry((url) => {
      const match = /\/version\/([^/]+)\/status$/.exec(new URL(url).pathname);
      if (match?.[1]) seenVersions.add(decodeURIComponent(match[1]));
      return new Response(null, { status: 404 });
    });
    const now = new Date();
    const args = {
      db: createDb(env.DB),
      env,
      organizationId: org.organizationId,
      ownerUserId: org.userId,
      connection: { token: TOKEN, registryUrl: REGISTRY_URL },
    };

    const first = await resolveNpmReleaseOutcomes({ ...args, now });
    const second = await resolveNpmReleaseOutcomes({
      ...args,
      now: new Date(now.getTime() + 20 * 60 * 1000),
    });

    expect(first.checked).toBe(16);
    expect(second.checked).toBe(16);
    expect(seenVersions).toEqual(new Set(versions));
  });

  test("nudges once when we approved a release npm is still holding", async () => {
    const org = await seedOrg();
    const { scanId } = await seedCompletedScan(org);
    const db = createDb(env.DB);
    await recordScanDecision(db, {
      scanId,
      organizationId: org.organizationId,
      decision: "publish",
      actorUserId: org.userId,
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
      .set({ registryVersionStatusAttemptedAt: new Date(Date.now() - 6 * 60 * 60 * 1000) })
      .where(eq(schema.scans.id, scanId));
    const second = await resolveNpmReleaseOutcomes(args);
    expect(second.checked).toBe(1);
    expect(second.reminded).toBe(0);
  });

  test("sends one reminder across duplicate reviews of the same release", async () => {
    const org = await seedOrg();
    const older = await seedCompletedScan(org, {
      stageId: "stage-duplicate",
      createdAt: new Date(Date.now() - 2 * 60 * 1000),
    });
    const db = createDb(env.DB);
    await recordScanDecision(db, {
      scanId: older.scanId,
      organizationId: org.organizationId,
      decision: "publish",
      actorUserId: org.userId,
    });
    await db
      .update(schema.scans)
      .set({ decidedAt: new Date(Date.now() - 12 * 60 * 60 * 1000) })
      .where(eq(schema.scans.id, older.scanId));
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

    const newer = await seedCompletedScan(org, {
      stageId: "stage-duplicate",
      createdAt: new Date(Date.now() - 60 * 1000),
    });
    await recordScanDecision(db, {
      scanId: newer.scanId,
      organizationId: org.organizationId,
      decision: "publish",
      actorUserId: org.userId,
    });
    await db
      .update(schema.scans)
      .set({ decidedAt: new Date(Date.now() - 12 * 60 * 60 * 1000) })
      .where(eq(schema.scans.id, newer.scanId));

    const second = await resolveNpmReleaseOutcomes(args);

    expect(second).toMatchObject({ checked: 1, resolved: 1, reminded: 0 });
    expect((await readScan(older.scanId)).registryPublishReminderAt).toBeTruthy();
    expect((await readScan(newer.scanId)).registryPublishReminderAt).toBeNull();
  });

  test("does not send a stale reminder after the approval changes in flight", async () => {
    const org = await seedOrg();
    const { scanId } = await seedCompletedScan(org);
    const db = createDb(env.DB);
    await recordScanDecision(db, {
      scanId,
      organizationId: org.organizationId,
      decision: "publish",
      actorUserId: org.userId,
    });
    await db
      .update(schema.scans)
      .set({ decidedAt: new Date(Date.now() - 12 * 60 * 60 * 1000) })
      .where(eq(schema.scans.id, scanId));

    let finishLookup: ((response: Response) => void) | undefined;
    const lookupResponse = new Promise<Response>((resolve) => {
      finishLookup = resolve;
    });
    const fetchMock = stubRegistry(() => lookupResponse);
    const resolving = resolveNpmReleaseOutcomes({
      db,
      env,
      organizationId: org.organizationId,
      ownerUserId: org.userId,
      connection: { token: TOKEN, registryUrl: REGISTRY_URL },
    });
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

    await recordScanDecision(db, {
      scanId,
      organizationId: org.organizationId,
      decision: "no_publish",
      actorUserId: org.userId,
    });
    finishLookup?.(statusResponse("staged"));

    await expect(resolving).resolves.toMatchObject({ reminded: 0 });
    expect((await readScan(scanId)).registryPublishReminderAt).toBeNull();
  });

  test("does not claim a reminder after a newer registry observation wins", async () => {
    const org = await seedOrg();
    const { scanId } = await seedCompletedScan(org);
    const db = createDb(env.DB);
    await recordScanDecision(db, {
      scanId,
      organizationId: org.organizationId,
      decision: "publish",
      actorUserId: org.userId,
    });
    const decidedAt = (await readScan(scanId)).decidedAt!;
    const stagedAt = new Date("2026-08-19T12:00:00.000Z");
    const publishedAt = new Date("2026-08-19T12:01:00.000Z");
    await recordRegistryVersionStatus(db, {
      scanId,
      organizationId: org.organizationId,
      status: "staged",
      checkedAt: stagedAt,
    });
    await recordRegistryVersionStatus(db, {
      scanId,
      organizationId: org.organizationId,
      status: "published",
      checkedAt: publishedAt,
    });

    await expect(
      markRegistryPublishReminderSent(db, {
        scanId,
        organizationId: org.organizationId,
        expectedDecidedAt: decidedAt,
        expectedRegistryStatusAt: stagedAt,
      }),
    ).resolves.toBe(false);
    expect((await readScan(scanId)).registryPublishReminderAt).toBeNull();
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
    ["deleted", "staged_release_deleted"],
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

  test("does not refine a failed scan through a replacement registry connection", async () => {
    const org = await seedOrg();
    const { scanId, stageId } = await seedCompletedScan(org, {
      registryUrl: "https://registry.example.test",
    });
    const fetchMock = stubRegistry(() => statusResponse("published"));

    const refined = await refine(org, scanId, stageId);

    expect(refined.error).toEqual(unavailable);
    expect(refined.registryStatus).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
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
