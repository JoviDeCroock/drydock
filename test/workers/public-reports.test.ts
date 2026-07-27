import { env, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { Hono } from "hono";
import { describe, expect, test } from "vitest";
import { listOrganizationAuditEvents } from "../../server/db/audit-log";
import { createDb } from "../../server/db/client";
import { createOrganization, ensurePersonalOrganization } from "../../server/db/organizations";
import { createScanJob, persistScan } from "../../server/db/scans";
import * as schema from "../../server/db/schema";
import { describeAuditEvent } from "../../server/lib/auth/audit-events";
import { base64UrlDecode } from "../../server/lib/platform/crypto-utils";
import { publicReportsRoutes } from "../../server/routes/public-reports";
import { scansRoutes } from "../../server/routes/scans";
import type { Bindings, Variables } from "../../server/types";

interface SeededUser {
  userId: string;
  organizationId: string;
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

    // no-store keeps the "revocation is immediate" promise honest: no shared
    // cache may serve the report past the revoke.
    const report = await request(app, `/public/reports/${share.token}`);
    expect(report.headers.get("cache-control")).toBe("no-store");
    expect(report.headers.get("access-control-allow-origin")).toBe("*");

    const attestation = await request(app, `/public/reports/${share.token}/attestation`);
    expect(attestation.headers.get("cache-control")).toBe("no-store");
    expect(attestation.headers.get("access-control-allow-origin")).toBe("*");

    // The key rotates rarely and is safe to cache.
    const key = await request(app, `/public/attestation-key`);
    expect(key.headers.get("cache-control")).toBe("public, max-age=3600");
    expect(key.headers.get("access-control-allow-origin")).toBe("*");
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

    const reportRes = await request(app, `/public/reports/${share.token}`);
    const reportBytes = new Uint8Array(await reportRes.arrayBuffer());

    const attRes = await request(app, `/public/reports/${share.token}/attestation`);
    expect(attRes.status).toBe(200);
    const envelope = (await attRes.json()) as {
      payloadType: string;
      payload: string;
      signatures: Array<{ keyid: string; sig: string }>;
    };
    expect(envelope.payloadType).toBe("application/vnd.in-toto+json");
    expect(envelope.signatures).toHaveLength(1);
    // Standard base64, not base64url — what sigstore/in-toto verifiers expect.
    expect(envelope.payload).toMatch(/^[A-Za-z0-9+/]+=*$/);
    expect(envelope.signatures[0].sig).toMatch(/^[A-Za-z0-9+/]+=*$/);

    const keyRes = await request(app, `/public/attestation-key`);
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
    const payloadBytes = base64UrlDecode(envelope.payload);
    const statement = JSON.parse(new TextDecoder().decode(payloadBytes)) as {
      _type: string;
      subject: Array<{ name: string; digest: { sha256: string } }>;
      predicateType: string;
      predicate: { scanId: string; risk: string; reportSchema: string };
    };
    expect(statement._type).toBe("https://in-toto.io/Statement/v1");
    expect(statement.subject[0].name).toBe("@org/pkg@1.1.0");
    expect(statement.predicate.scanId).toBe(scanId);
    expect(statement.predicate.reportSchema).toBe("drydock.report.v2");
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
      base64UrlDecode(envelope.signatures[0].sig),
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

    const bare = { ...env, ATTESTATION_SIGNING_KEY_JWK: undefined } as typeof env;
    const attRes = await request(app, `/public/reports/${share.token}/attestation`, {}, bare);
    expect(attRes.status).toBe(503);
    const keyRes = await request(app, `/public/attestation-key`, {}, bare);
    expect(keyRes.status).toBe(503);

    // The report itself stays available without a key.
    const reportRes = await request(app, `/public/reports/${share.token}`, {}, bare);
    expect(reportRes.status).toBe(200);
  });
});
