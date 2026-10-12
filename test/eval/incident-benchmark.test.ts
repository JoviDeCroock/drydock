import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { describe, expect, test } from "vitest";
import {
  classifyIncidentCase,
  incidentBenchmarkReportPath,
  runIncidentBenchmark,
} from "./incident-benchmark.mjs";

const uiReportPath = new URL(
  "../../src/features/public-content/incident-benchmark-v1.json",
  import.meta.url,
);
const report = runIncidentBenchmark();
if (process.env.UPDATE_INCIDENT_BENCHMARK === "1") {
  mkdirSync(dirname(incidentBenchmarkReportPath), { recursive: true });
  const bytes = `${JSON.stringify(report, null, 2)}\n`;
  writeFileSync(incidentBenchmarkReportPath, bytes);
  writeFileSync(uiReportPath, bytes);
}

describe("public incident behavior benchmark", () => {
  test("published results reproduce exactly with the current deterministic rules", () => {
    const published = readFileSync(incidentBenchmarkReportPath, "utf8");
    expect(report).toEqual(JSON.parse(published));
    expect(readFileSync(uiReportPath, "utf8")).toBe(published);
  });

  test("keeps the declared incident and control roster, including misses", () => {
    expect(report.cases.map((entry: { id: string }) => entry.id)).toEqual([
      "shai-hulud-harvest",
      "nx-s1ngularity-harvest",
      "shai-hulud-benign-setup",
      "nx-benign-build-helper",
    ]);
    expect(report.summary.malicious.total).toBe(2);
    expect(report.summary.benign.total).toBe(2);
    expect(report.summary.malicious.caught + report.summary.malicious.missed).toBe(2);
    expect(report.corpusSha256).toMatch(/^[a-f0-9]{64}$/);
  });

  test.each(["shai-hulud-harvest", "nx-s1ngularity-harvest"])(
    "%s cannot pass from a lifecycle hook or unchanged capabilities alone",
    (id) => {
      const fixture = JSON.parse(
        readFileSync(
          new URL(`../fixtures/incident-benchmark/v1/${id}.json`, import.meta.url),
          "utf8",
        ),
      );
      expect(fixture.previousPackageJson.scripts).toEqual(fixture.stagedPackageJson.scripts);
      const payloadRemoved = {
        ...fixture,
        stagedFiles: fixture.stagedFiles.map((file: { path: string }) =>
          file.path === "package.json"
            ? file
            : fixture.previousFiles.find(
                (previous: { path: string }) => previous.path === file.path,
              ),
        ),
      };
      expect(classifyIncidentCase(payloadRemoved).caught).toBe(false);
      const unchangedPayload = {
        ...fixture,
        previousFiles: fixture.stagedFiles,
        previousPackageJson: fixture.stagedPackageJson,
      };
      expect(classifyIncidentCase(unchangedPayload).caught).toBe(false);
    },
  );
});
