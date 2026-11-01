import { env } from "cloudflare:test";
import { and, desc, eq } from "drizzle-orm";
import { afterEach, describe, expect, test, vi } from "vitest";
import { getScan } from "../../server/db/scans";
import { addOrganizationMember } from "../../server/db/invitations";
import {
  insertPyPiProjectToken,
  transitionPyPiStageSession,
  upsertPyPiStageSession,
} from "../../server/db/pypi-stage-sessions";
import * as schema from "../../server/db/schema";
import { sealPyPiToken } from "../../server/lib/ecosystems/pypi/project-token";
import { sessionFingerprint } from "../../server/lib/ecosystems/pypi/session-gateway";
import {
  publishManagedSessions,
  sweepManagedSessions,
} from "../../server/lib/ecosystems/pypi/session-lifecycle";
import { sealSecret } from "../../server/lib/platform/secret-box";
import {
  getGateForOrganization,
  listGatePackageScans,
} from "../../server/lib/github-app/webhook-gates";
import { executeWorkflowGateJob, runHeldReleaseUpkeep } from "../../server/lib/workflow-gate-job";
import type { QueueMessage } from "../../server/lib/scan/job";
import { queue } from "../../server/queue";
import { githubAppRoutes } from "../../server/routes/github-app";
import { pypiProjectTokenRoutes } from "../../server/routes/pypi-project-tokens";
import { scanDecisionRoutes } from "../../server/routes/scans/decisions";
import type { Bindings } from "../../server/types";
import {
  FAKE_SESSION_TOKEN,
  FAKE_STAGE_TOKEN,
  type FakeUploadSession,
  type FakeUploadSessionOptions,
  buildFakeUploadSession,
  drydockSessionReference,
  fakePyPiToken,
  sha256HexOf,
} from "../helpers/pep694-fake";
import { buildZip } from "../helpers/archive-fixtures";
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
import { type SeededUser, seedUser, seedWorkflowGate } from "./helpers/seed";

const STAGE_URL = `https://pypi.org/stage/${FAKE_STAGE_TOKEN}/`;
const FILES_ROOT = `https://files.pythonhosted.org/stage-files/${FAKE_STAGE_TOKEN}/`;
const PYPI_TOKEN = fakePyPiToken(["demo-package"]);
const MINUTE = 60 * 1000;

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** The repository of the organization's newest gate (the gate under test), if any. */
async function gateRepository(owner: SeededUser): Promise<number> {
  const [gate] = await owner.db
    .select({ repositoryId: schema.githubWorkflowGates.repositoryId })
    .from(schema.githubWorkflowGates)
    .where(eq(schema.githubWorkflowGates.organizationId, owner.organizationId))
    .orderBy(desc(schema.githubWorkflowGates.createdAt))
    .limit(1);
  return gate?.repositoryId ?? 1;
}

async function seedProjectToken(
  owner: SeededUser,
  projectName = "demo-package",
  token = fakePyPiToken([projectName]),
  repositoryId?: number,
) {
  const row = await insertPyPiProjectToken(owner.db, {
    organizationId: owner.organizationId,
    projectName,
    indexOrigin: "https://pypi.org",
    repositoryId: repositoryId ?? (await gateRepository(owner)),
    repositoryFullName: "octo/release",
    ...(await sealPyPiToken(env, token)),
    validatedAt: new Date(),
    lastUsedAt: null,
    createdByUserId: owner.userId,
  });
  if (!row) throw new Error("token seed failed");
  return row;
}

/** A held session row for `session` on a new gate of `repositoryId`; returns that gate's id. */
async function seedHeldSessionOnOtherGate(
  owner: SeededUser,
  session: FakeUploadSession,
  repositoryId: number,
): Promise<string> {
  const gateId = await seedWorkflowGate(owner, { ecosystem: "pypi", decision: null, repositoryId });
  const [token] = await owner.db
    .select({ id: schema.pypiProjectTokens.id })
    .from(schema.pypiProjectTokens)
    .where(eq(schema.pypiProjectTokens.organizationId, owner.organizationId));
  const sealed = await sealSecret(
    env,
    "pypi-session-links",
    JSON.stringify({ session: session.sessionUrl, stage: STAGE_URL }),
  );
  const stored = await upsertPyPiStageSession(owner.db, {
    organizationId: owner.organizationId,
    gateId,
    tokenId: token.id,
    projectName: "demo-package",
    version: "1.2.0",
    indexOrigin: "https://pypi.org",
    linksCiphertext: sealed.ciphertext,
    linksNonce: sealed.nonce,
    sessionFingerprint: await sessionFingerprint(session.sessionUrl),
    reviewedFilesJson: [],
    expiresAt: null,
    lastCheckedAt: new Date(),
  });
  if (!("row" in stored)) throw new Error("held row seed failed");
  await transitionPyPiStageSession(owner.db, stored.row.id, ["staging"], "held");
  return gateId;
}

function stagePage(digests: Map<string, string>, project = "demo-package"): Response {
  return Response.json(
    {
      meta: { "api-version": "1.1" },
      name: project,
      files: [...digests].map(([filename, sha256]) => ({
        filename,
        url: `${FILES_ROOT}${filename}`,
        hashes: { sha256 },
      })),
    },
    { headers: { "content-type": "application/vnd.pypi.simple.v1+json" } },
  );
}

interface ManagedScenario extends PyPiStageScenario {
  session?: Partial<FakeUploadSessionOptions>;
  /** A fake built by the test (to know its session URL before the run). */
  prebuilt?: FakeUploadSession;
  storeToken?: boolean;
  /**
   * Called before each stage page answer with its 1-based read count and the
   * override map; entries set there replace what the session really holds.
   */
  onPageRead?: (count: number, overrides: Map<string, string>) => void;
}

async function runManaged(options: ManagedScenario = {}) {
  const session =
    options.prebuilt ?? buildFakeUploadSession({ stageUrl: STAGE_URL, ...options.session });
  const digests = new Map<string, string>();
  let pageReads = 0;
  const run = await runPyPiStageGate({
    artifactFiles: {
      [`dist/${WHEEL}`]: stagedBytes(WHEEL),
      [`dist/${SDIST}`]: stagedBytes(SDIST),
    },
    reference: () => drydockSessionReference([{ name: "demo-package", version: "1.2.0" }]),
    ...options,
    beforeRun: async (owner) => {
      if (options.storeToken !== false) await seedProjectToken(owner, "demo-package", PYPI_TOKEN);
      await options.beforeRun?.(owner);
    },
    page: () => {
      pageReads += 1;
      options.onPageRead?.(pageReads, digests);
      return stagePage(new Map([...session.completedDigests(), ...digests]));
    },
    routes: { ...session.routes, ...options.routes },
  });
  return { ...run, session, digests, stagingRequests: session.requests.length };
}

type ManagedRun = Awaited<ReturnType<typeof runManaged>>;

/** Session requests made after the gate job staged the release. */
const afterStaging = (run: ManagedRun) => run.session.requests.slice(run.stagingRequests);

async function sessionRows(run: { db: ManagedRun["db"]; gateId: string }) {
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

/** Every request that carried the PyPI token went to the fake Upload 2.0 root. */
function expectTokenOnlyToUploadRoot(run: ManagedRun) {
  const bearing = run.calls.filter((entry) => entry.authorization?.includes(PYPI_TOKEN));
  expect(bearing.length).toBeGreaterThan(0);
  for (const entry of bearing) {
    expect(
      entry.url === run.session.createUrl || entry.url.startsWith(run.session.sessionUrl),
    ).toBe(true);
  }
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

function expectRejected(run: ManagedRun, code: string, detail: RegExp) {
  expect(run.gate?.status).toBe("rejected");
  expect(run.gate?.failureReason?.startsWith(`${code}: `)).toBe(true);
  expect(run.gate?.failureReason).toMatch(detail);
  expect(run.decisions.map((decision) => decision.state)).toEqual(["rejected"]);
}

describe("PEP 694 mode B: Drydock stages the reviewed bytes", () => {
  test("creates the session, uploads the reviewed artifact bytes, verifies the stage, and holds it", async () => {
    const run = await runManaged();

    expect(run.gate?.status).toBe("pending");
    const [row] = await sessionRows(run);
    expect(row).toMatchObject({ state: "held", projectName: "demo-package", version: "1.2.0" });
    expect(row.sessionFingerprint).toMatch(/^[0-9a-f]{16}$/);
    const wheelSha = await sha256HexOf(stagedBytes(WHEEL));
    expect(row.reviewedFilesJson).toEqual(
      expect.arrayContaining([{ filename: WHEEL, sha256: wheelSha }]),
    );
    // The bytes in the session are exactly the reviewed artifact bytes.
    expect(run.session.state.files.get(WHEEL)?.bytes).toEqual(stagedBytes(WHEEL));
    expect(run.session.state.files.get(SDIST)?.bytes).toEqual(stagedBytes(SDIST));
    expect([...run.session.state.files.values()].map((file) => file.status)).toEqual([
      "completed",
      "completed",
    ]);
    // Create, then per file: open the upload, POST the bytes, complete; then
    // re-read the session. Every request carries the token; nothing publishes.
    const requests = run.session.requests;
    expect(requests[0]).toMatchObject({ method: "POST", url: run.session.createUrl });
    expect(requests.at(-1)).toMatchObject({ method: "GET", url: run.session.sessionUrl });
    expect(requests).toHaveLength(8);
    expect(requests.every((request) => request.authorization === `Bearer ${PYPI_TOKEN}`)).toBe(
      true,
    );
    expect(publishPosts(run)).toEqual([]);
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
      artifactBound: true,
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
    expectTokenOnlyToUploadRoot(run);
    await expectNoSecretLeak(run, [text, JSON.stringify(persisted)]);
  });

  test("without a stored token the opt-in fails closed before any Upload 2.0 request", async () => {
    const run = await runManaged({ storeToken: false });

    expectRejected(run, "stage_reference_invalid", /needs a PyPI token for the project/);
    expect(run.session.requests).toEqual([]);
    expect(await sessionRows(run)).toEqual([]);
  });

  test("a session-url in pypi-stage.json is refused: a workflow-created session is never held", async () => {
    const run = await runManaged({
      reference: () =>
        JSON.stringify({
          schema: "drydock.pypi-stage.v1",
          name: "demo-package",
          version: "1.2.0",
          session: "drydock",
          "session-url": "https://upload.pypi.org/2.0/sessions/ci-made",
        }),
    });

    expectRejected(run, "stage_reference_invalid", /session-url is not accepted/);
    expect(run.calls.some((entry) => entry.authorization?.includes(PYPI_TOKEN))).toBe(false);
    expect(await sessionRows(run)).toEqual([]);
  });

  test("the opt-in needs the artifact's distributions, which are what Drydock uploads", async () => {
    const run = await runManaged({ artifactFiles: {} });

    expectRejected(run, "stage_reference_invalid", /carries no distributions/);
    expect(run.session.requests).toEqual([]);
  });

  test.each([
    ["a foreign host", () => `https://evil.example/2.0/${FAKE_SESSION_TOKEN}`],
    ["a look-alike host", () => "https://upload.pypi.org.evil.example/2.0/x"],
    ["plain http", (_name: string, url: string) => url.replace("https://", "http://")],
    ["the legacy upload API on the same host", () => "https://upload.pypi.org/legacy/"],
    ["another allowed root's origin", () => "https://pypi.org/2.0/files/x"],
  ])("a file_url on %s never receives the token or the bytes", async (_label, fileUrl) => {
    const evil: string[] = [];
    const run = await runManaged({
      session: { fileUrl },
      routes: {
        "evil.example": (request) => {
          evil.push(request.headers.get("authorization") ?? "");
          return new Response("ok");
        },
      },
    });

    expectRejected(run, "stage_session_mismatch", /not an allowed Upload 2\.0 URL/);
    expect(evil).toEqual([]);
    expectTokenOnlyToUploadRoot(run);
    expect(run.session.requests.some((request) => request.url.includes("/bytes"))).toBe(false);
    // The opened upload was removed again; the session holds nothing unreviewed.
    expect(run.session.state.files.size).toBe(0);
    const [row] = await sessionRows(run);
    expect(row.state).toBe("upload_failed");
    expect(row.stateDetail).toMatch(/nothing of it is left in the session/);
    await expectNoSecretLeak(run);
  });

  test("a create answer that redirects never forwards the token", async () => {
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

    expectRejected(run, "stage_session_mismatch", /redirect/);
    expect(evil).toEqual([]);
    expect(await sessionRows(run)).toEqual([]);
  });

  test("a session the index names off its Upload 2.0 origin is refused before any request to it", async () => {
    const run = await runManaged({
      session: { links: { session: "https://evil.example/2.0/sessions/abc" } },
    });

    expectRejected(run, "stage_session_mismatch", /outside its Upload 2\.0 root/);
    expect(run.calls.some((entry) => entry.url.includes("evil.example"))).toBe(false);
    expect(await sessionRows(run)).toEqual([]);
  });

  test("a failed byte upload is removed, leaves upload_failed, and a retried review restages the adopted session", async () => {
    let failBytes = true;
    const run = await runManaged({
      session: {
        respond: (request) =>
          failBytes && request.method === "POST" && request.url.endsWith(`/${WHEEL}/bytes`)
            ? new Response("upload broke", { status: 500 })
            : null,
      },
    });

    // Retryable: back to the queue, the deployment stays pending, nothing of the wheel remains.
    expect(run.retryError).not.toBeNull();
    expect(run.gate?.status).toBe("pending");
    expect(run.decisions).toEqual([]);
    expect(run.session.state.files.has(WHEEL)).toBe(false);
    const [failed] = await sessionRows(run);
    expect(failed.state).toBe("upload_failed");
    expect(failed.stateDetail).toMatch(
      new RegExp(
        `upload of ${WHEEL.replace(/\./g, "\\.")} failed: .*HTTP 500; nothing of it is left`,
      ),
    );
    failBytes = false;
    const before = run.session.requests.length;
    await executeWorkflowGateJob(
      run.gateEnv,
      buildCtxWithGateway(),
      { kind: "workflow_gate", organizationId: run.owner.organizationId, gateId: run.gateId },
      run.db,
    );
    const retry = run.session.requests.slice(before);
    // PEP 694 hands back the existing session (409 + Location), which
    // Drydock reads, then uploads the reviewed set into.
    expect(retry[0]).toMatchObject({ method: "POST", url: run.session.createUrl });
    expect(retry[1]).toMatchObject({ method: "GET", url: run.session.sessionUrl });
    const [held] = await sessionRows(run);
    expect(held.state).toBe("held");
    expect(held.id).toBe(failed.id);
    expect(run.session.state.files.get(WHEEL)?.bytes).toEqual(stagedBytes(WHEEL));
  });

  test("an adopted session's leftover files are removed before the reviewed bytes go in", async () => {
    const leftover = "demo_package-1.2.0-py2-none-any.whl";
    const run = await runManaged({ session: { adopt: true, filenames: [leftover] } });

    expect(run.gate?.status).toBe("pending");
    expect([...run.session.state.files.keys()].sort()).toEqual([WHEEL, SDIST].sort());
    expect(run.session.requests).toContainEqual(
      expect.objectContaining({
        method: "DELETE",
        url: `${run.session.sessionUrl}/files/${leftover}`,
      }),
    );
    expect((await sessionRows(run))[0].state).toBe("held");
  });

  test("an existing session that is not open is not staged and the gate stays pending", async () => {
    const run = await runManaged({ session: { adopt: true, status: "processing" } });

    expect(run.retryError).not.toBeNull();
    expect(run.gate?.status).toBe("pending");
    expect(run.decisions).toEqual([]);
    expect(await sessionRows(run)).toEqual([]);
    expect(run.session.requests.every((request) => request.method !== "DELETE")).toBe(true);
  });

  test("an artifact whose bytes changed between the review read and the staging read is never uploaded", async () => {
    const reference = new TextEncoder().encode(
      drydockSessionReference([{ name: "demo-package", version: "1.2.0" }]),
    );
    const bundle = (wheel: Uint8Array) =>
      buildZip([
        { path: `dist/${WHEEL}`, body: wheel },
        { path: `dist/${SDIST}`, body: stagedBytes(SDIST) },
        { path: "dist/pypi-stage.json", body: reference },
      ]);
    // Same length, different bytes: only the digest tells them apart.
    const swapped = new TextEncoder().encode(`Staged bytes of ${WHEEL}`);
    let reads = 0;
    const run = await runManaged({
      routes: {
        "/actions/artifacts/4242/zip": () => {
          reads += 1;
          return new Response(bundle(reads === 1 ? stagedBytes(WHEEL) : swapped), {
            headers: { "content-type": "application/zip" },
          });
        },
      },
    });

    expect(reads).toBe(2);
    expectRejected(run, "stage_session_mismatch", /changed between review and staging/);
    expect(run.session.state.files.has(WHEEL)).toBe(false);
    expect(run.session.requests.some((request) => request.url.endsWith(`/${WHEEL}/bytes`))).toBe(
      false,
    );
  });

  test("a stage that does not serve the uploaded digests fails closed as upload_failed", async () => {
    const run = await runManaged({
      onPageRead: (count, overrides) => {
        if (count === 1) overrides.set(WHEEL, "f".repeat(64));
      },
    });

    expectRejected(run, "stage_session_mismatch", /sha256 differs/);
    expect((await sessionRows(run))[0].state).toBe("upload_failed");
    expect(publishPosts(run)).toEqual([]);
  });

  test("an older gate's row for the same index session is superseded, so its rejection cannot cancel it", async () => {
    const session = buildFakeUploadSession({ stageUrl: STAGE_URL, adopt: true });
    let olderGateId = "";
    const run = await runManaged({
      prebuilt: session,
      beforeRun: async (owner) => {
        // An earlier run of the same release (same repository) holds this index session.
        olderGateId = await seedHeldSessionOnOtherGate(owner, session, await gateRepository(owner));
      },
    });

    expect((await sessionRows(run))[0].state).toBe("held");
    const [olderRow] = await sessionRows({ db: run.db, gateId: olderGateId });
    expect(olderRow).toMatchObject({
      state: "superseded",
      stateDetail: "a later run of this release took over the session",
    });
    // Superseded rows are not cancelable, so the older gate cannot cancel it.
    expect(run.session.requests.some((request) => request.method === "DELETE")).toBe(false);
  });

  test("another repository's gate never takes over a session this repository's gate holds", async () => {
    const session = buildFakeUploadSession({ stageUrl: STAGE_URL, adopt: true });
    let holderGateId = "";
    const run = await runManaged({
      prebuilt: session,
      beforeRun: async (owner) => {
        holderGateId = await seedHeldSessionOnOtherGate(
          owner,
          session,
          (await gateRepository(owner)) + 1,
        );
      },
    });

    const [holder] = await sessionRows({ db: run.db, gateId: holderGateId });
    expect(holder.state).toBe("held");
    expect(await sessionRows(run)).toEqual([]);
    expect(run.retryError?.message).toContain("a gate of another repository still tracks");
    expect(run.gate).toMatchObject({ status: "pending", scanId: null });
    // Only the create/adopt and status reads: nothing removed from or uploaded to the session.
    expect(run.session.requests.map((request) => request.method)).toEqual(["POST", "GET"]);
  });

  test("a gate of another repository cannot stage with a token bound to this one", async () => {
    const run = await runManaged({
      storeToken: false,
      beforeRun: async (owner) => {
        await seedProjectToken(
          owner,
          "demo-package",
          PYPI_TOKEN,
          (await gateRepository(owner)) + 1,
        );
      },
    });

    expect(run.gate).toMatchObject({ status: "rejected" });
    expect(run.gate?.failureReason).toContain("bound to another repository");
    expect(run.session.requests).toEqual([]);
    expect(await sessionRows(run)).toEqual([]);
  });

  test("a second delivery while the first holds the staging lease stages nothing and retries", async () => {
    const run = await runManaged({
      beforeRun: async (owner) => {
        const [gate] = await owner.db
          .select({ id: schema.githubWorkflowGates.id })
          .from(schema.githubWorkflowGates)
          .where(eq(schema.githubWorkflowGates.organizationId, owner.organizationId));
        await owner.db
          .update(schema.githubWorkflowGates)
          .set({
            stagingLeaseId: "other-delivery",
            stagingLeaseUntil: new Date(Date.now() + MINUTE),
          })
          .where(eq(schema.githubWorkflowGates.id, gate.id));
      },
    });

    expect(run.retryError?.message).toContain("another delivery of this gate is staging it");
    expect(run.session.requests).toEqual([]);
    expect(await sessionRows(run)).toEqual([]);
    expect(run.gate).toMatchObject({ status: "pending", scanId: null });
    expect(run.gate?.failureReason).toContain("retrying: another delivery");
  });
});

describe("PEP 694 mode B: human decisions", () => {
  test("the generic scan decision route cannot decide a gate package around the gate", async () => {
    const run = await runManaged();
    const [pkg] = await listGatePackageScans(run.db, run.owner.organizationId, run.gateId);
    const app = buildTestApp((root) => root.route("/api/v1/scans", scanDecisionRoutes), {
      userId: run.owner.userId,
      emailVerified: true,
    });

    const res = await call(app, "POST", `/api/v1/scans/${pkg.scanId}/decision`, {
      activeOrganizationId: run.owner.organizationId,
      body: { decision: "publish" },
    });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "decide a gated release on its workflow gate" });
    const scan = await getScan(run.db, pkg.scanId, run.owner.organizationId);
    expect(scan?.scan.decision).toBeNull();
    expect((await sessionRows(run))[0].state).toBe("held");
    expect(publishPosts(run)).toEqual([]);
  });

  test("approval re-verifies the session and stage, then publishes (201)", async () => {
    const run = await runManaged();
    const { res, body } = await decide(run, "approved");

    expect(res.status).toBe(200);
    expect((body.gate as { status: string }).status).toBe("approved");
    const [row] = await sessionRows(run);
    expect(row.state).toBe("published");
    // After staging: the pre-record check, the post-CAS re-check, then publish.
    const decided = afterStaging(run);
    expect(decided.map((request) => request.method)).toEqual(["GET", "GET", "POST"]);
    expect(decided[2].url).toBe(`${run.session.sessionUrl}/publish`);
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
    expectTokenOnlyToUploadRoot(run);
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

  test("a 200 from publish counts as processing and is polled, never as published", async () => {
    const run = await runManaged({ session: { publish: 200, afterPublish: "published" } });
    await markApprovedAt(run, Date.now());
    const first = await publishManagedSessions(
      run.gateEnv,
      run.db,
      run.owner.organizationId,
      run.gateId,
      { publishPollDelaysMs: [] },
    );
    expect(first).toEqual({ ok: true });
    expect((await sessionRows(run))[0].state).toBe("publishing");

    await sweepManagedSessions(run.gateEnv, run.db, { now: Date.now() + 11 * MINUTE });
    expect((await sessionRows(run))[0].state).toBe("published");
  });

  test("each project is re-verified right before its own claim, not all up front", async () => {
    const SECOND_STAGE = "https://pypi.org/stage/second-project-stage/";
    const SECOND_WHEEL = "second_project-1.0-py3-none-any.whl";
    const secondSha = await sha256HexOf(new TextEncoder().encode("second wheel"));
    const secondDigests = new Map([[SECOND_WHEEL, secondSha]]);
    // A second Upload 2.0 root for pypi.org, so its routes do not collide.
    const second = buildFakeUploadSession({
      stageUrl: SECOND_STAGE,
      uploadOrigin: "https://pypi.org",
      filenames: [SECOND_WHEEL],
    });
    const run = await runManaged({
      session: {
        // Publishing the first project changes the second project's stage.
        respond: (request) => {
          if (request.method === "POST" && request.url.endsWith("/publish")) {
            secondDigests.set(SECOND_WHEEL, "f".repeat(64));
          }
          return null;
        },
      },
      routes: {
        ...second.routes,
        [SECOND_STAGE]: () => stagePage(secondDigests, "second-project"),
      },
      beforeRun: async (owner) => {
        await seedProjectToken(owner, "second-project");
      },
    });
    const [token] = await run.db
      .select({ id: schema.pypiProjectTokens.id })
      .from(schema.pypiProjectTokens)
      .where(
        and(
          eq(schema.pypiProjectTokens.organizationId, run.owner.organizationId),
          eq(schema.pypiProjectTokens.projectName, "second-project"),
        ),
      );
    const sealed = await sealSecret(
      env,
      "pypi-session-links",
      JSON.stringify({ session: second.sessionUrl, stage: SECOND_STAGE }),
    );
    const stored = await upsertPyPiStageSession(run.db, {
      organizationId: run.owner.organizationId,
      gateId: run.gateId,
      tokenId: token.id,
      projectName: "second-project",
      version: "1.0",
      indexOrigin: "https://pypi.org",
      linksCiphertext: sealed.ciphertext,
      linksNonce: sealed.nonce,
      sessionFingerprint: await sessionFingerprint(second.sessionUrl),
      reviewedFilesJson: [{ filename: SECOND_WHEEL, sha256: secondSha }],
      expiresAt: null,
      lastCheckedAt: new Date(),
    });
    if (!("row" in stored)) throw new Error("second row seed failed");
    second.state.files.set(SECOND_WHEEL, { status: "completed", sha256: secondSha, bytes: null });
    await transitionPyPiStageSession(run.db, stored.row.id, ["staging"], "held");
    await markApprovedAt(run, Date.now());

    const result = await publishManagedSessions(
      run.gateEnv,
      run.db,
      run.owner.organizationId,
      run.gateId,
    );

    expect(result).toMatchObject({
      ok: false,
      error: expect.stringMatching(/second-project PyPI session changed since review/),
    });
    const states = Object.fromEntries(
      (await sessionRows(run)).map((row) => [row.projectName, row.state]),
    );
    expect(states).toEqual({ "demo-package": "published", "second-project": "stale" });
    expect(second.requests.some((request) => request.url.endsWith("/publish"))).toBe(false);
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
    expect(afterStaging(run).some((request) => request.method === "POST")).toBe(false);
    expect((await run.readEvents()).map((event) => event.type)).toContain("pypi_session.stale");
  });

  test("a file replaced in the session since review marks it stale", async () => {
    const run = await runManaged();
    run.session.state.files.set("demo_package-1.2.0-py2-none-any.whl", {
      status: "completed",
      sha256: "e".repeat(64),
      bytes: null,
    });
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
    expect(afterStaging(run).map((request) => request.method)).toEqual(["GET"]);
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
    expect(afterStaging(run).every((request) => request.method === "GET")).toBe(true);
  });

  test("a multi-project approval interrupted after one publish is rejected and shows partial", async () => {
    const run = await runManaged();
    const [row] = await sessionRows(run);
    const { id: _id, createdAt: _c, updatedAt: _u, state: _s, ...values } = row;
    const second = await upsertPyPiStageSession(run.db, {
      ...values,
      projectName: "second-project",
    });
    if (!("row" in second)) throw new Error("second row seed failed");
    await transitionPyPiStageSession(run.db, second.row.id, ["staging"], "held");
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
    // Nothing on GitHub shows the failure, so maintainers hear it from Drydock.
    const events = await run.readEvents();
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "github_workflow_gate.held_release_publish_failed",
        metadataJson: expect.objectContaining({
          gateId: run.gateId,
          detail: "demo-package 1.2.0 ended error",
        }),
      }),
    );
    expect(
      events.some(
        (event) =>
          event.type.startsWith("github_workflow_gate.notification_") &&
          (event.metadataJson as { trigger?: string } | null)?.trigger ===
            "held_release_publish_failed",
      ),
    ).toBe(true);
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

describe("PEP 694 mode B: retryable staging faults", () => {
  const DAY = 24 * 60 * MINUTE;

  /** One workflow-gate message for the SCAN_QUEUE consumer, as the runtime hands it over. */
  function queueBatch(run: ManagedRun, attempts: number) {
    const message = {
      id: crypto.randomUUID(),
      timestamp: new Date(),
      body: { kind: "workflow_gate", organizationId: run.owner.organizationId, gateId: run.gateId },
      attempts,
      retry: vi.fn(),
      ack: vi.fn(),
    };
    const batch = {
      queue: "drydock-scans",
      messages: [message],
      retryAll: vi.fn(),
      ackAll: vi.fn(),
    } as unknown as MessageBatch<QueueMessage>;
    return { batch, message };
  }

  function failingUploads() {
    const control = { fail: true };
    const session: Partial<FakeUploadSessionOptions> = {
      respond: (request) =>
        control.fail && request.method === "POST" && request.url.endsWith(`/${WHEEL}/bytes`)
          ? new Response("upload broke", { status: 500 })
          : null,
    };
    return { control, session };
  }

  test("the queue retries a staging fault with backoff and restages on a later attempt", async () => {
    const uploads = failingUploads();
    const run = await runManaged({ session: uploads.session });
    expect(run.retryError).not.toBeNull();
    expect(run.gate).toMatchObject({ status: "pending", scanId: null });
    expect(run.gate?.failureReason).toMatch(/^retrying: /);

    const first = queueBatch(run, 1);
    await queue(first.batch, inlineEnv(run), buildCtxWithGateway());
    expect(first.message.retry).toHaveBeenCalledWith({ delaySeconds: 5 });
    expect((await sessionRows(run))[0].state).toBe("upload_failed");

    uploads.control.fail = false;
    const second = queueBatch(run, 2);
    await queue(second.batch, inlineEnv(run), buildCtxWithGateway());
    expect(second.message.retry).not.toHaveBeenCalled();
    expect((await sessionRows(run))[0].state).toBe("held");
    const gate = await getGateForOrganization(run.db, run.owner.organizationId, run.gateId);
    expect(gate?.scanId).not.toBeNull();
    expect(gate?.status).toBe("pending");
  });

  test("after the queue gives up, a maintainer can retry a gate that has no scan yet", async () => {
    const uploads = failingUploads();
    const run = await runManaged({ session: uploads.session });
    const last = queueBatch(run, 3);
    await expect(queue(last.batch, inlineEnv(run), buildCtxWithGateway())).rejects.toThrow(
      /upload of/,
    );
    expect(last.message.retry).not.toHaveBeenCalled();
    expect(await listGatePackageScans(run.db, run.owner.organizationId, run.gateId)).toEqual([]);

    const sent: unknown[] = [];
    const res = await call(
      gateApp(run.owner),
      "POST",
      `/api/v1/github-app/workflow-gates/${run.gateId}/retry`,
      {
        activeOrganizationId: run.owner.organizationId,
        envOverride: {
          ...routeEnv(),
          SCAN_QUEUE: { send: async (body: unknown) => void sent.push(body) },
        } as unknown as Partial<Bindings>,
      },
    );
    expect(res.status).toBe(202);
    expect(sent).toEqual([
      { kind: "workflow_gate", organizationId: run.owner.organizationId, gateId: run.gateId },
    ]);
    const reset = await getGateForOrganization(run.db, run.owner.organizationId, run.gateId);
    expect(reset?.failureReason).toBeNull();

    uploads.control.fail = false;
    await queue(queueBatch(run, 1).batch, inlineEnv(run), buildCtxWithGateway());
    expect((await sessionRows(run))[0].state).toBe("held");
  });

  test("a gate without a scan or a failure reason is not retryable by hand", async () => {
    const run = await runManaged({ session: { adopt: true, status: "processing" } });
    await run.db
      .update(schema.githubWorkflowGates)
      .set({ failureReason: null })
      .where(eq(schema.githubWorkflowGates.id, run.gateId));

    const res = await call(
      gateApp(run.owner),
      "POST",
      `/api/v1/github-app/workflow-gates/${run.gateId}/retry`,
      { activeOrganizationId: run.owner.organizationId, envOverride: routeEnv() },
    );
    expect(res.status).toBe(409);
  });

  test("the cron rejects staging that never reached a review fail-closed and cancels its session", async () => {
    const uploads = failingUploads();
    const run = await runManaged({ session: uploads.session });
    expect((await sessionRows(run))[0].state).toBe("upload_failed");

    await runHeldReleaseUpkeep(
      inlineEnv(run),
      buildCtxWithGateway(),
      run.db,
      Date.now() + DAY + MINUTE,
    );

    const gate = await getGateForOrganization(run.db, run.owner.organizationId, run.gateId);
    expect(gate?.status).toBe("rejected");
    expect(gate?.decisionComment).toMatch(/staging the release never completed/);
    // The cron is global: earlier tests' stalled gates may be delivered in the same tick.
    expect(run.decisions.map((decision) => decision.state)).toContain("rejected");
    expect(run.decisions.every((decision) => decision.state === "rejected")).toBe(true);
    expect((await sessionRows(run))[0].state).toBe("canceled");
    expect(afterStaging(run).map((request) => request.method)).toContain("DELETE");
    expect((await run.readEvents()).map((event) => event.metadataJson)).toContainEqual(
      expect.objectContaining({ decidedBy: "automatic", reason: "staging_abandoned" }),
    );
  });

  test("the cron leaves recent staging faults and reviewed gates alone", async () => {
    const uploads = failingUploads();
    const failed = await runManaged({ session: uploads.session });
    await runHeldReleaseUpkeep(inlineEnv(failed), buildCtxWithGateway(), failed.db);
    expect((await sessionRows(failed))[0].state).toBe("upload_failed");
    expect(
      (await getGateForOrganization(failed.db, failed.owner.organizationId, failed.gateId))?.status,
    ).toBe("pending");

    // Held and reviewed: waiting on a human, however long.
    const reviewed = await runManaged();
    await runHeldReleaseUpkeep(
      inlineEnv(reviewed),
      buildCtxWithGateway(),
      reviewed.db,
      Date.now() + DAY + MINUTE,
    );
    const gate = await getGateForOrganization(
      reviewed.db,
      reviewed.owner.organizationId,
      reviewed.gateId,
    );
    expect(gate?.status).toBe("pending");
    expect((await sessionRows(reviewed))[0].state).toBe("held");
    expect(afterStaging(reviewed).some((request) => request.method === "DELETE")).toBe(false);
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

    expect(await upsertPyPiStageSession(run.db, values)).toEqual({ blockedBy: "published" });
    expect((await sessionRows(run))[0].state).toBe("published");

    await run.db
      .update(schema.pypiStageSessions)
      .set({ state: "stale" })
      .where(eq(schema.pypiStageSessions.id, row.id));
    expect(await upsertPyPiStageSession(run.db, values)).toMatchObject({
      row: { id: row.id, state: "staging" },
    });
  });

  test("deleting a token also retires stale and not-yet-held sessions, so no rejection acts on them", async () => {
    const run = await runManaged();
    await run.db
      .update(schema.pypiStageSessions)
      .set({ state: "stale" })
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
    expect((await sessionRows(run))[0].state).toBe("token_removed");
    const before = run.session.requests.length;
    await decide(run, "rejected");
    expect(run.session.requests.length).toBe(before);
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
    await seedWorkflowGate(owner, { ecosystem: "pypi", decision: null });
    const repositoryId = await gateRepository(owner);

    const initial = (await (await call(app, "GET", "/api/v1/pypi-project-tokens", org)).json()) as {
      repositories: unknown[];
    };
    expect(initial.repositories).toEqual([{ repositoryId, repositoryFullName: "octo/release" }]);
    const created = await call(app, "POST", "/api/v1/pypi-project-tokens", {
      ...org,
      body: { project: "Demo_Package", index: "https://pypi.org", repositoryId, token: PYPI_TOKEN },
    });
    const createdText = await created.text();
    expect(created.status).toBe(201);
    const { token } = JSON.parse(createdText) as {
      token: { id: string; projectName: string; repositoryId: number; repositoryFullName: string };
    };
    expect(token).toMatchObject({
      projectName: "demo-package",
      repositoryId,
      repositoryFullName: "octo/release",
    });

    const duplicate = await call(app, "POST", "/api/v1/pypi-project-tokens", {
      ...org,
      body: { project: "demo-package", repositoryId, token: PYPI_TOKEN },
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

  test("a token is bound to one PyPI-gated repository of the organization", async () => {
    const owner = await seedUser();
    const stranger = await seedUser();
    await seedWorkflowGate(owner, { ecosystem: "npm", decision: null });
    const npmRepository = await gateRepository(owner);
    await seedWorkflowGate(stranger, { ecosystem: "pypi", decision: null });
    const foreignRepository = await gateRepository(stranger);
    const app = tokenApp(owner.userId);

    for (const repositoryId of [undefined, "1", npmRepository, foreignRepository]) {
      const res = await call(app, "POST", "/api/v1/pypi-project-tokens", {
        activeOrganizationId: owner.organizationId,
        body: { project: "demo-package", repositoryId, token: PYPI_TOKEN },
      });
      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject({
        error: "repositoryId must be a repository mapped to a PyPI release target",
      });
    }
    expect(
      await owner.db
        .select()
        .from(schema.pypiProjectTokens)
        .where(eq(schema.pypiProjectTokens.organizationId, owner.organizationId)),
    ).toEqual([]);
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
