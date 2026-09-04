import { createExecutionContext, env } from "cloudflare:test";
import { and, eq } from "drizzle-orm";
import { afterEach, describe, expect, test, vi } from "vitest";
import { createDb } from "../../server/db/client";
import {
  updateNpmConnectionValidation,
  upsertNpmConnection,
} from "../../server/db/npm-connections";
import { ensurePersonalOrganization } from "../../server/db/organizations";
import {
  createScanJob,
  markScanRegistryVerified,
  recordRegistryDigestMismatch,
} from "../../server/db/scans";
import * as schema from "../../server/db/schema";
import { getWorkflowGateAdapter } from "../../server/lib/ecosystems";
import { createNpmBroker } from "../../server/lib/ecosystems/npm/broker";
import { encryptNpmToken } from "../../server/lib/ecosystems/npm/connection";
import {
  REGISTRY_VERIFICATION_INITIAL_DELAY_SECONDS,
  REGISTRY_VERIFICATION_MISMATCH_GRACE_MS,
  enqueueRegistryVerification,
  executeRegistryVerificationJob,
  runRegistryVerificationCron,
} from "../../server/lib/workflow-gates/registry-verification";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function seedApprovedGate(decidedAt: Date) {
  const db = createDb(env.DB);
  const now = new Date();
  const userId = `user_${crypto.randomUUID()}`;
  await db.insert(schema.user).values({
    id: userId,
    name: "Registry verifier",
    email: `${userId}@example.com`,
    emailVerified: true,
    createdAt: now,
    updatedAt: now,
  });
  const organizationId = await ensurePersonalOrganization(db, { userId });
  const installationId = crypto.randomUUID();
  await db.insert(schema.githubAppInstallations).values({
    id: installationId,
    organizationId,
    installationId: `installation-${crypto.randomUUID()}`,
    accountLogin: "octo",
    accountType: "Organization",
    targetType: "Organization",
    status: "active",
    installedAt: now,
    createdAt: now,
    updatedAt: now,
  });
  const targetId = crypto.randomUUID();
  await db.insert(schema.githubReleaseTargets).values({
    id: targetId,
    organizationId,
    installationRowId: installationId,
    ecosystem: "pypi",
    repositoryId: Math.floor(Math.random() * 1_000_000_000),
    repositoryFullName: "octo/registry-verification",
    environment: `release-${crypto.randomUUID()}`,
    createdAt: now,
    updatedAt: now,
  });
  const gateId = crypto.randomUUID();
  await db.insert(schema.githubWorkflowGates).values({
    id: gateId,
    organizationId,
    installationRowId: installationId,
    releaseTargetId: targetId,
    deliveryId: crypto.randomUUID(),
    repositoryId: Math.floor(Math.random() * 1_000_000_000),
    repositoryFullName: "octo/registry-verification",
    environment: "release",
    runId: Math.floor(Math.random() * 1_000_000_000),
    deploymentCallbackUrl:
      "https://api.github.com/repos/octo/repo/actions/runs/1/deployment_protection_rule",
    eventAction: "requested",
    status: "approved",
    decision: "approved",
    requestedAt: now,
    decidedAt,
    createdAt: now,
    updatedAt: now,
  });
  const scanId = crypto.randomUUID();
  await createScanJob(db, {
    id: scanId,
    stageId: `workflow-gate:${gateId}:pypi:demo`,
    organizationId,
    ownerUserId: userId,
    source: "workflow_gate",
    gateId,
    packageName: "demo",
    stagedVersion: "1.2.3",
  });
  await db
    .update(schema.scans)
    .set({
      status: "complete",
      decision: "publish",
      summaryJson: {
        stagedPublish: {
          provenance: {
            ecosystem: "pypi",
            mode: "workflow_gate",
            artifacts: [{ path: "dist/demo-1.2.3.whl", kind: "wheel", sha256: "a".repeat(64) }],
          },
        },
      },
      completedAt: now,
      updatedAt: now,
    })
    .where(eq(schema.scans.id, scanId));
  return { db, organizationId, gateId, scanId, userId };
}

async function connectPrivateNpmRegistry(
  seeded: Awaited<ReturnType<typeof seedApprovedGate>>,
  registryUrl: string,
) {
  const encrypted = await encryptNpmToken(env, `npm_registry_verification_${crypto.randomUUID()}`);
  await upsertNpmConnection(seeded.db, {
    organizationId: seeded.organizationId,
    registryUrl,
    label: "Private registry",
    ...encrypted,
    createdByUserId: seeded.userId,
  });
  await updateNpmConnectionValidation(seeded.db, {
    organizationId: seeded.organizationId,
    validationStatus: "valid",
    validatedAt: new Date(),
  });
}

describe("post-publish registry verification", () => {
  test("does not fall through to public npm when a private release is absent", async () => {
    const seeded = await seedApprovedGate(new Date());
    const registryUrl = `https://registry-${crypto.randomUUID()}.example.test`;
    await connectPrivateNpmRegistry(seeded, registryUrl);
    const fetchMock = vi.fn(async () => Response.json({ versions: {} }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      getWorkflowGateAdapter("npm").verifyPublishedRelease?.(
        {
          env,
          executionCtx: createExecutionContext(),
          db: seeded.db,
          organizationId: seeded.organizationId,
        },
        {
          packageName: `private-${crypto.randomUUID()}`,
          version: "1.2.3",
          artifacts: [{ path: "demo.tgz", kind: "tarball", sha256: "a".repeat(64) }],
        },
      ),
    ).resolves.toEqual({ status: "not_published" });
    expect(fetchMock).toHaveBeenCalled();
    expect(fetchMock.mock.calls.every(([request]) => String(request).startsWith(registryUrl))).toBe(
      true,
    );
    await markScanRegistryVerified(seeded.db, seeded.scanId, seeded.organizationId, new Date());
  });

  test("does not fall through to public npm when a private metadata request fails", async () => {
    const seeded = await seedApprovedGate(new Date());
    const registryUrl = `https://registry-${crypto.randomUUID()}.example.test`;
    await connectPrivateNpmRegistry(seeded, registryUrl);
    const fetchMock = vi.fn(async () => {
      throw new Error("private registry unavailable");
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      getWorkflowGateAdapter("npm").verifyPublishedRelease?.(
        {
          env,
          executionCtx: createExecutionContext(),
          db: seeded.db,
          organizationId: seeded.organizationId,
        },
        {
          packageName: `private-${crypto.randomUUID()}`,
          version: "1.2.3",
          artifacts: [{ path: "demo.tgz", kind: "tarball", sha256: "a".repeat(64) }],
        },
      ),
    ).resolves.toEqual({ status: "not_published" });
    expect(fetchMock).toHaveBeenCalled();
    expect(fetchMock.mock.calls.every(([request]) => String(request).startsWith(registryUrl))).toBe(
      true,
    );
    await markScanRegistryVerified(seeded.db, seeded.scanId, seeded.organizationId, new Date());
  });

  test("allows credential-free fallback only on the same registry authority", async () => {
    const seeded = await seedApprovedGate(new Date());
    const registryUrl = `https://registry-${crypto.randomUUID()}.example.test`;
    await connectPrivateNpmRegistry(seeded, registryUrl);
    await updateNpmConnectionValidation(seeded.db, {
      organizationId: seeded.organizationId,
      validationStatus: "invalid",
    });
    const fetchMock = vi.fn(async () => Response.json({ versions: {} }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      getWorkflowGateAdapter("npm").verifyPublishedRelease?.(
        {
          env: { ...env, NPM_REGISTRY: registryUrl },
          executionCtx: createExecutionContext(),
          db: seeded.db,
          organizationId: seeded.organizationId,
        },
        {
          packageName: `public-${crypto.randomUUID()}`,
          version: "1.2.3",
          artifacts: [{ path: "demo.tgz", kind: "tarball", sha256: "a".repeat(64) }],
        },
      ),
    ).resolves.toEqual({ status: "not_published" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0]?.[0]).startsWith(registryUrl)).toBe(true);
    await markScanRegistryVerified(seeded.db, seeded.scanId, seeded.organizationId, new Date());
  });

  test("pins the broker when the organization registry changes during verification", async () => {
    const seeded = await seedApprovedGate(new Date());
    const deploymentRegistry = `https://registry-${crypto.randomUUID()}.example.test`;
    const replacementRegistry = `https://private-${crypto.randomUUID()}.example.test`;
    await connectPrivateNpmRegistry(seeded, deploymentRegistry);
    const fetchMock = vi.fn(async () => Response.json({ versions: {} }));
    vi.stubGlobal("fetch", fetchMock);

    const localExecutionCtx = createExecutionContext();
    let pinnedRegistry: string | null | undefined;
    const executionCtx = {
      exports: {
        NpmAdapterBroker: ({
          props,
        }: {
          props: { organizationId: string; registryUrl?: string | null };
        }) => {
          pinnedRegistry = props.registryUrl;
          const broker = createNpmBroker(
            {
              env: { ...env, NPM_REGISTRY: deploymentRegistry },
              executionCtx: localExecutionCtx,
              db: seeded.db,
              session: { userId: "registry-verification" },
            },
            props,
          );
          return new Proxy(broker, {
            get(target, property, receiver) {
              if (property === "fetchPackageMetadata") {
                return async (name: string) => {
                  await connectPrivateNpmRegistry(seeded, replacementRegistry);
                  return target.fetchPackageMetadata(name);
                };
              }
              const value = Reflect.get(target, property, receiver) as unknown;
              return typeof value === "function" ? value.bind(target) : value;
            },
          });
        },
      },
    } as unknown as ExecutionContext;

    await expect(
      getWorkflowGateAdapter("npm").verifyPublishedRelease?.(
        {
          env: { ...env, NPM_REGISTRY: deploymentRegistry },
          executionCtx,
          db: seeded.db,
          organizationId: seeded.organizationId,
        },
        {
          packageName: `private-${crypto.randomUUID()}`,
          version: "1.2.3",
          artifacts: [{ path: "demo.tgz", kind: "tarball", sha256: "a".repeat(64) }],
        },
      ),
    ).rejects.toThrow("npm registry changed after this scan was queued");
    expect(pinnedRegistry).toBe(deploymentRegistry);
    expect(fetchMock).not.toHaveBeenCalled();
    await markScanRegistryVerified(seeded.db, seeded.scanId, seeded.organizationId, new Date());
  });

  test("PyPI compares the complete registry digest set with the reviewed release", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({
          releases: {
            "1.2.3": [
              {
                filename: "demo-1.2.3.whl",
                packagetype: "bdist_wheel",
                url: "https://files.pythonhosted.org/packages/demo-1.2.3.whl",
                digests: { sha256: "a".repeat(64) },
              },
            ],
          },
        }),
      ),
    );
    const adapter = getWorkflowGateAdapter("pypi");
    await expect(
      adapter.verifyPublishedRelease?.(
        {
          env,
          executionCtx: createExecutionContext(),
          db: createDb(env.DB),
          organizationId: "unused-for-public-pypi",
        },
        {
          packageName: "demo",
          version: "1.2.3",
          artifacts: [{ path: "dist/demo-1.2.3.whl", kind: "wheel", sha256: "a".repeat(64) }],
        },
      ),
    ).resolves.toEqual({ status: "verified" });
  });

  test("PyPI leaves verification pending when registry SHA-256 evidence is absent", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({
          releases: {
            "1.2.3": [
              {
                filename: "demo-1.2.3.whl",
                packagetype: "bdist_wheel",
                url: "https://files.pythonhosted.org/packages/demo-1.2.3.whl",
                digests: {},
              },
            ],
          },
        }),
      ),
    );

    await expect(
      getWorkflowGateAdapter("pypi").verifyPublishedRelease?.(
        {
          env,
          executionCtx: createExecutionContext(),
          db: createDb(env.DB),
          organizationId: "unused-for-public-pypi",
        },
        {
          packageName: "demo",
          version: "1.2.3",
          artifacts: [{ path: "dist/demo-1.2.3.whl", kind: "wheel", sha256: "a".repeat(64) }],
        },
      ),
    ).rejects.toThrow("published PyPI artifact digest unavailable");
  });

  test("approval scheduling uses a delayed queue message", async () => {
    const send = vi.fn().mockResolvedValue(undefined);
    const bindings = { ...env, SCAN_QUEUE: { send } } as unknown as Cloudflare.Env;
    const message = {
      kind: "registry_verification" as const,
      organizationId: "org-1",
      gateId: "gate-1",
    };
    await enqueueRegistryVerification(bindings, createExecutionContext(), message);
    expect(send).toHaveBeenCalledWith(message, {
      delaySeconds: REGISTRY_VERIFICATION_INITIAL_DELAY_SECONDS,
    });
  });

  test("upgrades a gate scan after every reviewed digest matches", async () => {
    const seeded = await seedApprovedGate(new Date(Date.now() - 60_000));
    vi.spyOn(getWorkflowGateAdapter("pypi"), "verifyPublishedRelease").mockResolvedValue({
      status: "verified",
    });

    await expect(
      executeRegistryVerificationJob(
        env,
        createExecutionContext(),
        {
          kind: "registry_verification",
          organizationId: seeded.organizationId,
          gateId: seeded.gateId,
        },
        seeded.db,
      ),
    ).resolves.toEqual({ verified: 1, pending: 0, mismatched: 0 });

    const [scan] = await seeded.db
      .select({ registryVerifiedAt: schema.scans.registryVerifiedAt })
      .from(schema.scans)
      .where(eq(schema.scans.id, seeded.scanId));
    expect(scan?.registryVerifiedAt).toBeInstanceOf(Date);

    const verifiedEvents = await seeded.db
      .select({ id: schema.scanEvents.id })
      .from(schema.scanEvents)
      .where(
        and(
          eq(schema.scanEvents.scanId, seeded.scanId),
          eq(schema.scanEvents.type, "scan.registry_digest_verified"),
        ),
      );
    expect(verifiedEvents).toHaveLength(1);
    await expect(
      markScanRegistryVerified(seeded.db, seeded.scanId, seeded.organizationId, new Date()),
    ).resolves.toBe(false);
    const eventsAfterRetry = await seeded.db
      .select({ id: schema.scanEvents.id })
      .from(schema.scanEvents)
      .where(
        and(
          eq(schema.scanEvents.scanId, seeded.scanId),
          eq(schema.scanEvents.type, "scan.registry_digest_verified"),
        ),
      );
    expect(eventsAfterRetry).toHaveLength(1);
  });

  test("rolls back the verified state when its audit event cannot be written", async () => {
    // Keep this intentionally pending rollback outside the cron's seven-day
    // recovery window so it cannot leak into the later cron assertion.
    const seeded = await seedApprovedGate(new Date(Date.now() - 8 * 24 * 60 * 60 * 1000));
    await env.DB.prepare(`
      create trigger fail_registry_verification_audit
      before insert on scan_events
      when new.type = 'scan.registry_digest_verified'
      begin
        select raise(abort, 'forced registry verification audit failure');
      end
    `).run();
    try {
      await expect(
        markScanRegistryVerified(seeded.db, seeded.scanId, seeded.organizationId, new Date()),
      ).rejects.toThrow();
      const [scan] = await seeded.db
        .select({ registryVerifiedAt: schema.scans.registryVerifiedAt })
        .from(schema.scans)
        .where(eq(schema.scans.id, seeded.scanId));
      expect(scan?.registryVerifiedAt).toBeNull();
    } finally {
      await env.DB.exec("drop trigger if exists fail_registry_verification_audit");
    }
  });

  test("defers propagation-time disagreement, then raises one durable mismatch alarm", async () => {
    const now = new Date();
    // The approval can predate the successful GitHub callback by a long time.
    // Grace starts at the first observed disagreement, not at this old decision.
    const seeded = await seedApprovedGate(new Date(now.getTime() - 60 * 60 * 1000));
    vi.spyOn(getWorkflowGateAdapter("pypi"), "verifyPublishedRelease").mockResolvedValue({
      status: "mismatch",
      reviewedDigests: ["a".repeat(64)],
      publishedDigests: ["b".repeat(64)],
    });
    const message = {
      kind: "registry_verification" as const,
      organizationId: seeded.organizationId,
      gateId: seeded.gateId,
    };

    await expect(
      executeRegistryVerificationJob(env, createExecutionContext(), message, seeded.db, now),
    ).resolves.toEqual({ verified: 0, pending: 1, mismatched: 0 });

    const afterGrace = new Date(now.getTime() + REGISTRY_VERIFICATION_MISMATCH_GRACE_MS + 1);
    await expect(
      executeRegistryVerificationJob(env, createExecutionContext(), message, seeded.db, afterGrace),
    ).resolves.toEqual({ verified: 0, pending: 0, mismatched: 1 });
    await executeRegistryVerificationJob(
      env,
      createExecutionContext(),
      message,
      seeded.db,
      afterGrace,
    );

    const alarms = await seeded.db
      .select({ id: schema.scanEvents.id })
      .from(schema.scanEvents)
      .where(eq(schema.scanEvents.type, "scan.registry_digest_mismatch"));
    expect(alarms).toHaveLength(1);
  });

  test("keeps verified and terminal mismatch transitions mutually exclusive", async () => {
    const mismatchFirst = await seedApprovedGate(new Date());
    const mismatch = {
      scanId: mismatchFirst.scanId,
      organizationId: mismatchFirst.organizationId,
      ecosystem: "pypi",
      packageName: "demo",
      version: "1.2.3",
      reviewedDigests: ["a".repeat(64)],
      publishedDigests: ["b".repeat(64)],
      now: new Date(),
    };
    await expect(recordRegistryDigestMismatch(mismatchFirst.db, mismatch)).resolves.toBe(true);
    await expect(
      markScanRegistryVerified(
        mismatchFirst.db,
        mismatchFirst.scanId,
        mismatchFirst.organizationId,
        new Date(),
      ),
    ).resolves.toBe(false);

    const verifiedFirst = await seedApprovedGate(new Date());
    await expect(
      markScanRegistryVerified(
        verifiedFirst.db,
        verifiedFirst.scanId,
        verifiedFirst.organizationId,
        new Date(),
      ),
    ).resolves.toBe(true);
    await expect(
      recordRegistryDigestMismatch(verifiedFirst.db, {
        ...mismatch,
        scanId: verifiedFirst.scanId,
        organizationId: verifiedFirst.organizationId,
      }),
    ).resolves.toBe(false);
  });

  test("cron re-enqueues approved scans that have not reached a terminal verification", async () => {
    const seeded = await seedApprovedGate(new Date(Date.now() - 60_000));
    const send = vi.fn().mockResolvedValue(undefined);
    const bindings = { ...env, SCAN_QUEUE: { send } } as unknown as Cloudflare.Env;

    await expect(
      runRegistryVerificationCron(bindings, createExecutionContext(), seeded.db),
    ).resolves.toEqual({ gates: 1, queued: 1, inline: 0 });
    expect(send).toHaveBeenCalledWith({
      kind: "registry_verification",
      organizationId: seeded.organizationId,
      gateId: seeded.gateId,
    });
  });

  test("bounded cron sweeps rotate past long-lived pending gates", async () => {
    const sweepNow = new Date();
    const cleanupDb = createDb(env.DB);
    await cleanupDb
      .update(schema.scans)
      .set({ registryVerifiedAt: sweepNow })
      .where(eq(schema.scans.source, "workflow_gate"));
    const first = await seedApprovedGate(new Date(sweepNow.getTime() - 2 * 60_000));
    const second = await seedApprovedGate(new Date(sweepNow.getTime() - 60_000));
    const send = vi.fn().mockResolvedValue(undefined);
    const bindings = { ...env, SCAN_QUEUE: { send } } as unknown as Cloudflare.Env;

    await runRegistryVerificationCron(bindings, createExecutionContext(), first.db, sweepNow, 1);
    await runRegistryVerificationCron(bindings, createExecutionContext(), first.db, sweepNow, 1);

    expect(send.mock.calls.map(([message]) => message.gateId)).toEqual([
      first.gateId,
      second.gateId,
    ]);
  });
});
