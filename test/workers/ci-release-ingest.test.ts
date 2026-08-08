import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { eq } from "drizzle-orm";
import { createDb } from "../../server/db/client";
import { ensurePersonalOrganization } from "../../server/db/organizations";
import * as schema from "../../server/db/schema";
import { listReleaseArtifacts } from "../../server/db/ci-release-sets";
import { createReleaseTarget, upsertInstallation } from "../../server/lib/github-app/persistence";
import { resetJwksCacheForTests } from "../../server/lib/ci/oidc";
import { ciReleaseRoutes } from "../../server/routes/ci-releases";
import type { Bindings, Variables } from "../../server/types";
import { createFakeOidcIssuer, withJwks, type FakeOidcIssuer } from "./support/ci-oidc";

const originalFetch = globalThis.fetch;

// D1 is reset once per file, not per test, so every test claims its own
// repository id. Sharing one would let a test that deliberately creates an
// ambiguous mapping poison every test after it.
let nextRepositoryId = 4242;
let issuer: FakeOidcIssuer;

beforeEach(() => {
  vi.unstubAllGlobals();
  resetJwksCacheForTests();
  issuer = createFakeOidcIssuer();
  vi.stubGlobal("fetch", vi.fn(withJwks(issuer)));
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.unstubAllGlobals();
});

// ── harness ──────────────────────────────────────────────────────────────────

function buildApp() {
  const app = new Hono<{ Bindings: Bindings; Variables: Variables }>();
  app.route("/api/ci/v1", ciReleaseRoutes);
  return app;
}

interface TestEnvOptions {
  queue?: { send: (message: unknown) => Promise<void> };
}

function buildEnv(options: TestEnvOptions = {}): Cloudflare.Env {
  return {
    ...env,
    CI_OIDC_ISSUER: issuer.issuer,
    CI_OIDC_AUDIENCE: issuer.audience,
    BETTER_AUTH_URL: "https://drydock.test",
    // Absent by default in the worker test config; a stub keeps the seal path
    // from running the whole review pipeline inline in these route tests.
    SCAN_QUEUE: options.queue ?? { send: async () => {} },
  } as unknown as Cloudflare.Env;
}

interface CallOptions {
  method?: string;
  token?: string;
  body?: unknown;
  raw?: Uint8Array;
  headers?: Record<string, string>;
  env?: Cloudflare.Env;
}

async function call(pathname: string, options: CallOptions = {}) {
  const app = buildApp();
  const ctx = createExecutionContext();
  const headers: Record<string, string> = { ...options.headers };
  if (options.token !== undefined) headers.authorization = `Bearer ${options.token}`;

  let body: BodyInit | undefined;
  if (options.raw) {
    body = options.raw as unknown as BodyInit;
  } else if (options.body !== undefined) {
    body = JSON.stringify(options.body);
    headers["content-type"] = "application/json";
  }

  const response = await app.fetch(
    new Request(`https://drydock.test${pathname}`, {
      method: options.method ?? "GET",
      headers,
      body,
    }),
    options.env ?? buildEnv(),
    ctx,
  );
  await waitOnExecutionContext(ctx);
  const text = await response.text();
  return {
    status: response.status,
    body: text ? (JSON.parse(text) as Record<string, unknown>) : {},
  };
}

interface LinkedRepository {
  organizationId: string;
  installation: Awaited<ReturnType<typeof upsertInstallation>>;
  releaseTarget: Awaited<ReturnType<typeof createReleaseTarget>>;
  userId: string;
  repositoryId: number;
  /** Mint a token bound to this repository, with optional claim overrides. */
  token(claims?: Record<string, unknown>): string;
}

async function seedLinkedRepository(overrides?: {
  repositoryId?: number;
}): Promise<LinkedRepository> {
  const repositoryId = overrides?.repositoryId ?? nextRepositoryId++;
  const db = createDb(env.DB);
  const now = new Date();
  const userId = `user_${crypto.randomUUID()}`;
  await db.insert(schema.user).values({
    id: userId,
    name: "Tester",
    email: `${userId}@example.com`,
    emailVerified: true,
    createdAt: now,
    updatedAt: now,
  });
  const organizationId = await ensurePersonalOrganization(db, { userId });
  const installation = await upsertInstallation(db, {
    organizationId,
    installationId: `inst_${crypto.randomUUID()}`,
    accountLogin: "octo",
    accountType: "Organization",
    targetType: "Organization",
    status: "active",
    createdByUserId: null,
  });
  const releaseTarget = await createReleaseTarget(db, {
    organizationId,
    installationRowId: installation.id,
    ecosystem: null,
    repositoryId,
    repositoryFullName: "octo/example",
    environment: `env-${crypto.randomUUID().slice(0, 8)}`,
    createdByUserId: null,
  });
  return {
    organizationId,
    installation,
    releaseTarget,
    userId,
    repositoryId,
    token: (claims) => issuer.mint({ repository_id: String(repositoryId), ...claims }),
  };
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes as unknown as BufferSource);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function openSet(token: string, body: Record<string, unknown> = {}) {
  return call("/api/ci/v1/releases", { method: "POST", token, body });
}

// ── OIDC verification ────────────────────────────────────────────────────────

describe("CI ingest OIDC verification", () => {
  test("a valid token opens a release set bound to the run", async () => {
    const seeded = await seedLinkedRepository();
    const result = await openSet(seeded.token());

    expect(result.status).toBe(201);
    const set = result.body.releaseSet as Record<string, unknown>;
    expect(set.repositoryFullName).toBe("octo/example");
    expect(set.runId).toBe(9001);
    expect(set.status).toBe("open");
    // The repository's only release target auto-detects, so the set does too.
    expect(set.ecosystem).toBe("auto");

    const db = createDb(env.DB);
    const rows = await db.select().from(schema.ciReleaseSets);
    expect(rows).toHaveLength(1);
    expect(rows[0].organizationId).toBe(seeded.organizationId);
    // Signed provenance is persisted as evidence, not re-asserted by the caller.
    expect(rows[0].jobWorkflowRef).toBe(
      "octo/example/.github/workflows/release.yml@refs/heads/main",
    );
    expect(rows[0].sha).toBe("a".repeat(40));
  });

  test("no token is rejected", async () => {
    await seedLinkedRepository();
    const result = await call("/api/ci/v1/releases", { method: "POST", body: {} });
    expect(result.status).toBe(401);
    expect(String(result.body.hint)).toContain("id-token: write");
  });

  test("a token for another audience is rejected", async () => {
    const seeded = await seedLinkedRepository();
    const result = await openSet(seeded.token({ aud: "someone-else" }));
    expect(result.status).toBe(401);
    expect(result.body.reason).toBe("audience_mismatch");
  });

  test("a token from another issuer is rejected", async () => {
    const seeded = await seedLinkedRepository();
    const result = await openSet(seeded.token({ iss: "https://evil.test" }));
    expect(result.status).toBe(401);
    expect(result.body.reason).toBe("issuer_mismatch");
  });

  test("an expired token is rejected", async () => {
    const seeded = await seedLinkedRepository();
    const past = Math.floor(Date.now() / 1000) - 3600;
    const result = await openSet(seeded.token({ iat: past, nbf: past, exp: past + 60 }));
    expect(result.status).toBe(401);
    expect(result.body.reason).toBe("token_expired");
  });

  test("a token signed by an unpublished key is rejected", async () => {
    const seeded = await seedLinkedRepository();
    const result = await openSet(
      issuer.mintWithForeignKey({ repository_id: String(seeded.repositoryId) }),
    );
    expect(result.status).toBe(401);
    expect(result.body.reason).toBe("signature_invalid");
  });

  test("a token missing its repository binding is rejected", async () => {
    const seeded = await seedLinkedRepository();
    const result = await openSet(seeded.token({ repository_id: null }));
    expect(result.status).toBe(401);
    expect(result.body.reason).toBe("claims_missing");
  });

  test("an unreachable JWKS is a 503, so the Action retries instead of failing the release", async () => {
    const seeded = await seedLinkedRepository();
    const token = seeded.token();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("nope", { status: 500 })),
    );
    const result = await openSet(token);
    expect(result.status).toBe(503);
    expect(result.body.reason).toBe("jwks_unavailable");
  });
});

// ── organization resolution ──────────────────────────────────────────────────

describe("CI ingest organization resolution", () => {
  test("a repository with no release target cannot upload", async () => {
    // Seeded under a different id than the token claims, so nothing maps.
    await seedLinkedRepository({ repositoryId: 999 });
    const result = await openSet(issuer.mint({ repository_id: "424242" }));
    expect(result.status).toBe(403);
    expect(result.body.reason).toBe("repository_not_linked");
  });

  test("a repository claimed by two organizations fails closed", async () => {
    const first = await seedLinkedRepository();
    // A second organization maps the same repository id: no safe default.
    await seedLinkedRepository({ repositoryId: first.repositoryId });
    const result = await openSet(first.token());
    expect(result.status).toBe(403);
    expect(result.body.reason).toBe("repository_ambiguous");
  });

  test("a suspended installation cannot upload", async () => {
    const seeded = await seedLinkedRepository();
    const db = createDb(env.DB);
    await db
      .update(schema.githubAppInstallations)
      .set({ status: "suspended" })
      .where(eq(schema.githubAppInstallations.id, seeded.installation.id));
    const result = await openSet(seeded.token());
    expect(result.status).toBe(403);
    expect(result.body.reason).toBe("installation_inactive");
  });

  test("a pinned ecosystem is inherited from the repository's release targets", async () => {
    const db = createDb(env.DB);
    const seeded = await seedLinkedRepository();
    await db
      .update(schema.githubReleaseTargets)
      .set({ ecosystem: "npm" })
      .where(eq(schema.githubReleaseTargets.id, seeded.releaseTarget.id));
    const result = await openSet(seeded.token());
    expect((result.body.releaseSet as Record<string, unknown>).ecosystem).toBe("npm");
  });

  test("an unsupported explicit ecosystem is rejected", async () => {
    const seeded = await seedLinkedRepository();
    const result = await openSet(seeded.token(), { ecosystem: "cargo" });
    expect(result.status).toBe(400);
    expect(String(result.body.error)).toContain("cargo");
  });
});

// ── release-set lifecycle ────────────────────────────────────────────────────

describe("CI release-set lifecycle", () => {
  test("every job in one run converges on a single release set", async () => {
    const seeded = await seedLinkedRepository();
    const first = await openSet(seeded.token());
    const second = await openSet(seeded.token());

    expect(first.status).toBe(201);
    expect(second.status).toBe(200);
    expect((second.body.releaseSet as { id: string }).id).toBe(
      (first.body.releaseSet as { id: string }).id,
    );
    expect(second.body.created).toBe(false);

    const db = createDb(env.DB);
    const mine = (await db.select().from(schema.ciReleaseSets)).filter(
      (row) => row.repositoryId === seeded.repositoryId,
    );
    expect(mine).toHaveLength(1);
  });

  test("a release key separates independent releases from the same run", async () => {
    const seeded = await seedLinkedRepository();
    const a = await openSet(seeded.token(), { releaseKey: "server" });
    const b = await openSet(seeded.token(), { releaseKey: "client" });
    expect((a.body.releaseSet as { id: string }).id).not.toBe(
      (b.body.releaseSet as { id: string }).id,
    );
  });

  test("a re-run opens a fresh set rather than reopening the previous attempt", async () => {
    const seeded = await seedLinkedRepository();
    const first = await openSet(seeded.token());
    const rerun = await openSet(seeded.token({ run_attempt: "2" }));
    expect(rerun.status).toBe(201);
    expect((rerun.body.releaseSet as { id: string }).id).not.toBe(
      (first.body.releaseSet as { id: string }).id,
    );
  });

  test("uploading records the recomputed digest", async () => {
    const seeded = await seedLinkedRepository();
    const token = seeded.token();
    const opened = await openSet(token);
    const setId = (opened.body.releaseSet as { id: string }).id;

    const bytes = new TextEncoder().encode("not really a tarball");
    const digest = await sha256Hex(bytes);
    const uploaded = await call(`/api/ci/v1/releases/${setId}/artifacts/demo-1.0.0.tgz`, {
      method: "PUT",
      token,
      raw: bytes,
      headers: { "x-drydock-sha256": digest },
    });

    expect(uploaded.status).toBe(200);
    const db = createDb(env.DB);
    const artifacts = await listReleaseArtifacts(db, setId);
    expect(artifacts).toHaveLength(1);
    expect(artifacts[0].sha256).toBe(digest);
    expect(artifacts[0].sizeBytes).toBe(bytes.byteLength);
    expect(artifacts[0].storageKey).toBeTruthy();
    expect(await env.ARTIFACTS.get(artifacts[0].storageKey!)).not.toBeNull();
  });

  test("bytes that do not match the declared digest are refused", async () => {
    const seeded = await seedLinkedRepository();
    const token = seeded.token();
    const setId = ((await openSet(token)).body.releaseSet as { id: string }).id;

    const result = await call(`/api/ci/v1/releases/${setId}/artifacts/demo-1.0.0.tgz`, {
      method: "PUT",
      token,
      raw: new TextEncoder().encode("payload"),
      headers: { "x-drydock-sha256": "b".repeat(64) },
    });

    expect(result.status).toBe(422);
    const db = createDb(env.DB);
    expect(await listReleaseArtifacts(db, setId)).toHaveLength(0);
  });

  test("a traversal-shaped artifact name is refused", async () => {
    const seeded = await seedLinkedRepository();
    const token = seeded.token();
    const setId = ((await openSet(token)).body.releaseSet as { id: string }).id;
    const bytes = new TextEncoder().encode("payload");

    const result = await call(
      `/api/ci/v1/releases/${setId}/artifacts/${encodeURIComponent("../escape.tgz")}`,
      {
        method: "PUT",
        token,
        raw: bytes,
        headers: { "x-drydock-sha256": await sha256Hex(bytes) },
      },
    );
    expect(result.status).toBe(400);
  });

  test("a token from a different run cannot upload into this set", async () => {
    const seeded = await seedLinkedRepository();
    const token = seeded.token();
    const setId = ((await openSet(token)).body.releaseSet as { id: string }).id;
    const bytes = new TextEncoder().encode("payload");

    const result = await call(`/api/ci/v1/releases/${setId}/artifacts/demo-1.0.0.tgz`, {
      method: "PUT",
      token: seeded.token({ run_id: "9002" }),
      raw: bytes,
      headers: { "x-drydock-sha256": await sha256Hex(bytes) },
    });
    expect(result.status).toBe(403);
  });

  test("sealing enqueues the review and closes the set to further uploads", async () => {
    const seeded = await seedLinkedRepository();
    const sent: unknown[] = [];
    const testEnv = buildEnv({ queue: { send: async (message) => void sent.push(message) } });
    const token = seeded.token();
    const opened = await call("/api/ci/v1/releases", {
      method: "POST",
      token,
      body: {},
      env: testEnv,
    });
    const setId = (opened.body.releaseSet as { id: string }).id;

    const bytes = new TextEncoder().encode("payload");
    await call(`/api/ci/v1/releases/${setId}/artifacts/demo-1.0.0.tgz`, {
      method: "PUT",
      token,
      raw: bytes,
      headers: { "x-drydock-sha256": await sha256Hex(bytes) },
      env: testEnv,
    });

    const sealed = await call(`/api/ci/v1/releases/${setId}/seal`, {
      method: "POST",
      token,
      body: {},
      env: testEnv,
    });
    expect(sealed.status).toBe(200);
    expect(sealed.body.sealed).toBe(true);
    expect(sent).toEqual([
      { kind: "ci_release_set", organizationId: expect.any(String), releaseSetId: setId },
    ]);

    const late = await call(`/api/ci/v1/releases/${setId}/artifacts/late.tgz`, {
      method: "PUT",
      token,
      raw: bytes,
      headers: { "x-drydock-sha256": await sha256Hex(bytes) },
      env: testEnv,
    });
    expect(late.status).toBe(409);
  });

  test("sealing an empty set is refused", async () => {
    const seeded = await seedLinkedRepository();
    const token = seeded.token();
    const setId = ((await openSet(token)).body.releaseSet as { id: string }).id;
    const result = await call(`/api/ci/v1/releases/${setId}/seal`, {
      method: "POST",
      token,
      body: {},
    });
    expect(result.status).toBe(400);
  });

  test("re-sealing from a retried job is a no-op, not an error", async () => {
    const seeded = await seedLinkedRepository();
    const token = seeded.token();
    const setId = ((await openSet(token)).body.releaseSet as { id: string }).id;
    const bytes = new TextEncoder().encode("payload");
    await call(`/api/ci/v1/releases/${setId}/artifacts/demo-1.0.0.tgz`, {
      method: "PUT",
      token,
      raw: bytes,
      headers: { "x-drydock-sha256": await sha256Hex(bytes) },
    });

    await call(`/api/ci/v1/releases/${setId}/seal`, { method: "POST", token, body: {} });
    const again = await call(`/api/ci/v1/releases/${setId}/seal`, {
      method: "POST",
      token,
      body: {},
    });
    expect(again.status).toBe(200);
    expect(again.body.sealed).toBe(false);
  });
});

// ── publish-time verification ────────────────────────────────────────────────

describe("publish-time verification", () => {
  async function seededSetWithArtifact() {
    const seeded = await seedLinkedRepository();
    const token = seeded.token();
    const setId = ((await openSet(token)).body.releaseSet as { id: string }).id;
    const bytes = new TextEncoder().encode("reviewed bytes");
    const digest = await sha256Hex(bytes);
    await call(`/api/ci/v1/releases/${setId}/artifacts/demo-1.0.0.tgz`, {
      method: "PUT",
      token,
      raw: bytes,
      headers: { "x-drydock-sha256": digest },
    });
    // Verification compares against a fixed artifact list, so the set must be
    // sealed before the comparison means anything.
    await call(`/api/ci/v1/releases/${setId}/seal`, { method: "POST", token, body: {} });
    return { token, setId, digest };
  }

  test("an open set cannot be verified against", async () => {
    const seeded = await seedLinkedRepository();
    const token = seeded.token();
    const setId = ((await openSet(token)).body.releaseSet as { id: string }).id;
    const bytes = new TextEncoder().encode("reviewed bytes");
    const digest = await sha256Hex(bytes);
    await call(`/api/ci/v1/releases/${setId}/artifacts/demo-1.0.0.tgz`, {
      method: "PUT",
      token,
      raw: bytes,
      headers: { "x-drydock-sha256": digest },
    });

    const result = await call(`/api/ci/v1/releases/${setId}/verify`, {
      method: "POST",
      token,
      body: { artifacts: [{ path: "demo-1.0.0.tgz", sha256: digest }] },
    });
    expect(result.status).toBe(409);
    expect(String(result.body.error)).toContain("seal it");
  });

  test("matching digests verify", async () => {
    const { token, setId, digest } = await seededSetWithArtifact();
    const result = await call(`/api/ci/v1/releases/${setId}/verify`, {
      method: "POST",
      token,
      body: { artifacts: [{ path: "demo-1.0.0.tgz", sha256: digest }] },
    });
    expect(result.status).toBe(200);
    expect(result.body.ok).toBe(true);

    const db = createDb(env.DB);
    const [row] = await db
      .select()
      .from(schema.ciReleaseSets)
      .where(eq(schema.ciReleaseSets.id, setId));
    expect(row.verifiedAt).not.toBeNull();
  });

  test("a rebuilt artifact fails verification", async () => {
    const { token, setId } = await seededSetWithArtifact();
    const result = await call(`/api/ci/v1/releases/${setId}/verify`, {
      method: "POST",
      token,
      body: { artifacts: [{ path: "demo-1.0.0.tgz", sha256: "c".repeat(64) }] },
    });
    expect(result.status).toBe(409);
    expect(result.body.ok).toBe(false);
    expect(result.body.mismatches).toHaveLength(1);
  });

  test("an artifact Drydock never reviewed fails verification", async () => {
    const { token, setId, digest } = await seededSetWithArtifact();
    const result = await call(`/api/ci/v1/releases/${setId}/verify`, {
      method: "POST",
      token,
      body: {
        artifacts: [
          { path: "demo-1.0.0.tgz", sha256: digest },
          { path: "smuggled-9.9.9.tgz", sha256: "d".repeat(64) },
        ],
      },
    });
    expect(result.status).toBe(409);
    expect(
      (result.body.mismatches as { path: string; reviewed: string | null }[]).find(
        (entry) => entry.path === "smuggled-9.9.9.tgz",
      )?.reviewed,
    ).toBeNull();
  });

  test("a reviewed artifact missing at publish time fails verification", async () => {
    const { token, setId } = await seededSetWithArtifact();
    const result = await call(`/api/ci/v1/releases/${setId}/verify`, {
      method: "POST",
      token,
      body: { artifacts: [{ path: "other-1.0.0.tgz", sha256: "e".repeat(64) }] },
    });
    expect(result.status).toBe(409);
    const mismatches = result.body.mismatches as { path: string; publishing: string | null }[];
    expect(mismatches.find((entry) => entry.path === "demo-1.0.0.tgz")?.publishing).toBeNull();
  });
});
