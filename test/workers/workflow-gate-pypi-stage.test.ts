import { env } from "cloudflare:test";
import { afterEach, describe, expect, test, vi } from "vitest";
import { getScan } from "../../server/db/scans";
import { FAKE_STAGE_TOKEN, sha256HexOf, stageReference } from "../helpers/pep694-fake";
import {
  type PyPiStageGateRun as GateRun,
  runPyPiStageGate as runGate,
  SDIST,
  stagedBytes,
  WHEEL,
} from "./helpers/pypi-stage-gate";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
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

describe("PEP 694 staged PyPI gate (mode A)", () => {
  test("reviews the staged bytes when the artifact only registers the stage", async () => {
    const run = await runGate();

    expect(run.gate?.status).toBe("pending");
    expect(run.gate?.scanId).toBeTruthy();
    expect(run.decisions).toHaveLength(0);
    // Both staged distributions were parsed in the sandbox.
    expect(run.loader.calls).toHaveLength(2);

    const persisted = await getScan(
      run.db,
      run.gate!.scanId!,
      run.owner.organizationId,
      env.ARTIFACTS,
    );
    const summary = persisted?.scan.summaryJson as {
      stagedPublish?: { provenance?: unknown };
    } | null;
    expect(summary?.stagedPublish?.provenance).toEqual({
      ecosystem: "pypi",
      mode: "workflow_gate",
      artifacts: expect.arrayContaining([
        { path: WHEEL, kind: "wheel", sha256: await sha256HexOf(stagedBytes(WHEEL)) },
        { path: SDIST, kind: "sdist", sha256: await sha256HexOf(stagedBytes(SDIST)) },
      ]),
      stage: { protocol: "pep694", index: "https://pypi.org", artifactBound: false },
    });
    expect(JSON.stringify(persisted)).not.toContain(FAKE_STAGE_TOKEN);
    expectNoTokenLeak(run);
  });

  test("binds the artifact's distributions to the stage when they are byte-identical", async () => {
    const run = await runGate({
      format: "html",
      artifactFiles: {
        [`dist/${WHEEL}`]: stagedBytes(WHEEL),
        [`dist/${SDIST}`]: stagedBytes(SDIST),
      },
    });
    expect(run.gate?.status).toBe("pending");
    // The artifact parse is reused for byte-identical staged files.
    expect(run.loader.calls).toHaveLength(2);
    const persisted = await getScan(
      run.db,
      run.gate!.scanId!,
      run.owner.organizationId,
      env.ARTIFACTS,
    );
    const summary = persisted?.scan.summaryJson as {
      stagedPublish?: { provenance?: { stage?: unknown } };
    } | null;
    expect(summary?.stagedPublish?.provenance?.stage).toEqual({
      protocol: "pep694",
      index: "https://pypi.org",
      artifactBound: true,
    });
  });

  test("an artifact without a stage reference is reviewed exactly as before", async () => {
    const run = await runGate({
      reference: () => null,
      artifactFiles: { [`dist/${WHEEL}`]: stagedBytes(WHEEL) },
    });
    expect(run.gate?.status).toBe("pending");
    expect(run.stage.requests).toEqual([]);
    const persisted = await getScan(
      run.db,
      run.gate!.scanId!,
      run.owner.organizationId,
      env.ARTIFACTS,
    );
    const summary = persisted?.scan.summaryJson as {
      stagedPublish?: { provenance?: { stage?: unknown } };
    } | null;
    expect(summary?.stagedPublish?.provenance?.stage).toBeUndefined();
  });

  test("an extra staged file the artifact does not carry blocks", async () => {
    const run = await runGate({
      artifactFiles: { [`dist/${WHEEL}`]: stagedBytes(WHEEL) },
    });
    expectRejected(
      run,
      "stage_identity_mismatch",
      `${SDIST} is on the stage but not in the artifact`,
    );
    expect(run.loader.calls).toHaveLength(1);
  });

  test("an artifact file missing from the stage blocks", async () => {
    const run = await runGate({
      stageFiles: [{ filename: WHEEL, bytes: stagedBytes(WHEEL) }],
      artifactFiles: {
        [`dist/${WHEEL}`]: stagedBytes(WHEEL),
        [`dist/${SDIST}`]: stagedBytes(SDIST),
      },
    });
    expectRejected(
      run,
      "stage_identity_mismatch",
      `${SDIST} is in the artifact but not on the stage`,
    );
  });

  test("different bytes between artifact and stage block with both digest prefixes", async () => {
    const artifactBytes = new TextEncoder().encode("the artifact the workflow built");
    const run = await runGate({
      stageFiles: [{ filename: WHEEL, bytes: stagedBytes(WHEEL) }],
      artifactFiles: { [`dist/${WHEEL}`]: artifactBytes },
    });
    const artifactSha = await sha256HexOf(artifactBytes);
    const stageSha = await sha256HexOf(stagedBytes(WHEEL));
    expectRejected(
      run,
      "stage_identity_mismatch",
      `${WHEEL} sha256 differs: artifact ${artifactSha.slice(0, 12)}…, stage ${stageSha.slice(0, 12)}…`,
    );
  });

  test("staged bytes that do not match the index's own digest block", async () => {
    const run = await runGate({
      stageFiles: [{ filename: WHEEL, bytes: stagedBytes(WHEEL), declaredSha256: "c".repeat(64) }],
    });
    expectRejected(
      run,
      "stage_identity_mismatch",
      /downloaded bytes hash to .*declares cccccccccccc…/,
    );
    expect(run.loader.calls).toHaveLength(0);
  });

  test("a registered version that differs from the staged metadata blocks", async () => {
    const run = await runGate({ metadataVersion: "1.2.1" });
    // The staged filenames say 1.2.0 while the metadata says 1.2.1.
    expect(run.gate?.status).toBe("rejected");
    expect(run.gate?.failureReason).toMatch(
      /^(stage_identity_mismatch|artifact_identity_inconsistent)/,
    );
    expectNoTokenLeak(run);
  });

  test("a registered project name that differs from the staged files blocks", async () => {
    const run = await runGate({
      reference: (stageUrl) =>
        stageReference([{ name: "other-project", version: "1.2.0", stageUrl }]),
    });
    expect(run.gate?.status).toBe("rejected");
    expect(run.gate?.failureReason).toMatch(/^stage_(identity_mismatch|unavailable): /);
    expectNoTokenLeak(run);
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
    expect(run.calls.map((call) => call.url)).not.toContainEqual(
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
    expect(run.calls.map((call) => call.url)).not.toContainEqual(
      expect.stringContaining("evil.example"),
    );
  });

  test("a staged file URL off the allowlist blocks without following it", async () => {
    const run = await runGate({
      stageFiles: [
        { filename: WHEEL, bytes: stagedBytes(WHEEL), url: `https://evil.example/${WHEEL}` },
      ],
    });
    expectRejected(
      run,
      "stage_unavailable",
      `staged file ${WHEEL} is not on an allowed index origin`,
    );
    expect(run.calls.map((call) => call.url)).not.toContainEqual(
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

  test("an unreachable stage blocks", async () => {
    const run = await runGate({ page: () => new Response("unavailable", { status: 503 }) });
    expectRejected(run, "stage_unavailable", "answered HTTP 503");
  });

  test("a malformed stage reference blocks", async () => {
    const run = await runGate({ reference: () => '{"schema":"drydock.pypi-stage.v9"}' });
    expectRejected(run, "stage_reference_invalid", "schema must be drydock.pypi-stage.v1");
  });
});
