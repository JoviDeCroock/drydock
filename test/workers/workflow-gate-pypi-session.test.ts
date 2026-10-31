import { env } from "cloudflare:test";
import { and, eq } from "drizzle-orm";
import { afterEach, describe, expect, test, vi } from "vitest";
import { getScan } from "../../server/db/scans";
import { addOrganizationMember } from "../../server/db/invitations";
import {
  insertPyPiProjectToken,
  upsertPyPiStageSession,
} from "../../server/db/pypi-stage-sessions";
import * as schema from "../../server/db/schema";
import { sealPyPiToken } from "../../server/lib/ecosystems/pypi/project-token";
import {
  publishManagedSessions,
  sweepManagedSessions,
} from "../../server/lib/ecosystems/pypi/session-lifecycle";
import {
  getGateForOrganization,
  listGatePackageScans,
} from "../../server/lib/github-app/webhook-gates";
import { executeWorkflowGateJob, runHeldReleaseUpkeep } from "../../server/lib/workflow-gate-job";
import { githubAppRoutes } from "../../server/routes/github-app";
import { pypiProjectTokenRoutes } from "../../server/routes/pypi-project-tokens";
import type { Bindings } from "../../server/types";
import {
  FAKE_SESSION_TOKEN,
  FAKE_STAGE_TOKEN,
  type FakeUploadSession,
  type FakeUploadSessionOptions,
  buildFakeUploadSession,
  fakePyPiToken,
  sha256HexOf,
  stageReference,
} from "../helpers/pep694-fake";
import { buildTestApp, call } from "./helpers/app";
import { buildCtxWithGateway } from "./helpers/gate";
import {
  type PyPiStageScenario,
  SDIST,
  WHEEL,
  githubAppBindings,
  runPyPiStageGate,
  stagedBytes,
} from "./helpers/pypi-stage-gate";
import { type SeededUser, seedUser } from "./helpers/seed";

const STAGE_URL = `https://pypi.org/stage/${FAKE_STAGE_TOKEN}/`;
const FILES_ROOT = `https://files.pythonhosted.org/stage-files/${FAKE_STAGE_TOKEN}/`;
const PYPI_TOKEN = fakePyPiToken(["demo-package"]);
const MINUTE = 60 * 1000;

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

async function seedProjectToken(owner: SeededUser, token = PYPI_TOKEN) {
  const row = await insertPyPiProjectToken(owner.db, {
    organizationId: owner.organizationId,
    projectName: "demo-package",
    indexOrigin: "https://pypi.org",
    ...(await sealPyPiToken(env, token)),
    validatedAt: new Date(),
    lastUsedAt: null,
    createdByUserId: owner.userId,
  });
  if (!row) throw new Error("token seed failed");
  return row;
}

interface ManagedScenario extends PyPiStageScenario {
  session?: Partial<FakeUploadSessionOptions>;
  /** The `session-url` the artifact registers; defaults to the fake session. */
  sessionUrl?: (session: FakeUploadSession) => string;
  storeToken?: boolean;
  /** Mutable staged digests served by the stage page (filename → sha256). */
  digests?: Map<string, string>;
  /** Called before each stage page answer with its 1-based read count. */
  onPageRead?: (count: number, digests: Map<string, string>) => void;
}

async function runManaged(options: ManagedScenario = {}) {
  const session = buildFakeUploadSession({
    stageUrl: STAGE_URL,
    filenames: [WHEEL, SDIST],
    ...options.session,
  });
  const digests =
    options.digests ??
    new Map([
      [WHEEL, await sha256HexOf(stagedBytes(WHEEL))],
      [SDIST, await sha256HexOf(stagedBytes(SDIST))],
    ]);
  let pageReads = 0;
  const run = await runPyPiStageGate({
    ...options,
    beforeRun: async (owner) => {
      if (options.storeToken !== false) await seedProjectToken(owner);
    },
    page: () => {
      pageReads += 1;
      options.onPageRead?.(pageReads, digests);
      return Response.json(
        {
          meta: { "api-version": "1.1" },
          name: "demo-package",
          files: [...digests].map(([filename, sha256]) => ({
            filename,
            url: `${FILES_ROOT}${filename}`,
            hashes: { sha256 },
          })),
        },
        { headers: { "content-type": "application/vnd.pypi.simple.v1+json" } },
      );
    },
    reference: (stageUrl) =>
      stageReference([
        {
          name: "demo-package",
          version: "1.2.0",
          stageUrl,
          sessionUrl: options.sessionUrl ? options.sessionUrl(session) : session.sessionUrl,
        },
      ]),
    routes: { ...session.routes, ...options.routes },
  });
  return { ...run, session, digests };
}

type ManagedRun = Awaited<ReturnType<typeof runManaged>>;

async function sessionRows(run: ManagedRun) {
  return run.db
    .select()
    .from(schema.pypiStageSessions)
    .where(eq(schema.pypiStageSessions.gateId, run.gateId));
}

const gateApp = (owner: SeededUser) =>
  buildTestApp((app) => app.route("/api/v1/github-app", githubAppRoutes), {
    userId: owner.userId,
    emailVerified: true,
  });

// Inline delivery (no queue) so the GitHub decision lands on the stubbed callback.
const routeEnv = (): Partial<Bindings> =>
  ({ ...githubAppBindings(), SCAN_QUEUE: undefined }) as unknown as Partial<Bindings>;

async function decide(run: ManagedRun, decision: "approved" | "rejected", scanId?: string) {
  const [pkg] = await listGatePackageScans(run.db, run.owner.organizationId, run.gateId);
  const res = await call(
    gateApp(run.owner),
    "POST",
    `/api/v1/github-app/workflow-gates/${run.gateId}/decision`,
    {
      body: { decision, scanId: scanId ?? pkg.scanId },
      activeOrganizationId: run.owner.organizationId,
      envOverride: routeEnv(),
    },
  );
  return { res, body: (await res.json()) as Record<string, unknown> };
}

/** A second package on the same gate: a copy of the reviewed scan. */
async function addSiblingPackage(run: ManagedRun): Promise<[string, string]> {
  const [first] = await run.db
    .select()
    .from(schema.scans)
    .where(eq(schema.scans.gateId, run.gateId));
  const siblingId = crypto.randomUUID();
  await run.db.insert(schema.scans).values({
    ...first,
    id: siblingId,
    stageId: `${first.stageId}-sibling`,
    packageName: "sibling",
  });
  return [first.id, siblingId];
}

/** The gate as a decision route would leave it after the approval CAS. */
async function markApprovedAt(run: ManagedRun, decidedAt: number) {
  await run.db
    .update(schema.githubWorkflowGates)
    .set({ status: "approved", decision: "approved", decidedAt: new Date(decidedAt) })
    .where(eq(schema.githubWorkflowGates.id, run.gateId));
}

const inlineEnv = (run: ManagedRun) =>
  ({ ...run.gateEnv, SCAN_QUEUE: undefined }) as unknown as Cloudflare.Env;

const publishPosts = (run: ManagedRun) =>
  run.session.requests.filter((request) => request.url.endsWith("/publish"));

/** Every request that carried the PyPI token went to the fake session itself. */
function expectTokenOnlyToSession(run: ManagedRun) {
  const bearing = run.calls.filter((entry) => entry.authorization?.includes(PYPI_TOKEN));
  for (const entry of bearing) expect(entry.url.startsWith(run.session.sessionUrl)).toBe(true);
}

async function expectNoSecretLeak(run: ManagedRun, extra: string[] = []) {
  const events = await run.readEvents();
  const rows = await sessionRows(run);
  const surfaces = [
    run.gate?.failureReason ?? "",
    run.gate?.decisionComment ?? "",
    JSON.stringify(run.decisions),
    JSON.stringify(events),
    JSON.stringify(rows.map(({ linksCiphertext: _c, linksNonce: _n, ...rest }) => rest)),
    ...run.logs,
    ...extra,
  ];
  for (const surface of surfaces) {
    expect(surface).not.toContain(PYPI_TOKEN);
    expect(surface).not.toContain(FAKE_SESSION_TOKEN);
    expect(surface).not.toContain(FAKE_STAGE_TOKEN);
  }
}

function expectRejectedSessionMismatch(run: ManagedRun, detail: RegExp) {
  expect(run.gate?.status).toBe("rejected");
  expect(run.gate?.failureReason).toMatch(/^stage_session_mismatch: /);
  expect(run.gate?.failureReason).toMatch(detail);
  expect(run.decisions.map((decision) => decision.state)).toEqual(["rejected"]);
}

describe("PEP 694 mode B: registration", () => {
  test("holds the session when the organization stores a token for the project", async () => {
    const run = await runManaged();

    expect(run.gate?.status).toBe("pending");
    const [row] = await sessionRows(run);
    expect(row).toMatchObject({ state: "held", projectName: "demo-package", version: "1.2.0" });
    expect(row.sessionFingerprint).toMatch(/^[0-9a-f]{16}$/);
    expect(row.reviewedFilesJson).toEqual(
      expect.arrayContaining([{ filename: WHEEL, sha256: run.digests.get(WHEEL) }]),
    );
    expect(run.session.requests).toEqual([
      { method: "GET", url: run.session.sessionUrl, authorization: `Bearer ${PYPI_TOKEN}` },
    ]);
    expect(run.events.map((event) => event.type)).toContain("pypi_session.held");

    const persisted = await getScan(
      run.db,
      run.gate!.scanId!,
      run.owner.organizationId,
      env.ARTIFACTS,
    );
    const provenance = (
      persisted?.scan.summaryJson as { stagedPublish?: { provenance?: { stage?: unknown } } }
    )?.stagedPublish?.provenance;
    expect(provenance?.stage).toEqual({
      protocol: "pep694",
      index: "https://pypi.org",
      artifactBound: false,
      managed: true,
    });

    const res = await call(
      gateApp(run.owner),
      "GET",
      `/api/v1/github-app/workflow-gates/by-scan/${run.gate!.scanId}`,
      { activeOrganizationId: run.owner.organizationId },
    );
    const text = await res.text();
    expect(JSON.parse(text).gate.heldReleases).toEqual([
      expect.objectContaining({ ecosystem: "pypi", projectName: "demo-package", state: "held" }),
    ]);
    expectTokenOnlyToSession(run);
    await expectNoSecretLeak(run, [text, JSON.stringify(persisted)]);
  });

  test("without a stored token the session-url is ignored and the gate stays credential-free", async () => {
    const run = await runManaged({ storeToken: false });

    expect(run.gate?.status).toBe("pending");
    expect(run.session.requests).toEqual([]);
    expect(await sessionRows(run)).toEqual([]);
  });

  test.each([
    ["a foreign host", () => "https://evil.example/2.0/sessions/abc"],
    ["a look-alike host", () => "https://upload.pypi.org.evil.example/2.0/sessions/abc"],
    ["plain http", () => `http://upload.pypi.org/2.0/sessions/${FAKE_SESSION_TOKEN}`],
    ["another index's upload origin", () => "https://test.pypi.org/2.0/sessions/abc"],
    ["a query string", (s: FakeUploadSession) => `${s.sessionUrl}?to=https://evil.example`],
  ])("a session-url on %s is rejected and never receives the token", async (_label, sessionUrl) => {
    const run = await runManaged({ sessionUrl });

    expectRejectedSessionMismatch(run, /not an allowed Upload 2\.0 URL/);
    expect(run.calls.some((entry) => entry.authorization?.includes(PYPI_TOKEN))).toBe(false);
    expect(run.calls.some((entry) => entry.url.includes("evil.example"))).toBe(false);
    expect(await sessionRows(run)).toEqual([]);
    await expectNoSecretLeak(run);
  });

  test("a session that redirects never forwards the token", async () => {
    const evil: string[] = [];
    const run = await runManaged({
      session: {
        respond: () =>
          new Response(null, { status: 307, headers: { location: "https://evil.example/steal" } }),
      },
      routes: {
        "https://evil.example": (request) => {
          evil.push(request.headers.get("authorization") ?? "");
          return new Response("ok");
        },
      },
    });

    expectRejectedSessionMismatch(run, /redirect/);
    expect(evil).toEqual([]);
    expectTokenOnlyToSession(run);
    expect(await sessionRows(run)).toEqual([]);
  });

  test("a session bound to a different stage is rejected", async () => {
    const run = await runManaged({
      session: { links: { stage: "https://pypi.org/stage/someone-elses/" } },
    });
    expectRejectedSessionMismatch(run, /stage link is not the stage Drydock reviewed/);
    expect(await sessionRows(run)).toEqual([]);
  });

  test("a session carrying a file the review did not see is rejected", async () => {
    const run = await runManaged({
      session: { filenames: [WHEEL, SDIST, "demo_package-1.2.0-cp312-abi3-linux_x86_64.whl"] },
    });
    expectRejectedSessionMismatch(run, /in the session but was not reviewed/);
  });

  test("a session that is not open is rejected", async () => {
    const run = await runManaged({ session: { status: "processing" } });
    expectRejectedSessionMismatch(run, /not open/);
  });
});

describe("PEP 694 mode B: human decisions", () => {
  test("approval re-verifies the session and stage, then publishes (201)", async () => {
    const run = await runManaged();
    const { res, body } = await decide(run, "approved");

    expect(res.status).toBe(200);
    expect((body.gate as { status: string }).status).toBe("approved");
    const [row] = await sessionRows(run);
    expect(row.state).toBe("published");
    // Registration, the pre-record check, the post-CAS re-check, then publish.
    expect(run.session.requests.map((request) => request.method)).toEqual([
      "GET",
      "GET",
      "GET",
      "POST",
    ]);
    expect(run.session.requests[3].url).toBe(`${run.session.sessionUrl}/publish`);
    expect(run.decisions.map((decision) => decision.state)).toEqual(["approved"]);
    expect(run.stage.requests.filter((url) => url.endsWith("/demo-package/"))).toHaveLength(3);
    const published = (await run.readEvents()).find(
      (event) => event.type === "pypi_session.published",
    );
    const [publishedEvent] = await run.db
      .select({ actorUserId: schema.scanEvents.actorUserId })
      .from(schema.scanEvents)
      .where(eq(schema.scanEvents.type, "pypi_session.published"));
    expect(published).toBeDefined();
    expect(publishedEvent.actorUserId).toBe(run.owner.userId);
    const [delivered] = await run.db
      .select({ at: schema.githubWorkflowGates.decisionDeliveredAt })
      .from(schema.githubWorkflowGates)
      .where(eq(schema.githubWorkflowGates.id, run.gateId));
    expect(delivered.at).not.toBeNull();
    expectTokenOnlyToSession(run);
    await expectNoSecretLeak(run, [JSON.stringify(body)]);
  });

  test("approval waits through 202 until the index reports published", async () => {
    const run = await runManaged({ session: { publish: 202, afterPublish: "published" } });
    const { res } = await decide(run, "approved");

    expect(res.status).toBe(200);
    expect((await sessionRows(run))[0].state).toBe("published");
  });

  test("a 202 that ends in an index error turns the approval into a fail-closed rejection", async () => {
    const run = await runManaged({ session: { publish: 202, afterPublish: "error" } });
    const { res, body } = await decide(run, "approved");

    expect(res.status).toBe(409);
    expect(body.code).toBe("held_release_not_publishable");
    expect((body.gate as { status: string; heldReleases: unknown[] }).status).toBe("rejected");
    expect((body.gate as { heldReleases: Array<{ state: string }> }).heldReleases[0].state).toBe(
      "error",
    );
    expect((await sessionRows(run))[0].state).toBe("error");
    expect(run.decisions.map((decision) => decision.state)).toEqual(["rejected"]);
  });

  test("a 409 from publish rejects the gate and records the error", async () => {
    const run = await runManaged({ session: { publish: 409 } });
    const { res, body } = await decide(run, "approved");

    expect(res.status).toBe(409);
    expect(body.error).toMatch(/HTTP 409/);
    expect((await sessionRows(run))[0].state).toBe("error");
    expect(run.decisions.map((decision) => decision.state)).toEqual(["rejected"]);
    expect(
      (await run.readEvents()).filter((event) => event.type === "github_workflow_gate.rejected"),
    ).toHaveLength(1);
  });

  test("bytes that change after the approval is recorded are not published and the gate is rejected", async () => {
    // Read 1: review; read 2: pre-record check; read 3: the post-CAS re-check.
    const run = await runManaged({
      onPageRead: (count, digests) => {
        if (count === 3) digests.set(WHEEL, "f".repeat(64));
      },
    });
    const { res, body } = await decide(run, "approved");

    expect(res.status).toBe(409);
    expect((body.gate as { status: string }).status).toBe("rejected");
    expect((await sessionRows(run))[0].state).toBe("stale");
    expect(publishPosts(run)).toEqual([]);
    expect(run.decisions.map((decision) => decision.state)).toEqual(["rejected"]);
  });

  test("a transport failure after PyPI accepted the publish is resolved, not handed back as held", async () => {
    let session: FakeUploadSession | null = null;
    const run = await runManaged({
      session: {
        respond: (request) => {
          if (request.method !== "POST" || !request.url.endsWith("/publish")) return null;
          session!.state.status = "published";
          return new Response("upstream reset", { status: 503 });
        },
      },
    });
    session = run.session;
    const { res } = await decide(run, "approved");

    expect(res.status).toBe(200);
    expect((await sessionRows(run))[0].state).toBe("published");
    expect(run.decisions.map((decision) => decision.state)).toEqual(["approved"]);
  });

  test("racing approvals of sibling packages publish exactly once and never leave the gate approved but held", async () => {
    const run = await runManaged();
    const [first, sibling] = await addSiblingPackage(run);
    const results = await Promise.all([
      decide(run, "approved", first),
      decide(run, "approved", sibling),
    ]);

    const gate = await run.db
      .select({ status: schema.githubWorkflowGates.status })
      .from(schema.githubWorkflowGates)
      .where(eq(schema.githubWorkflowGates.id, run.gateId));
    expect(gate[0].status).toBe("approved");
    expect((await sessionRows(run))[0].state).toBe("published");
    expect(publishPosts(run)).toHaveLength(1);
    expect(results.filter((result) => result.res.status === 200).length).toBeGreaterThan(0);
    expect(run.decisions.map((decision) => decision.state)).toEqual(["approved"]);
  });

  test("an approval racing a rejection of the same package publishes only if the approval won", async () => {
    const run = await runManaged();
    const [first, sibling] = await addSiblingPackage(run);
    expect((await decide(run, "approved", sibling)).res.status).toBe(200);
    const results = await Promise.all([
      decide(run, "approved", first),
      decide(run, "rejected", first),
    ]);

    expect(results.map((result) => result.res.status).sort()).toEqual([200, 409]);
    const [gate] = await run.db
      .select({ status: schema.githubWorkflowGates.status })
      .from(schema.githubWorkflowGates)
      .where(eq(schema.githubWorkflowGates.id, run.gateId));
    const [row] = await sessionRows(run);
    expect(run.decisions.map((decision) => decision.state)).toEqual([gate.status]);
    if (gate.status === "approved") {
      expect(publishPosts(run)).toHaveLength(1);
      expect(row.state).toBe("published");
      expect(run.session.requests.some((request) => request.method === "DELETE")).toBe(false);
    } else {
      expect(gate.status).toBe("rejected");
      expect(publishPosts(run)).toEqual([]);
      expect(["canceled", "canceling"]).toContain(row.state);
    }
  });

  test("a publish that fails with 503 while the session stays open rejects the gate", async () => {
    const run = await runManaged({
      session: {
        respond: (request) =>
          request.method === "POST" && request.url.endsWith("/publish")
            ? new Response("unavailable", { status: 503 })
            : null,
      },
    });
    const { res, body } = await decide(run, "approved");

    expect(res.status).toBe(409);
    expect((body.gate as { status: string }).status).toBe("rejected");
    expect((await sessionRows(run))[0]).toMatchObject({
      state: "error",
      stateDetail: "PyPI did not accept the publish",
    });
    expect(run.decisions.map((decision) => decision.state)).toEqual(["rejected"]);
  });

  test("rejection also cancels a session that went stale", async () => {
    const run = await runManaged();
    run.digests.set(WHEEL, "f".repeat(64));
    expect((await decide(run, "approved")).res.status).toBe(409);
    expect((await sessionRows(run))[0].state).toBe("stale");

    const { res } = await decide(run, "rejected");
    expect(res.status).toBe(200);
    expect((await sessionRows(run))[0].state).toBe("canceled");
    expect(run.session.requests.at(-1)?.method).toBe("DELETE");
  });

  test("a partial approval returns the held releases with the still-pending gate", async () => {
    const run = await runManaged();
    const [first] = await addSiblingPackage(run);
    const { res, body } = await decide(run, "approved", first);

    expect(res.status).toBe(200);
    const gate = body.gate as { status: string; heldReleases: Array<{ state: string }> };
    expect(gate.status).toBe("pending");
    expect(gate.heldReleases.map((release) => release.state)).toEqual(["held"]);
    expect(publishPosts(run)).toEqual([]);
  });

  test("staged bytes that changed since review mark the session stale and refuse approval", async () => {
    const run = await runManaged();
    run.digests.set(WHEEL, "f".repeat(64));
    const { res, body } = await decide(run, "approved");

    expect(res.status).toBe(409);
    expect(body.error).toMatch(/changed since review/);
    const [row] = await sessionRows(run);
    expect(row.state).toBe("stale");
    expect(run.session.requests.some((request) => request.method === "POST")).toBe(false);
    expect((await run.readEvents()).map((event) => event.type)).toContain("pypi_session.stale");
  });

  test("a file replaced in the session since review marks it stale", async () => {
    const run = await runManaged();
    run.session.state.files.set("demo_package-1.2.0-py2-none-any.whl", "completed");
    const { res } = await decide(run, "approved");

    expect(res.status).toBe(409);
    expect((await sessionRows(run))[0].state).toBe("stale");
  });

  test("rejection cancels the held session", async () => {
    const run = await runManaged();
    const { res } = await decide(run, "rejected");

    expect(res.status).toBe(200);
    expect((await sessionRows(run))[0].state).toBe("canceled");
    expect(run.session.requests.at(-1)).toEqual({
      method: "DELETE",
      url: run.session.sessionUrl,
      authorization: `Bearer ${PYPI_TOKEN}`,
    });
    expect(run.decisions.map((decision) => decision.state)).toEqual(["rejected"]);
  });

  test("rejection of a session the index already dropped settles as canceled", async () => {
    const run = await runManaged();
    run.session.state.gone = true;
    await decide(run, "rejected");

    expect((await sessionRows(run))[0]).toMatchObject({
      state: "canceled",
      stateDetail: "the session was already gone",
    });
  });
});

describe("PEP 694 mode B: cron upkeep", () => {
  const sweepAt = (run: ManagedRun, offsetMs: number) =>
    sweepManagedSessions(run.gateEnv, run.db, { now: Date.now() + offsetMs });

  test("extends a held session close to expiry, once per interval", async () => {
    const run = await runManaged({ session: { expiresAt: new Date(Date.now() + 60 * MINUTE) } });

    await sweepAt(run, 11 * MINUTE);
    const [extended] = await sessionRows(run);
    expect(extended.state).toBe("held");
    expect(extended.lastExtendedAt).not.toBeNull();
    expect(extended.expiresAt!.getTime()).toBeGreaterThan(Date.now() + 6 * 24 * 60 * MINUTE);
    run.session.state.expiresAt = new Date(Date.now() + 60 * MINUTE);

    await sweepAt(run, 22 * MINUTE);
    const extends_ = run.session.requests.filter((request) => request.url.endsWith("/extend"));
    expect(extends_).toHaveLength(1);
    expect(run.session.requests.some((request) => request.url.endsWith("/publish"))).toBe(false);
    expect(run.session.requests.some((request) => request.method === "DELETE")).toBe(false);
  });

  test("a session whose gate closed without a rejection is neither extended nor canceled", async () => {
    const run = await runManaged({ session: { expiresAt: new Date(Date.now() + 60 * MINUTE) } });
    await run.db
      .update(schema.githubWorkflowGates)
      .set({ status: "rejected", decision: "rejected" })
      .where(eq(schema.githubWorkflowGates.id, run.gateId));

    await sweepAt(run, 11 * MINUTE);
    expect((await sessionRows(run))[0]).toMatchObject({
      state: "held",
      stateDetail: "no longer extended: the gate is no longer waiting for a decision",
    });
    expect(run.session.requests.map((request) => request.method)).toEqual(["GET", "GET"]);
  });

  test.each([
    ["published", "externally_published", "pypi_session.externally_published"],
    ["canceled", "externally_canceled", "pypi_session.externally_canceled"],
  ] as const)("a session %s outside Drydock settles as %s", async (status, state, event) => {
    const run = await runManaged();
    run.session.state.status = status;
    await sweepAt(run, 11 * MINUTE);

    expect((await sessionRows(run))[0].state).toBe(state);
    expect((await run.readEvents()).map((entry) => entry.type)).toContain(event);
  });

  test("a session the index no longer knows settles as expired", async () => {
    const run = await runManaged();
    run.session.state.gone = true;
    await sweepAt(run, 11 * MINUTE);
    expect((await sessionRows(run))[0].state).toBe("expired");
  });

  test("an expired session refuses a later approval", async () => {
    const run = await runManaged();
    run.session.state.gone = true;
    await sweepAt(run, 11 * MINUTE);
    const { res, body } = await decide(run, "approved");

    expect(res.status).toBe(409);
    expect(body.error).toMatch(/expired/);
  });

  test("a cancel that failed is retried by the cron", async () => {
    let failDelete = true;
    const run = await runManaged({
      session: {
        respond: (request) => {
          if (request.method !== "DELETE" || !failDelete) return null;
          failDelete = false;
          return new Response("unavailable", { status: 503 });
        },
      },
    });
    await decide(run, "rejected");
    expect((await sessionRows(run))[0].state).toBe("canceling");

    await sweepAt(run, 11 * MINUTE);
    expect((await sessionRows(run))[0].state).toBe("canceled");
  });

  test("a publish still processing is polled to completion by the cron", async () => {
    const run = await runManaged({ session: { publish: 202, afterPublish: "published" } });
    await markApprovedAt(run, Date.now());
    const result = await publishManagedSessions(
      run.gateEnv,
      run.db,
      run.owner.organizationId,
      run.gateId,
      { publishPollDelaysMs: [] },
    );
    expect(result).toEqual({ ok: true });
    expect((await sessionRows(run))[0].state).toBe("publishing");

    await sweepAt(run, 11 * MINUTE);
    expect((await sessionRows(run))[0].state).toBe("published");
  });

  test("a cron-resolved publish is attributed to the approving maintainer", async () => {
    const run = await runManaged({ session: { publish: 202, afterPublish: "published" } });
    await markApprovedAt(run, Date.now());
    await publishManagedSessions(run.gateEnv, run.db, run.owner.organizationId, run.gateId, {
      publishPollDelaysMs: [],
      actorUserId: run.owner.userId,
    });
    await sweepAt(run, 11 * MINUTE);

    expect((await sessionRows(run))[0].state).toBe("published");
    const [published] = await run.db
      .select({ actorUserId: schema.scanEvents.actorUserId })
      .from(schema.scanEvents)
      .where(
        and(
          eq(schema.scanEvents.organizationId, run.owner.organizationId),
          eq(schema.scanEvents.type, "pypi_session.published"),
        ),
      );
    expect(published.actorUserId).toBe(run.owner.userId);
  });

  test("a publish claim is refused once the gate is no longer approved", async () => {
    const run = await runManaged();
    await run.db
      .update(schema.githubWorkflowGates)
      .set({ status: "rejected", decision: "rejected" })
      .where(eq(schema.githubWorkflowGates.id, run.gateId));

    const result = await publishManagedSessions(
      run.gateEnv,
      run.db,
      run.owner.organizationId,
      run.gateId,
    );
    expect(result).toMatchObject({ ok: false, error: expect.stringMatching(/gate changed state/) });
    expect((await sessionRows(run))[0].state).toBe("held");
    expect(publishPosts(run)).toEqual([]);
  });

  test("an approval interrupted before claiming its session becomes a rejection, never a publish", async () => {
    const run = await runManaged();
    await markApprovedAt(run, Date.now() - 40 * MINUTE);

    await runHeldReleaseUpkeep(inlineEnv(run), buildCtxWithGateway(), run.db);

    const gate = await getGateForOrganization(run.db, run.owner.organizationId, run.gateId);
    expect(gate?.status).toBe("rejected");
    expect(gate?.decisionComment).toMatch(/not published before the approval could be delivered/);
    expect(run.decisions.map((decision) => decision.state)).toEqual(["rejected"]);
    expect((await run.readEvents()).map((event) => event.metadataJson)).toContainEqual(
      expect.objectContaining({ decidedBy: "automatic", reason: "held_release_not_published" }),
    );
    // No publish, no cancel: the maintainer never rejected this release.
    expect((await sessionRows(run))[0].state).toBe("held");
    expect(run.session.requests.every((request) => request.method === "GET")).toBe(true);
  });

  test("a multi-project approval interrupted after one publish is rejected and shows partial", async () => {
    const run = await runManaged();
    const [row] = await sessionRows(run);
    const { id: _id, createdAt: _c, updatedAt: _u, state: _s, ...values } = row;
    await upsertPyPiStageSession(run.db, { ...values, projectName: "second-project" });
    await run.db
      .update(schema.pypiStageSessions)
      .set({ state: "published", publishClaimedAt: new Date() })
      .where(eq(schema.pypiStageSessions.id, row.id));
    await markApprovedAt(run, Date.now() - 40 * MINUTE);

    await runHeldReleaseUpkeep(inlineEnv(run), buildCtxWithGateway(), run.db);

    const gate = await getGateForOrganization(run.db, run.owner.organizationId, run.gateId);
    expect(gate?.status).toBe("rejected");
    expect(run.decisions.map((decision) => decision.state)).toEqual(["rejected"]);
    expect((await sessionRows(run)).map((session) => session.state).sort()).toEqual([
      "held",
      "published",
    ]);
  });

  test("an undelivered approval whose session was published outside Drydock is rejected", async () => {
    const run = await runManaged();
    await run.db
      .update(schema.pypiStageSessions)
      .set({ state: "externally_published" })
      .where(eq(schema.pypiStageSessions.gateId, run.gateId));
    await markApprovedAt(run, Date.now() - 40 * MINUTE);

    await runHeldReleaseUpkeep(inlineEnv(run), buildCtxWithGateway(), run.db);

    const gate = await getGateForOrganization(run.db, run.owner.organizationId, run.gateId);
    expect(gate?.status).toBe("rejected");
    expect(run.decisions.map((decision) => decision.state)).toEqual(["rejected"]);
  });

  test("a recent approval is left to the decision route", async () => {
    const run = await runManaged();
    await markApprovedAt(run, Date.now() - 1 * MINUTE);

    await runHeldReleaseUpkeep(inlineEnv(run), buildCtxWithGateway(), run.db);

    const gate = await getGateForOrganization(run.db, run.owner.organizationId, run.gateId);
    expect(gate?.status).toBe("approved");
    expect(run.decisions).toEqual([]);
    // The database is shared across this file; keep later upkeep runs from
    // recovering this gate.
    await run.db
      .delete(schema.pypiStageSessions)
      .where(eq(schema.pypiStageSessions.gateId, run.gateId));
  });

  test("an approval whose request died after PyPI accepted is delivered by the cron", async () => {
    const run = await runManaged({ session: { publish: 202, afterPublish: "published" } });
    await markApprovedAt(run, Date.now() - 40 * MINUTE);
    await publishManagedSessions(run.gateEnv, run.db, run.owner.organizationId, run.gateId, {
      publishPollDelaysMs: [],
      actorUserId: run.owner.userId,
    });

    await runHeldReleaseUpkeep(
      inlineEnv(run),
      buildCtxWithGateway(),
      run.db,
      Date.now() + 11 * MINUTE,
    );

    expect((await sessionRows(run))[0].state).toBe("published");
    const gate = await getGateForOrganization(run.db, run.owner.organizationId, run.gateId);
    expect(gate?.status).toBe("approved");
    expect(run.decisions.map((decision) => decision.state)).toEqual(["approved"]);

    // Acknowledged now: a later tick leaves it alone.
    await runHeldReleaseUpkeep(
      inlineEnv(run),
      buildCtxWithGateway(),
      run.db,
      Date.now() + 22 * MINUTE,
    );
    expect(run.decisions).toHaveLength(1);
  });

  test("a published approval GitHub keeps refusing is not re-delivered on every tick", async () => {
    const run = await runManaged();
    await run.db
      .update(schema.pypiStageSessions)
      .set({ state: "published", publishClaimedAt: new Date() })
      .where(eq(schema.pypiStageSessions.gateId, run.gateId));
    await markApprovedAt(run, Date.now() - 7 * 60 * MINUTE);

    await runHeldReleaseUpkeep(inlineEnv(run), buildCtxWithGateway(), run.db);

    expect(run.decisions).toEqual([]);
    const gate = await getGateForOrganization(run.db, run.owner.organizationId, run.gateId);
    expect(gate?.status).toBe("approved");
  });

  test("a publish that fails after GitHub acknowledged the approval keeps the gate approved", async () => {
    const run = await runManaged({ session: { publish: 202, afterPublish: "error" } });
    await markApprovedAt(run, Date.now() - 40 * MINUTE);
    await publishManagedSessions(run.gateEnv, run.db, run.owner.organizationId, run.gateId, {
      publishPollDelaysMs: [],
      actorUserId: run.owner.userId,
    });
    await run.db
      .update(schema.githubWorkflowGates)
      .set({ decisionDeliveredAt: new Date() })
      .where(eq(schema.githubWorkflowGates.id, run.gateId));

    await runHeldReleaseUpkeep(
      inlineEnv(run),
      buildCtxWithGateway(),
      run.db,
      Date.now() + 11 * MINUTE,
    );

    expect((await sessionRows(run))[0].state).toBe("error");
    const gate = await getGateForOrganization(run.db, run.owner.organizationId, run.gateId);
    expect(gate?.status).toBe("approved");
    expect(run.decisions).toEqual([]);
    const [errorEvent] = await run.db
      .select({ actorUserId: schema.scanEvents.actorUserId })
      .from(schema.scanEvents)
      .where(
        and(
          eq(schema.scanEvents.organizationId, run.owner.organizationId),
          eq(schema.scanEvents.type, "pypi_session.error"),
        ),
      );
    expect(errorEvent.actorUserId).toBeNull();
  });

  test("a publish that fails before GitHub acknowledged the approval rejects the gate", async () => {
    const run = await runManaged({ session: { publish: 202, afterPublish: "error" } });
    await markApprovedAt(run, Date.now() - 40 * MINUTE);
    await publishManagedSessions(run.gateEnv, run.db, run.owner.organizationId, run.gateId, {
      publishPollDelaysMs: [],
      actorUserId: run.owner.userId,
    });

    await runHeldReleaseUpkeep(
      inlineEnv(run),
      buildCtxWithGateway(),
      run.db,
      Date.now() + 11 * MINUTE,
    );

    expect((await sessionRows(run))[0].state).toBe("error");
    const gate = await getGateForOrganization(run.db, run.owner.organizationId, run.gateId);
    expect(gate?.status).toBe("rejected");
    expect(run.decisions.map((decision) => decision.state)).toEqual(["rejected"]);
  });

  test("a session still reading open shortly after a 202 is not taken as a refusal", async () => {
    const run = await runManaged({
      session: {
        // Accepts the publish but keeps reporting `open`, like a lagging read.
        respond: (request) =>
          request.method === "POST" && request.url.endsWith("/publish")
            ? new Response(null, { status: 202 })
            : null,
      },
    });
    await markApprovedAt(run, Date.now());
    const result = await publishManagedSessions(
      run.gateEnv,
      run.db,
      run.owner.organizationId,
      run.gateId,
      { publishPollDelaysMs: [0] },
    );
    expect(result).toEqual({ ok: true });
    expect((await sessionRows(run))[0].state).toBe("publishing");

    await sweepAt(run, 11 * MINUTE);
    expect((await sessionRows(run))[0].state).toBe("publishing");

    await sweepAt(run, 31 * MINUTE);
    expect((await sessionRows(run))[0]).toMatchObject({
      state: "error",
      stateDetail: "PyPI did not accept the publish",
    });
  });

  test("the gate job does not deliver an approval while its held release is unpublished", async () => {
    const run = await runManaged();
    await markApprovedAt(run, Date.now());
    const message = {
      kind: "workflow_gate" as const,
      organizationId: run.owner.organizationId,
      gateId: run.gateId,
    };

    const setState = (state: "externally_published" | "published") =>
      run.db
        .update(schema.pypiStageSessions)
        .set({ state })
        .where(eq(schema.pypiStageSessions.gateId, run.gateId));

    await executeWorkflowGateJob(inlineEnv(run), buildCtxWithGateway(), message, run.db);
    expect(run.decisions).toEqual([]);
    expect(run.logs.join("\n")).toContain("held_release_unpublished");

    // Published outside Drydock: bytes nobody re-checked after the approval.
    await setState("externally_published");
    await executeWorkflowGateJob(inlineEnv(run), buildCtxWithGateway(), message, run.db);
    expect(run.decisions).toEqual([]);

    await setState("published");
    await executeWorkflowGateJob(inlineEnv(run), buildCtxWithGateway(), message, run.db);
    expect(run.decisions.map((decision) => decision.state)).toEqual(["approved"]);
    const [gate] = await run.db
      .select({ decisionDeliveredAt: schema.githubWorkflowGates.decisionDeliveredAt })
      .from(schema.githubWorkflowGates)
      .where(eq(schema.githubWorkflowGates.id, run.gateId));
    expect(gate.decisionDeliveredAt).not.toBeNull();
  });

  test("a removed token leaves the session held and refuses publishing", async () => {
    const run = await runManaged();
    await run.db
      .delete(schema.pypiProjectTokens)
      .where(eq(schema.pypiProjectTokens.organizationId, run.owner.organizationId));
    const result = await publishManagedSessions(
      run.gateEnv,
      run.db,
      run.owner.organizationId,
      run.gateId,
    );
    expect(result).toEqual({ ok: false, error: "the PyPI token for this project was removed" });
    expect((await sessionRows(run))[0].state).toBe("held");
  });
});

describe("PEP 694 mode B: records and token removal", () => {
  test("re-registering never resets a session that already published", async () => {
    const run = await runManaged();
    const [row] = await sessionRows(run);
    await run.db
      .update(schema.pypiStageSessions)
      .set({ state: "published" })
      .where(eq(schema.pypiStageSessions.id, row.id));
    const { id: _id, createdAt: _c, updatedAt: _u, state: _s, ...values } = row;

    expect(await upsertPyPiStageSession(run.db, values)).toBe(false);
    expect((await sessionRows(run))[0].state).toBe("published");

    await run.db
      .update(schema.pypiStageSessions)
      .set({ state: "stale" })
      .where(eq(schema.pypiStageSessions.id, row.id));
    expect(await upsertPyPiStageSession(run.db, values)).toBe(true);
    expect((await sessionRows(run))[0].state).toBe("held");
  });

  test("deleting a token settles its held sessions as token_removed and stops polling them", async () => {
    const run = await runManaged();
    const [token] = await run.db
      .select()
      .from(schema.pypiProjectTokens)
      .where(eq(schema.pypiProjectTokens.organizationId, run.owner.organizationId));
    const app = buildTestApp(
      (routes) => routes.route("/api/v1/pypi-project-tokens", pypiProjectTokenRoutes),
      { userId: run.owner.userId, emailVerified: true },
    );
    const res = await call(app, "DELETE", `/api/v1/pypi-project-tokens/${token.id}`, {
      activeOrganizationId: run.owner.organizationId,
    });
    expect(res.status).toBe(200);
    expect((await sessionRows(run))[0].state).toBe("token_removed");
    expect((await run.readEvents()).map((event) => event.type)).toContain(
      "pypi_session.token_removed",
    );

    const before = run.session.requests.length;
    await sweepManagedSessions(run.gateEnv, run.db, { now: Date.now() + 11 * MINUTE });
    expect(run.session.requests.length).toBe(before);
  });

  test("deleting a token while a publish is in flight keeps the row publishing", async () => {
    const run = await runManaged();
    await run.db
      .update(schema.pypiStageSessions)
      .set({ state: "publishing" })
      .where(eq(schema.pypiStageSessions.gateId, run.gateId));
    const [token] = await run.db
      .select()
      .from(schema.pypiProjectTokens)
      .where(eq(schema.pypiProjectTokens.organizationId, run.owner.organizationId));
    const app = buildTestApp(
      (routes) => routes.route("/api/v1/pypi-project-tokens", pypiProjectTokenRoutes),
      { userId: run.owner.userId, emailVerified: true },
    );
    const res = await call(app, "DELETE", `/api/v1/pypi-project-tokens/${token.id}`, {
      activeOrganizationId: run.owner.organizationId,
    });

    expect(res.status).toBe(200);
    const [row] = await sessionRows(run);
    expect(row.state).toBe("publishing");
    expect(row.stateDetail).toMatch(/publish outcome can no longer be checked/);
    // Not even selected by the sweep: a checked row would get a new timestamp.
    await sweepManagedSessions(run.gateEnv, run.db, { now: Date.now() + 11 * MINUTE });
    const [after] = await sessionRows(run);
    expect(after.state).toBe("publishing");
    expect(after.lastCheckedAt?.getTime()).toBe(row.lastCheckedAt?.getTime());
  });

  test("a held session whose token row vanished is settled by the cron", async () => {
    const run = await runManaged();
    await run.db
      .update(schema.pypiStageSessions)
      .set({ tokenId: null })
      .where(eq(schema.pypiStageSessions.gateId, run.gateId));
    await sweepManagedSessions(run.gateEnv, run.db, { now: Date.now() + 11 * MINUTE });
    expect((await sessionRows(run))[0].state).toBe("token_removed");
  });
});

describe("PyPI project token routes", () => {
  const tokenApp = (userId: string) =>
    buildTestApp((app) => app.route("/api/v1/pypi-project-tokens", pypiProjectTokenRoutes), {
      userId,
      emailVerified: true,
    });

  test("an admin stores, rotates, checks and removes a project token; it is never returned", async () => {
    const owner = await seedUser();
    const app = tokenApp(owner.userId);
    const org = { activeOrganizationId: owner.organizationId };

    const created = await call(app, "POST", "/api/v1/pypi-project-tokens", {
      ...org,
      body: { project: "Demo_Package", index: "https://pypi.org", token: PYPI_TOKEN },
    });
    const createdText = await created.text();
    expect(created.status).toBe(201);
    const { token } = JSON.parse(createdText) as { token: { id: string; projectName: string } };
    expect(token.projectName).toBe("demo-package");

    const duplicate = await call(app, "POST", "/api/v1/pypi-project-tokens", {
      ...org,
      body: { project: "demo-package", token: PYPI_TOKEN },
    });
    expect(duplicate.status).toBe(409);

    const rotatedToken = fakePyPiToken(["demo-package"]).replace("0001", "0002");
    const rotated = await call(app, "PUT", `/api/v1/pypi-project-tokens/${token.id}`, {
      ...org,
      body: { token: rotatedToken },
    });
    expect(rotated.status).toBe(200);
    const checked = await call(
      app,
      "POST",
      `/api/v1/pypi-project-tokens/${token.id}/validate`,
      org,
    );
    expect(await checked.json()).toMatchObject({ ok: true });

    const listed = await call(app, "GET", "/api/v1/pypi-project-tokens", org);
    const listedText = await listed.text();
    const removed = await call(app, "DELETE", `/api/v1/pypi-project-tokens/${token.id}`, org);
    expect(removed.status).toBe(200);

    const events = await owner.db
      .select({ type: schema.scanEvents.type, metadataJson: schema.scanEvents.metadataJson })
      .from(schema.scanEvents)
      .where(eq(schema.scanEvents.organizationId, owner.organizationId));
    expect(events.map((event) => event.type)).toEqual(
      expect.arrayContaining([
        "pypi_token.added",
        "pypi_token.rotated",
        "pypi_token.validated",
        "pypi_token.deleted",
      ]),
    );
    for (const surface of [createdText, listedText, JSON.stringify(events)]) {
      expect(surface).not.toContain(PYPI_TOKEN);
      expect(surface).not.toContain(rotatedToken);
      expect(surface).not.toContain("tokenCiphertext");
    }
  });

  test("a token not scoped to exactly this project is refused", async () => {
    const owner = await seedUser();
    for (const token of [fakePyPiToken("user"), fakePyPiToken(["other-package"])]) {
      const res = await call(tokenApp(owner.userId), "POST", "/api/v1/pypi-project-tokens", {
        activeOrganizationId: owner.organizationId,
        body: { project: "demo-package", token },
      });
      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject({ code: "pypi_token_not_project_scoped" });
    }
  });

  test("an index outside the allowlist is refused", async () => {
    const owner = await seedUser();
    const res = await call(tokenApp(owner.userId), "POST", "/api/v1/pypi-project-tokens", {
      activeOrganizationId: owner.organizationId,
      body: { project: "demo-package", index: "https://evil.example", token: PYPI_TOKEN },
    });
    expect(res.status).toBe(400);
  });

  test("a member without integration rights cannot add or remove tokens", async () => {
    const owner = await seedUser();
    const member = await seedUser();
    await addOrganizationMember(owner.db, {
      organizationId: owner.organizationId,
      userId: member.userId,
      role: "member",
    });
    const stored = await seedProjectToken(owner);
    const app = tokenApp(member.userId);
    const org = { activeOrganizationId: owner.organizationId };

    const add = await call(app, "POST", "/api/v1/pypi-project-tokens", {
      ...org,
      body: { project: "demo-package", token: PYPI_TOKEN },
    });
    expect(add.status).toBe(403);
    expect(
      (await call(app, "DELETE", `/api/v1/pypi-project-tokens/${stored.id}`, org)).status,
    ).toBe(403);
    expect((await call(app, "GET", "/api/v1/pypi-project-tokens", org)).status).toBe(200);
  });

  test("another organization cannot see or touch a token", async () => {
    const owner = await seedUser();
    const stranger = await seedUser();
    const stored = await seedProjectToken(owner);
    const app = tokenApp(stranger.userId);
    const own = { activeOrganizationId: stranger.organizationId };

    const listed = (await (await call(app, "GET", "/api/v1/pypi-project-tokens", own)).json()) as {
      tokens: unknown[];
    };
    expect(listed.tokens).toEqual([]);
    expect(
      (await call(app, "DELETE", `/api/v1/pypi-project-tokens/${stored.id}`, own)).status,
    ).toBe(404);
    // Naming an organization the caller is not a member of never reaches its rows.
    const foreign = await call(app, "GET", "/api/v1/pypi-project-tokens", {
      activeOrganizationId: owner.organizationId,
    });
    expect(await foreign.text()).not.toContain(stored.id);
  });
});
