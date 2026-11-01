import { env } from "cloudflare:test";
import { eq } from "drizzle-orm";
import { afterEach, describe, expect, test, vi } from "vitest";
import * as schema from "../../server/db/schema";
import { getScan } from "../../server/db/scans";
import { listGatePackageScans } from "../../server/lib/github-app/webhook-gates";
import { githubAppRoutes } from "../../server/routes/github-app";
import type { Bindings } from "../../server/types";
import {
  FAKE_STAGE_TOKEN,
  drydockSessionReference,
  sha256HexOf,
  stageReference,
} from "../helpers/pep694-fake";
import { buildTestApp, call } from "./helpers/app";
import {
  type PyPiStageGateRun as GateRun,
  type PyPiStageScenario,
  SDIST,
  WHEEL,
  githubAppBindings,
  runPyPiStageGate,
  stagedBytes,
} from "./helpers/pypi-stage-gate";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// The second gate of a two-gate run: by default a review gate in the same run
// reviewed WHEEL + SDIST and a human approved it, the stage serves exactly
// those bytes, and the build artifact is still on the run.
const runGate = (options: PyPiStageScenario = {}) =>
  runPyPiStageGate({
    reviewGate: {},
    artifactFiles: {
      [`dist/${WHEEL}`]: stagedBytes(WHEEL),
      [`dist/${SDIST}`]: stagedBytes(SDIST),
    },
    ...options,
  });

function expectNoTokenLeak(run: GateRun) {
  const surfaces = [
    run.gate?.failureReason ?? "",
    run.gate?.decisionComment ?? "",
    JSON.stringify(run.decisions),
    JSON.stringify(run.events),
    ...run.logs,
  ];
  for (const surface of surfaces) expect(surface).not.toContain(FAKE_STAGE_TOKEN);
}

function expectRejected(run: GateRun, code: string, detail: string | RegExp) {
  expect(run.gate?.status).toBe("rejected");
  expect(run.gate?.scanId).toBeNull();
  expect(run.gate?.failureReason?.startsWith(`${code}: `)).toBe(true);
  expect(run.gate?.failureReason).toMatch(detail);
  expect(run.decisions).toHaveLength(1);
  expect(run.decisions[0].state).toBe("rejected");
  expect(run.decisions[0].comment).toMatch(/^Drydock rejected this deployment: /);
  expectNoTokenLeak(run);
}

const expectUnlinked = (run: GateRun) =>
  expectRejected(
    run,
    "stage_review_unlinked",
    "demo-package 1.2.0 has no approved Drydock review in this workflow run",
  );

const gateApp = (run: GateRun) =>
  buildTestApp((app) => app.route("/api/v1/github-app", githubAppRoutes), {
    userId: run.owner.userId,
    emailVerified: true,
  });

// Inline delivery (no queue) so the GitHub decision lands on the stubbed callback.
const routeEnv = (): Partial<Bindings> =>
  ({ ...githubAppBindings(), SCAN_QUEUE: undefined }) as unknown as Partial<Bindings>;

async function decide(run: GateRun, decision: "approved" | "rejected") {
  const [pkg] = await listGatePackageScans(run.db, run.owner.organizationId, run.gateId);
  const res = await call(
    gateApp(run),
    "POST",
    `/api/v1/github-app/workflow-gates/${run.gateId}/decision`,
    {
      body: { decision, scanId: pkg.scanId },
      activeOrganizationId: run.owner.organizationId,
      envOverride: routeEnv(),
    },
  );
  return { res, body: (await res.json()) as Record<string, unknown> };
}

async function gateScans(run: GateRun, gateId = run.gateId) {
  return run.db.select().from(schema.scans).where(eq(schema.scans.gateId, gateId));
}

describe("PEP 694 two-gate staging (mode A)", () => {
  test("verifies the stage against the approved review, then waits for a human to approve", async () => {
    const run = await runGate();

    expect(run.gate?.status).toBe("pending");
    expect(run.gate?.scanId).toBeTruthy();
    expect(run.decisions).toHaveLength(0);

    // The review is reused, not re-run: same report, same risk, undecided.
    const [reviewed] = await gateScans(run, run.review!.gateId);
    const [linked] = await gateScans(run);
    expect(linked.status).toBe("complete");
    expect(linked.decision).toBeNull();
    expect(linked.reportDigest).toBe(reviewed.reportDigest);
    expect(linked.risk).toBe(reviewed.risk);
    expect(linked.reportArtifactKey).not.toBe(reviewed.reportArtifactKey);
    const persisted = await getScan(run.db, linked.id, run.owner.organizationId, env.ARTIFACTS);
    expect(persisted?.scan.status).toBe("complete");
    expect(persisted?.files.length).toBeGreaterThan(0);
    const verification = {
      protocol: "pep694",
      index: "https://pypi.org",
      reviewedGateId: run.review!.gateId,
      reviewedScanId: reviewed.id,
      files: expect.arrayContaining([
        { filename: WHEEL, sha256: await sha256HexOf(stagedBytes(WHEEL)) },
        { filename: SDIST, sha256: await sha256HexOf(stagedBytes(SDIST)) },
      ]),
      verifiedAt: expect.any(String),
    };
    expect((linked.summaryJson as { stageVerification?: unknown }).stageVerification).toEqual(
      verification,
    );
    expect(JSON.stringify(persisted)).not.toContain(FAKE_STAGE_TOKEN);

    const view = await call(
      gateApp(run),
      "GET",
      `/api/v1/github-app/workflow-gates/by-scan/${linked.id}`,
      { activeOrganizationId: run.owner.organizationId },
    );
    const viewText = await view.text();
    expect(viewText).not.toContain(FAKE_STAGE_TOKEN);
    const { gate } = JSON.parse(viewText) as {
      gate: { packages: Array<{ stageVerification: unknown }> };
    };
    expect(gate.packages[0].stageVerification).toEqual(verification);

    const { res } = await decide(run, "approved");
    expect(res.status).toBe(200);
    expect(run.decisions.map((decision) => decision.state)).toEqual(["approved"]);
    expectNoTokenLeak(run);
  });

  test("a human can reject the verified stage", async () => {
    const run = await runGate();
    const { res } = await decide(run, "rejected");
    expect(res.status).toBe(200);
    expect(run.decisions.map((decision) => decision.state)).toEqual(["rejected"]);
  });

  test("a re-delivered job neither re-reads the stage nor duplicates the scan", async () => {
    const run = await runGate();
    const stageRequests = run.stage.requests.length;
    await run.deliver();
    await run.deliver();
    expect(run.stage.requests).toHaveLength(stageRequests);
    expect(await gateScans(run)).toHaveLength(1);
    expect(run.decisions).toHaveLength(0);
  });

  test("an extra staged file the review did not cover blocks", async () => {
    const run = await runGate({
      reviewGate: { files: { [`dist/${WHEEL}`]: stagedBytes(WHEEL) } },
      artifactFiles: { [`dist/${WHEEL}`]: stagedBytes(WHEEL) },
    });
    expectRejected(
      run,
      "stage_identity_mismatch",
      `${SDIST} is on the stage but not in the reviewed release`,
    );
  });

  test("a reviewed file missing from the stage blocks", async () => {
    const run = await runGate({ stageFiles: [{ filename: WHEEL, bytes: stagedBytes(WHEEL) }] });
    expectRejected(
      run,
      "stage_identity_mismatch",
      `${SDIST} is in the reviewed release but not on the stage`,
    );
  });

  test("staged bytes that differ from the reviewed bytes block with both digest prefixes", async () => {
    const other = new TextEncoder().encode("a wheel nobody reviewed");
    const run = await runGate({
      stageFiles: [
        { filename: WHEEL, bytes: other },
        { filename: SDIST, bytes: stagedBytes(SDIST) },
      ],
    });
    const reviewedSha = await sha256HexOf(stagedBytes(WHEEL));
    const stageSha = await sha256HexOf(other);
    expectRejected(
      run,
      "stage_identity_mismatch",
      `${WHEEL} sha256 differs: reviewed release ${reviewedSha.slice(0, 12)}…, stage ${stageSha.slice(0, 12)}…`,
    );
    // Decided on the declared digests: nothing was downloaded.
    expect(run.stage.requests).toHaveLength(1);
  });

  test("served bytes that differ from the digest the stage declares block", async () => {
    const run = await runGate({
      stageFiles: [
        {
          filename: WHEEL,
          bytes: new TextEncoder().encode("swapped after listing"),
          declaredSha256: await sha256HexOf(stagedBytes(WHEEL)),
        },
        { filename: SDIST, bytes: stagedBytes(SDIST) },
      ],
    });
    expectRejected(run, "stage_identity_mismatch", `${WHEEL} downloaded bytes hash to`);
  });

  test("a build artifact that differs from the reviewed release blocks", async () => {
    const run = await runGate({
      artifactFiles: {
        [`dist/${WHEEL}`]: new TextEncoder().encode("rebuilt wheel"),
        [`dist/${SDIST}`]: stagedBytes(SDIST),
      },
    });
    expectRejected(run, "stage_identity_mismatch", `${WHEEL} sha256 differs: reviewed release`);
  });

  test("a review gate nobody approved is not a link", async () => {
    expectUnlinked(await runGate({ reviewGate: { approve: false } }));
  });

  test("a stage without any review gate in the run blocks", async () => {
    expectUnlinked(await runGate({ reviewGate: undefined }));
  });

  test("an approved review on another repository is not a link", async () => {
    expectUnlinked(await runGate({ reviewGate: { otherRepository: true } }));
  });

  test("an approved review in another organization is not a link", async () => {
    expectUnlinked(await runGate({ reviewGate: { otherOrganization: true } }));
  });

  test("an approval of the same environment (a re-run of this gate) is not a link", async () => {
    expectUnlinked(await runGate({ reviewGate: { environment: "pypi-publish" } }));
  });

  test("a stage registered for a version the review did not cover blocks", async () => {
    const run = await runGate({
      artifactFiles: {},
      reference: (stageUrl) =>
        stageReference([{ name: "demo-package", version: "1.2.1", stageUrl }]),
    });
    expectRejected(
      run,
      "stage_review_unlinked",
      "demo-package 1.2.1 has no approved Drydock review",
    );
  });

  test("build-artifact distributions the reference does not stage block", async () => {
    const run = await runGate({
      reference: (stageUrl) =>
        stageReference([{ name: "other-project", version: "1.2.0", stageUrl }]),
    });
    expectRejected(run, "stage_reference_invalid", "registers no stage for it");
  });

  test("a reference mixing stage-url entries with Drydock-held sessions blocks", async () => {
    const run = await runGate({
      reference: (stageUrl) => {
        const workflow = JSON.parse(
          stageReference([{ name: "demo-package", version: "1.2.0", stageUrl }]),
        );
        const held = JSON.parse(drydockSessionReference([{ name: "other", version: "1.0.0" }]));
        return JSON.stringify({ ...workflow, stages: [...workflow.stages, ...held.stages] });
      },
    });
    expectRejected(run, "stage_reference_invalid", "mixes stage-url entries");
  });

  test("two artifact files with one basename block before the stage is read", async () => {
    const run = await runGate({
      artifactFiles: {
        [`a/${WHEEL}`]: new TextEncoder().encode("a different wheel"),
        [`b/${WHEEL}`]: stagedBytes(WHEEL),
      },
    });
    expectRejected(
      run,
      "stage_identity_mismatch",
      `${WHEEL} appears more than once in the artifact`,
    );
    expect(run.stage.requests).toEqual([]);
  });

  test("declared staged sizes over the release byte budget block before any download", async () => {
    const stageFiles = Array.from({ length: 31 }, (_, index) => {
      const filename = `demo_package-1.2.0-cp3${index}-cp3${index}-linux_x86_64.whl`;
      return { filename, bytes: stagedBytes(filename), size: 25 * 1024 * 1024 };
    });
    const run = await runGate({ stageFiles });
    expectRejected(run, "stage_unavailable", /staged release exceeds the \d+-byte review budget/);
    expect(run.stage.requests).toHaveLength(1);
  });

  test("a staged file declaring more than the per-file cap blocks before any download", async () => {
    const run = await runGate({
      stageFiles: [
        { filename: WHEEL, bytes: stagedBytes(WHEEL), size: 25 * 1024 * 1024 + 1 },
        { filename: SDIST, bytes: stagedBytes(SDIST) },
      ],
    });
    expectRejected(run, "stage_unavailable", `staged file ${WHEEL} declares`);
    expect(run.stage.requests).toHaveLength(1);
  });

  test("a stage host outside the allowlist is refused before any request", async () => {
    const run = await runGate({
      reference: () =>
        stageReference([
          {
            name: "demo-package",
            version: "1.2.0",
            stageUrl: `https://evil.example/stage/${FAKE_STAGE_TOKEN}/`,
          },
        ]),
    });
    expectRejected(run, "stage_reference_invalid", /stage-url must be an https URL on/);
    expect(run.calls.map((entry) => entry.url)).not.toContainEqual(
      expect.stringContaining("evil.example"),
    );
  });

  test("a stage redirect off the allowlist blocks without following it", async () => {
    const run = await runGate({
      page: () =>
        new Response(null, {
          status: 302,
          headers: { location: `https://evil.example/${FAKE_STAGE_TOKEN}` },
        }),
    });
    expectRejected(run, "stage_unavailable", "redirected off the allowed index origins");
    expect(run.calls.map((entry) => entry.url)).not.toContainEqual(
      expect.stringContaining("evil.example"),
    );
  });

  test("a staged file URL off the allowlist blocks without following it", async () => {
    const run = await runGate({
      stageFiles: [
        { filename: WHEEL, bytes: stagedBytes(WHEEL), url: `https://evil.example/${WHEEL}` },
        { filename: SDIST, bytes: stagedBytes(SDIST) },
      ],
    });
    expectRejected(
      run,
      "stage_unavailable",
      `staged file ${WHEEL} is not on an allowed index origin`,
    );
    expect(run.calls.map((entry) => entry.url)).not.toContainEqual(
      expect.stringContaining("evil.example"),
    );
  });

  test("an oversized index page blocks", async () => {
    const run = await runGate({
      page: () =>
        new Response("{}", {
          headers: {
            "content-type": "application/vnd.pypi.simple.v1+json",
            "content-length": String(64 * 1024 * 1024),
          },
        }),
    });
    expectRejected(run, "stage_unavailable", "too large or could not be read");
  });

  test("a malformed index page blocks", async () => {
    const run = await runGate({
      page: () =>
        new Response("{not json", {
          headers: { "content-type": "application/vnd.pypi.simple.v1+json" },
        }),
    });
    expectRejected(run, "stage_unavailable", "stage index JSON is malformed");
  });

  test("an HTML (PEP 503) stage page verifies the same way", async () => {
    const run = await runGate({ format: "html" });
    expect(run.gate?.status).toBe("pending");
    expect(run.gate?.scanId).toBeTruthy();
  });

  test("an unreachable stage blocks", async () => {
    const run = await runGate({ page: () => new Response("unavailable", { status: 503 }) });
    expectRejected(run, "stage_unavailable", "answered HTTP 503");
  });

  test("a malformed stage reference blocks", async () => {
    const run = await runGate({ reference: () => '{"schema":"drydock.pypi-stage.v9"}' });
    expectRejected(run, "stage_reference_invalid", "schema must be drydock.pypi-stage.v1");
  });
});

describe("PyPI gate without a stage reference", () => {
  test("an artifact without a stage reference is reviewed exactly as before", async () => {
    const run = await runPyPiStageGate({
      reference: () => null,
      artifactFiles: { [`dist/${WHEEL}`]: stagedBytes(WHEEL) },
    });
    expect(run.gate?.status).toBe("pending");
    expect(run.stage.requests).toEqual([]);
    const [scan] = await gateScans(run);
    const summary = scan.summaryJson as {
      stagedPublish?: { provenance?: { stage?: unknown } };
      stageVerification?: unknown;
    } | null;
    expect(summary?.stagedPublish?.provenance?.stage).toBeUndefined();
    expect(summary?.stageVerification).toBeUndefined();
  });
});
