import { env, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { Hono } from "hono";
import { eq } from "drizzle-orm";
import { describe, expect, test } from "vitest";
import { listOrganizationAuditEvents } from "../../server/db/audit-log";
import { createDb } from "../../server/db/client";
import { createOrganization, ensurePersonalOrganization } from "../../server/db/organizations";
import { createScanJob, persistScan } from "../../server/db/scans";
import * as schema from "../../server/db/schema";
import { describeAuditEvent } from "../../server/lib/auth/audit-events";
import { publicReportsRoutes } from "../../server/routes/public-reports";
import { scansRoutes } from "../../server/routes/scans";
import type { Bindings, Variables } from "../../server/types";

interface SeededUser {
  userId: string;
  organizationId: string;
}

// The signing key is generated per run rather than committed to
// wrangler.test.jsonc: a real private JWK in the repo is a permanent
// secret-scanning false positive. The default test env therefore has *no* key,
// which also makes the degraded path the one you get for free.
let signingEnvPromise: Promise<typeof env> | null = null;
function signingEnv(): Promise<typeof env> {
  signingEnvPromise ??= (async () => {
    const pair = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, [
      "sign",
      "verify",
    ])) as CryptoKeyPair;
    const jwk = await crypto.subtle.exportKey("jwk", pair.privateKey);
    return { ...env, ATTESTATION_SIGNING_KEY_JWK: JSON.stringify(jwk) } as typeof env;
  })();
  return signingEnvPromise;
}

// Strict standard-base64 decode: rejects the base64url alphabet outright, so a
// regression away from what sigstore/in-toto verifiers expect fails here rather
// than sliding through on a payload that happens to contain no `-` or `_`.
function strictBase64Decode(value: string): Uint8Array {
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(value) || value.length % 4 !== 0) {
    throw new Error(`not standard base64: ${value.slice(0, 32)}…`);
  }
  const binary = atob(value);
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

async function seedUser(): Promise<SeededUser> {
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
  return { userId, organizationId };
}

async function seedMember(organizationId: string, role: "admin" | "member"): Promise<SeededUser> {
  const db = createDb(env.DB);
  const member = await seedUser();
  const now = new Date();
  await db.insert(schema.organizationMembers).values({
    id: crypto.randomUUID(),
    organizationId,
    userId: member.userId,
    role,
    createdAt: now,
    updatedAt: now,
  });
  return { userId: member.userId, organizationId };
}

// The public routes are mounted without the auth/session middleware — exactly
// like server/index.ts mounts them ahead of the /api/* guards.
function buildTestApp(session: { userId: string } | null) {
  const app = new Hono<{ Bindings: Bindings; Variables: Variables }>();
  app.route("/public", publicReportsRoutes);
  if (session) {
    app.use("/api/*", async (c, next) => {
      c.set("authSession", { userId: session.userId });
      await next();
    });
    app.route("/api/v1/scans", scansRoutes);
  }
  return app;
}

async function request(
  app: Hono<{ Bindings: Bindings; Variables: Variables }>,
  path: string,
  options: RequestInit & { organizationId?: string } = {},
  overrideEnv: typeof env = env,
) {
  const ctx = createExecutionContext();
  const headers = new Headers(options.headers);
  if (!headers.has("content-type")) headers.set("content-type", "application/json");
  if (options.organizationId) headers.set("x-organization-id", options.organizationId);
  const res = await app.fetch(
    new Request(`http://test.local${path}`, { ...options, headers }),
    overrideEnv,
    ctx,
  );
  await waitOnExecutionContext(ctx);
  return res;
}

async function seedCompletedScan(owner: SeededUser): Promise<string> {
  const db = createDb(env.DB);
  const scanId = `scan_${crypto.randomUUID()}`;
  const stageId = `stage-${scanId.slice(-12)}`;
  await createScanJob(db, {
    id: scanId,
    stageId,
    organizationId: owner.organizationId,
    ownerUserId: owner.userId,
  });
  await persistScan(db, {
    id: scanId,
    stageId,
    organizationId: owner.organizationId,
    ownerUserId: owner.userId,
    packageJson: { name: "@org/pkg", version: "1.1.0" },
    risk: "high",
    status: "complete",
    summary: {
      report: {
        version: 1,
        digest: "abc123",
        digestAlgorithm: "sha256",
        generatedAt: "2026-01-01T00:00:00.000Z",
        rulesVersion: "1.8.0",
      },
      baseline: { kind: "registry", version: "1.0.0" },
      diff: [{ path: "package.json", status: "modified" }],
    },
    ai: null,
    files: [{ path: "package.json", size: 10, sha256: "a", flags: [], textSample: "{}" }],
    diff: [{ path: "package.json", status: "modified", flags: [] }],
    findings: [
      {
        severity: "high",
        file: "package.json",
        evidence: "postinstall: node install.js",
        reason: "install lifecycle hooks execute on consumer machines",
        ruleId: "install-script.lifecycle",
        ruleVersion: "1.8.0",
      },
    ],
    report: { version: 1, digest: "abc123" },
  });
  return scanId;
}

async function enableShare(app: ReturnType<typeof buildTestApp>, scanId: string) {
  const res = await request(app, `/api/v1/scans/${scanId}/share`, { method: "POST", body: "{}" });
  return res;
}

describe("public report sharing", () => {
  test("owner enables a share link, link serves the canonical report export", async () => {
    const owner = await seedUser();
    const scanId = await seedCompletedScan(owner);
    const app = buildTestApp(owner);

    const res = await enableShare(app, scanId);
    expect(res.status).toBe(200);
    const { share } = (await res.json()) as {
      share: { token: string; url: string; sharedAt: string };
    };
    expect(share.token).toMatch(/^[A-Za-z0-9_-]{40,}$/);
    expect(share.url).toBe(`http://example.com/reports/${share.token}`);

    const pub = await request(app, `/public/reports/${share.token}`);
    expect(pub.status).toBe(200);
    const text = await pub.text();
    const body = JSON.parse(text) as Record<string, unknown>;
    expect(body.schema).toBe("drydock.report.v2");
    expect((body.package as { name: string }).name).toBe("@org/pkg");
    // The export is the sharing boundary: no org/user identifiers, no events,
    // no file samples anywhere in the payload.
    expect(text).not.toContain(owner.organizationId);
    expect(text).not.toContain(owner.userId);
    expect(body.events).toBeUndefined();
    expect(body.files).toBeUndefined();

    // The public bytes match the authenticated canonical export exactly.
    const authed = await request(app, `/api/v1/scans/${scanId}/report.json`);
    expect(await authed.text()).toBe(text);
  });

  test("sharing is idempotent — the second call returns the same token", async () => {
    const owner = await seedUser();
    const scanId = await seedCompletedScan(owner);
    const app = buildTestApp(owner);

    const first = (await (await enableShare(app, scanId)).json()) as { share: { token: string } };
    const second = (await (await enableShare(app, scanId)).json()) as { share: { token: string } };
    expect(second.share.token).toBe(first.share.token);
  });

  test("share requires a completed scan and an existing scan", async () => {
    const owner = await seedUser();
    const db = createDb(env.DB);
    const scanId = `scan_${crypto.randomUUID()}`;
    await createScanJob(db, {
      id: scanId,
      stageId: `stage-${scanId.slice(-12)}`,
      organizationId: owner.organizationId,
      ownerUserId: owner.userId,
    });
    const app = buildTestApp(owner);

    expect((await enableShare(app, scanId)).status).toBe(409);
    expect((await enableShare(app, "scan_missing")).status).toBe(404);
  });

  test("plain members cannot enable or revoke, admins can", async () => {
    const owner = await seedUser();
    const db = createDb(env.DB);
    const organizationId = await createOrganization(db, {
      ownerUserId: owner.userId,
      name: "Team workspace",
    });
    const scanId = await seedCompletedScan({ ...owner, organizationId });
    const admin = await seedMember(organizationId, "admin");
    const member = await seedMember(organizationId, "member");

    const memberRes = await request(buildTestApp(member), `/api/v1/scans/${scanId}/share`, {
      method: "POST",
      body: "{}",
      organizationId,
    });
    expect(memberRes.status).toBe(403);

    const adminRes = await request(buildTestApp(admin), `/api/v1/scans/${scanId}/share`, {
      method: "POST",
      body: "{}",
      organizationId,
    });
    expect(adminRes.status).toBe(200);

    const memberRevoke = await request(buildTestApp(member), `/api/v1/scans/${scanId}/share`, {
      method: "DELETE",
      organizationId,
    });
    expect(memberRevoke.status).toBe(403);
  });

  test("another organization cannot share or revoke the scan", async () => {
    const owner = await seedUser();
    const scanId = await seedCompletedScan(owner);
    const outsider = await seedUser();
    const app = buildTestApp(outsider);

    expect((await enableShare(app, scanId)).status).toBe(404);
    const revoke = await request(app, `/api/v1/scans/${scanId}/share`, { method: "DELETE" });
    expect(revoke.status).toBe(404);
  });

  test("revoking invalidates the public link immediately", async () => {
    const owner = await seedUser();
    const scanId = await seedCompletedScan(owner);
    const app = buildTestApp(owner);

    const { share } = (await (await enableShare(app, scanId)).json()) as {
      share: { token: string };
    };
    expect((await request(app, `/public/reports/${share.token}`)).status).toBe(200);

    const revoke = await request(app, `/api/v1/scans/${scanId}/share`, { method: "DELETE" });
    expect(((await revoke.json()) as { revoked: boolean }).revoked).toBe(true);
    expect((await request(app, `/public/reports/${share.token}`)).status).toBe(404);

    // Revoking again reports nothing to revoke but stays a 200 (idempotent).
    const again = await request(app, `/api/v1/scans/${scanId}/share`, { method: "DELETE" });
    expect(((await again.json()) as { revoked: boolean }).revoked).toBe(false);
  });

  test("share enable/revoke are audited as scan events", async () => {
    const owner = await seedUser();
    const scanId = await seedCompletedScan(owner);
    const app = buildTestApp(owner);
    await enableShare(app, scanId);
    await request(app, `/api/v1/scans/${scanId}/share`, { method: "DELETE" });

    const detail = (await (await request(app, `/api/v1/scans/${scanId}`)).json()) as {
      events: Array<{ type: string }>;
    };
    const types = detail.events.map((event) => event.type);
    expect(types).toContain("scan.share_enabled");
    expect(types).toContain("scan.share_revoked");

    // Both events surface in the organization audit log — sharing a report
    // publicly is a governance action operators must be able to see.
    const { events } = await listOrganizationAuditEvents(createDb(env.DB), owner.organizationId);
    const shareEvents = events.filter((event) => event.type.startsWith("scan.share_"));
    expect(shareEvents.map((event) => event.type).sort()).toEqual([
      "scan.share_enabled",
      "scan.share_revoked",
    ]);
    for (const event of shareEvents) {
      const descriptor = describeAuditEvent(event.type, event.metadataJson);
      expect(descriptor).not.toBeNull();
      expect(descriptor?.category).toBe("security");
      expect(descriptor?.detail).toBe("@org/pkg@1.1.0");
    }
  });

  test("revoke followed by re-share issues a fresh token and kills the old link", async () => {
    const owner = await seedUser();
    const scanId = await seedCompletedScan(owner);
    const app = buildTestApp(owner);

    const first = (await (await enableShare(app, scanId)).json()) as { share: { token: string } };
    await request(app, `/api/v1/scans/${scanId}/share`, { method: "DELETE" });
    const second = (await (await enableShare(app, scanId)).json()) as { share: { token: string } };

    expect(second.share.token).not.toBe(first.share.token);
    expect((await request(app, `/public/reports/${first.share.token}`)).status).toBe(404);
    expect((await request(app, `/public/reports/${second.share.token}`)).status).toBe(200);
  });

  test("public responses carry CORS and uncacheable headers", async () => {
    const owner = await seedUser();
    const scanId = await seedCompletedScan(owner);
    const app = buildTestApp(owner);
    const { share } = (await (await enableShare(app, scanId)).json()) as {
      share: { token: string };
    };

    const signer = await signingEnv();

    // no-store keeps the "revocation is immediate" promise honest: no shared
    // cache may serve the report past the revoke.
    const report = await request(app, `/public/reports/${share.token}`);
    expect(report.headers.get("cache-control")).toBe("no-store");
    expect(report.headers.get("access-control-allow-origin")).toBe("*");

    const attestation = await request(
      app,
      `/public/reports/${share.token}/attestation`,
      {},
      signer,
    );
    expect(attestation.headers.get("cache-control")).toBe("no-store");
    expect(attestation.headers.get("access-control-allow-origin")).toBe("*");

    // The key rotates rarely and is safe to cache.
    const key = await request(app, `/public/attestation-key`, {}, signer);
    expect(key.headers.get("cache-control")).toBe("public, max-age=3600");
    expect(key.headers.get("access-control-allow-origin")).toBe("*");
  });

  test("failure responses are readable cross-origin", async () => {
    const app = buildTestApp(null);

    // A browser verifier following docs/public-reports.md has to be able to
    // tell "revoked" from "the service is down"; without CORS on the 404 both
    // are the same opaque network error.
    const notFound = await request(app, `/public/reports/${"C".repeat(43)}`);
    expect(notFound.status).toBe(404);
    expect(notFound.headers.get("access-control-allow-origin")).toBe("*");

    // No signing key configured in the default test env.
    const owner = await seedUser();
    const scanId = await seedCompletedScan(owner);
    const ownerApp = buildTestApp(owner);
    const { share } = (await (await enableShare(ownerApp, scanId)).json()) as {
      share: { token: string };
    };
    const degraded = await request(app, `/public/reports/${share.token}/attestation`);
    expect(degraded.status).toBe(503);
    expect(degraded.headers.get("access-control-allow-origin")).toBe("*");

    // retry-after has to be reachable from script, or a throttled verifier
    // cannot back off and just hot-loops.
    const ip = `10.1.0.${Math.floor(Math.random() * 200) + 1}`;
    const headers = { "cf-connecting-ip": ip };
    let throttled: Response | null = null;
    for (let i = 0; i < 125; i += 1) {
      const res = await request(app, `/public/reports/${"D".repeat(43)}`, { headers });
      if (res.status === 429) {
        throttled = res;
        break;
      }
    }
    expect(throttled).not.toBeNull();
    expect(throttled?.headers.get("access-control-allow-origin")).toBe("*");
    expect(throttled?.headers.get("access-control-expose-headers")).toContain("retry-after");
    expect(throttled?.headers.get("retry-after")).toBeTruthy();
  });

  test("concurrent enables settle on a single token", async () => {
    const owner = await seedUser();
    const scanId = await seedCompletedScan(owner);
    const app = buildTestApp(owner);

    // The guarded UPDATE's whole point: the loser re-reads and returns the
    // winner's token instead of silently rotating a link already in flight.
    const [first, second] = await Promise.all([enableShare(app, scanId), enableShare(app, scanId)]);
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    const a = (await first.json()) as { share: { token: string } };
    const b = (await second.json()) as { share: { token: string } };
    expect(a.share.token).toBe(b.share.token);
    expect((await request(app, `/public/reports/${a.share.token}`)).status).toBe(200);
  });

  test("the public export carries no prior-scan identifiers or decision times", async () => {
    const owner = await seedUser();
    const db = createDb(env.DB);
    const scanId = await seedCompletedScan(owner);
    // Release memory recorded against a prior scan the org never shared.
    await db
      .update(schema.scans)
      .set({
        summaryJson: {
          report: {
            version: 1,
            digest: "abc123",
            digestAlgorithm: "sha256",
            generatedAt: "2026-01-01T00:00:00.000Z",
            rulesVersion: "1.8.0",
          },
          releaseConsistency: {
            status: "subset",
            priorScanId: "scan_prior_secret",
            priorVersion: "1.0.0",
            decidedAt: "2026-03-04T09:12:31.004Z",
            currentFindingCount: 1,
            priorFindingCount: 1,
            newFindingCount: 0,
            newFindings: [],
          },
        },
      })
      .where(eq(schema.scans.id, scanId));

    const app = buildTestApp(owner);
    const { share } = (await (await enableShare(app, scanId)).json()) as {
      share: { token: string };
    };
    const res = await request(app, `/public/reports/${share.token}`);
    const text = await res.text();
    expect(text).not.toContain("scan_prior_secret");
    expect(text).not.toContain("2026-03-04T09:12:31.004Z");

    const consistency = (JSON.parse(text) as { releaseConsistency: Record<string, unknown> })
      .releaseConsistency;
    expect(consistency.status).toBe("subset");
    expect(consistency.priorScanId).toBeUndefined();
    expect(consistency.decidedAt).toBeUndefined();
  });

  test("unknown and malformed tokens return 404", async () => {
    const app = buildTestApp(null);
    const wellFormed = "A".repeat(43);
    expect((await request(app, `/public/reports/${wellFormed}`)).status).toBe(404);
    expect((await request(app, `/public/reports/short`)).status).toBe(404);
    expect((await request(app, `/public/reports/${"%2e".repeat(20)}`)).status).toBe(404);
  });

  test("public reads are rate limited per IP", async () => {
    const app = buildTestApp(null);
    const ip = `10.0.0.${Math.floor(Math.random() * 200) + 1}`;
    const headers = { "cf-connecting-ip": ip };
    let limited = false;
    for (let i = 0; i < 125; i += 1) {
      const res = await request(app, `/public/reports/${"B".repeat(43)}`, { headers });
      if (res.status === 429) {
        limited = true;
        break;
      }
      expect(res.status).toBe(404);
    }
    expect(limited).toBe(true);
  });
});

describe("public report attestations", () => {
  test("attestation verifies against the served report bytes and published key", async () => {
    const owner = await seedUser();
    const scanId = await seedCompletedScan(owner);
    const app = buildTestApp(owner);
    const { share } = (await (await enableShare(app, scanId)).json()) as {
      share: { token: string };
    };

    const signer = await signingEnv();
    const reportRes = await request(app, `/public/reports/${share.token}`);
    const reportBytes = new Uint8Array(await reportRes.arrayBuffer());

    const attRes = await request(app, `/public/reports/${share.token}/attestation`, {}, signer);
    expect(attRes.status).toBe(200);
    const envelope = (await attRes.json()) as {
      payloadType: string;
      payload: string;
      signatures: Array<{ keyid: string; sig: string }>;
    };
    expect(envelope.payloadType).toBe("application/vnd.in-toto+json");
    expect(envelope.signatures).toHaveLength(1);

    const keyRes = await request(app, `/public/attestation-key`, {}, signer);
    expect(keyRes.status).toBe(200);
    const published = (await keyRes.json()) as {
      keyId: string;
      algorithm: string;
      jwk: JsonWebKey;
    };
    expect(published.algorithm).toBe("Ed25519");
    expect(envelope.signatures[0].keyid).toBe(published.keyId);
    // The published key is public material only.
    expect((published.jwk as { d?: string }).d).toBeUndefined();

    // Statement subject digest matches the exact bytes the public route serves.
    // Decoded strictly as standard base64 — sigstore/in-toto verifiers expect
    // that alphabet, and a base64url regression must not slide through on a
    // payload that happens to contain no `-` or `_`.
    const payloadBytes = strictBase64Decode(envelope.payload);
    const statement = JSON.parse(new TextDecoder().decode(payloadBytes)) as {
      _type: string;
      subject: Array<{ name: string; digest: { sha256: string } }>;
      predicateType: string;
      predicate: { scanId: string; risk: string; reportSchema: string; issuedAt: string };
    };
    expect(statement._type).toBe("https://in-toto.io/Statement/v1");
    expect(statement.subject[0].name).toBe("@org/pkg@1.1.0");
    expect(statement.predicate.scanId).toBe(scanId);
    expect(statement.predicate.reportSchema).toBe("drydock.report.v2");
    // Archived envelopes must be orderable without an out-of-band timestamp.
    expect(Number.isNaN(Date.parse(statement.predicate.issuedAt))).toBe(false);
    const digest = new Uint8Array(
      await crypto.subtle.digest("SHA-256", reportBytes as Uint8Array<ArrayBuffer>),
    );
    const hex = [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("");
    expect(statement.subject[0].digest.sha256).toBe(hex);

    // Independent DSSE PAE construction + WebCrypto verification.
    const encoder = new TextEncoder();
    const typeBytes = encoder.encode(envelope.payloadType);
    const header = encoder.encode(
      `DSSEv1 ${typeBytes.length} ${envelope.payloadType} ${payloadBytes.length} `,
    );
    const pae = new Uint8Array(header.length + payloadBytes.length);
    pae.set(header, 0);
    pae.set(payloadBytes, header.length);
    const publicKey = await crypto.subtle.importKey(
      "jwk",
      published.jwk,
      { name: "Ed25519" },
      false,
      ["verify"],
    );
    const valid = await crypto.subtle.verify(
      "Ed25519",
      publicKey,
      strictBase64Decode(envelope.signatures[0].sig),
      pae,
    );
    expect(valid).toBe(true);
  });

  test("attestation endpoints return 503 when no signing key is configured", async () => {
    const owner = await seedUser();
    const scanId = await seedCompletedScan(owner);
    const app = buildTestApp(owner);
    const { share } = (await (await enableShare(app, scanId)).json()) as {
      share: { token: string };
    };

    // The default test env carries no key — the same shape as an operator who
    // has not run `wrangler secret put ATTESTATION_SIGNING_KEY_JWK`.
    const attRes = await request(app, `/public/reports/${share.token}/attestation`);
    expect(attRes.status).toBe(503);
    const keyRes = await request(app, `/public/attestation-key`);
    expect(keyRes.status).toBe(503);

    // The report itself stays available without a key.
    const reportRes = await request(app, `/public/reports/${share.token}`);
    expect(reportRes.status).toBe(200);
  });

  test("a malformed signing key degrades like an absent one", async () => {
    const owner = await seedUser();
    const scanId = await seedCompletedScan(owner);
    const app = buildTestApp(owner);
    const { share } = (await (await enableShare(app, scanId)).json()) as {
      share: { token: string };
    };

    const signer = await signingEnv();
    const good = JSON.parse(signer.ATTESTATION_SIGNING_KEY_JWK as string) as JsonWebKey;
    const malformed: Array<Record<string, unknown>> = [
      { not: "json at all" },
      { ...good, kty: "EC" },
      { ...good, crv: "P-256" },
      { ...good, d: undefined },
      { ...good, d: "not-valid-base64url-key-material" },
    ];
    for (const jwk of malformed) {
      const broken = { ...env, ATTESTATION_SIGNING_KEY_JWK: JSON.stringify(jwk) } as typeof env;
      const att = await request(app, `/public/reports/${share.token}/attestation`, {}, broken);
      expect(att.status).toBe(503);
      expect((await request(app, `/public/attestation-key`, {}, broken)).status).toBe(503);
    }

    // Not even a parse failure escapes as a 500.
    const garbage = { ...env, ATTESTATION_SIGNING_KEY_JWK: "{not json" } as typeof env;
    expect(
      (await request(app, `/public/reports/${share.token}/attestation`, {}, garbage)).status,
    ).toBe(503);
  });

  test("attestations die with the share link", async () => {
    const owner = await seedUser();
    const scanId = await seedCompletedScan(owner);
    const app = buildTestApp(owner);
    const { share } = (await (await enableShare(app, scanId)).json()) as {
      share: { token: string };
    };
    const signer = await signingEnv();

    expect(
      (await request(app, `/public/reports/${share.token}/attestation`, {}, signer)).status,
    ).toBe(200);
    await request(app, `/api/v1/scans/${scanId}/share`, { method: "DELETE" });
    expect(
      (await request(app, `/public/reports/${share.token}/attestation`, {}, signer)).status,
    ).toBe(404);
  });
});
