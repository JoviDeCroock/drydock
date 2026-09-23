import { afterEach, describe, expect, test, vi } from "vitest";
import { ScanDetailModel, type PersistedScanDetail } from "../src/models/scan";

type Finding = PersistedScanDetail["findings"][number];

function file(path: string, status: string): PersistedScanDetail["files"][number] {
  return { path, status, size: 10, sha256: null, flagsJson: [], textSample: null };
}

function finding(id: string, file: string, severity: string): Finding {
  return {
    id,
    scanId: "scan-1",
    severity,
    file,
    evidence: "evidence",
    reason: "reason",
    source: "rule",
  };
}

function completeDetail(findings: Finding[]): PersistedScanDetail {
  return {
    scan: {
      id: "scan-1",
      stageId: "stage-1",
      packageName: "left-pad",
      stagedVersion: "1.0.1",
      previousVersion: "1.0.0",
      risk: "critical",
      status: "complete",
      createdAt: "2026-06-09T00:00:00.000Z",
      updatedAt: "2026-06-09T00:00:00.000Z",
    },
    files: [
      file("LICENSE", "unchanged"),
      file("README.md", "modified"),
      file("index.js", "modified"),
      file("secrets.txt", "added"),
    ],
    findings,
    events: [],
  };
}

async function loadedModel(detail: PersistedScanDetail, selected: string | null = null) {
  vi.stubGlobal(
    "fetch",
    vi.fn(() =>
      Promise.resolve(
        new Response(JSON.stringify(detail), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      ),
    ),
  );
  const model = new ScanDetailModel("scan-1");
  model.selectedPath.value = selected;
  await model.load();
  return model;
}

describe("ScanDetailModel initial file", () => {
  let model: InstanceType<typeof ScanDetailModel> | null = null;

  afterEach(() => {
    model?.[Symbol.dispose]();
    model = null;
    vi.unstubAllGlobals();
  });

  test("opens the changed file with the most severe finding", async () => {
    model = await loadedModel(
      completeDetail([
        finding("a", "index.js", "low"),
        finding("b", "secrets.txt", "critical"),
        finding("c", "LICENSE", "critical"),
      ]),
    );
    expect(model.selectedPath.value).toBe("secrets.txt");
  });

  test("falls back to the first changed file when no changed file has a finding", async () => {
    model = await loadedModel(completeDetail([finding("c", "LICENSE", "critical")]));
    expect(model.selectedPath.value).toBe("README.md");
  });

  test("keeps a file already selected from the URL", async () => {
    model = await loadedModel(
      completeDetail([finding("b", "secrets.txt", "critical")]),
      "README.md",
    );
    expect(model.selectedPath.value).toBe("README.md");
  });
});
