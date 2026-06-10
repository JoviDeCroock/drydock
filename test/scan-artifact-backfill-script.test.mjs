import { describe, expect, test } from "vitest";
import { parseBackfillArgs, runBackfill } from "../scripts/backfill-scan-artifacts.mjs";

const ENCODER = new TextEncoder();

function captureStream() {
  let output = "";
  return {
    write(chunk) {
      output += chunk;
    },
    output() {
      return output;
    },
  };
}

function d1Response(results) {
  return JSON.stringify([{ results, success: true, meta: { duration: 0 } }]);
}

function stableJson(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  const entries = Object.entries(value)
    .filter(([, item]) => item !== undefined)
    .sort(([a], [b]) => a.localeCompare(b));
  return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`).join(",")}}`;
}

async function sha256Hex(value) {
  const digest = await crypto.subtle.digest("SHA-256", ENCODER.encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function buildLegacyScanRows() {
  const diff = [
    { path: "index.js", status: "added", stagedSize: 18, stagedSha256: "index-sha", flags: [] },
  ];
  const summary = {
    report: {
      version: 1,
      generatedAt: "2026-06-08T00:00:00.000Z",
      rulesVersion: "rules-v1",
    },
    baseline: { version: null, tag: "latest", source: "none", distTagVersion: null },
    risk: {
      artifactRisk: "low",
      releaseRisk: "low",
      contextRisk: "low",
      releaseFindingCount: 1,
      contextFindingCount: 0,
      unknownFindingCount: 0,
    },
    safety: {
      tokenExposedToSandbox: false,
      directSandboxNetwork: false,
      outboundPolicy: "test",
      aiInputPolicy: "test",
      fileExplorerPolicy: "test",
    },
    stagedPublish: {
      id: "stage-123",
      packageName: "@org/wrangler-backfill",
      version: "1.0.0",
      tag: "latest",
      access: "public",
    },
    packageJsonDiff: {},
    diff,
    findingAnnotations: [{ id: "finding_1", diffStatus: "added", releaseDelta: true }],
  };
  const aiFindings = {
    status: "unavailable",
    risk: "low",
    releaseAssessment: "not_assessed",
    summary: "AI review is disabled.",
    findings: [],
    requiresManualReview: false,
    model: null,
  };
  const payload = {
    version: 1,
    rulesVersion: "rules-v1",
    stageId: "stage-123",
    stagedPublish: summary.stagedPublish,
    package: {
      name: "@org/wrangler-backfill",
      stagedVersion: "1.0.0",
      stagedTag: "latest",
      previousVersion: null,
    },
    baseline: summary.baseline,
    fileCount: 1,
    previousFileCount: 0,
    packageJson: { name: "@org/wrangler-backfill", version: "1.0.0" },
    packageJsonDiff: {},
    diff,
    ruleFindings: [
      {
        severity: "high",
        file: "index.js",
        evidence: "process.env access",
        reason: "install-time script reads npm environment",
        ruleId: "code.credential-access",
        ruleVersion: "rules-v1",
      },
    ],
    findingAnnotations: [{ findingIndex: 0, diffStatus: "added", releaseDelta: true }],
    aiFindings,
    risk: summary.risk,
    safety: summary.safety,
  };
  return {
    scan: {
      id: "scan_1",
      stageId: "stage-123",
      organizationId: "org_123",
      packageName: "@org/wrangler-backfill",
      stagedVersion: "1.0.0",
      previousVersion: null,
      summaryJson: JSON.stringify(summary),
      aiJson: JSON.stringify(aiFindings),
      reportVersion: 1,
      reportDigest: await sha256Hex(stableJson(payload)),
    },
    files: [
      {
        path: "index.js",
        status: "added",
        size: 18,
        sha256: "index-sha",
        flagsJson: JSON.stringify([]),
        textSample: "console.log('ok');\n",
      },
    ],
    findings: [
      {
        id: "finding_1",
        severity: "high",
        file: "index.js",
        evidence: "process.env access",
        reason: "install-time script reads npm environment",
        line: null,
        ruleId: "code.credential-access",
        ruleVersion: "rules-v1",
      },
    ],
  };
}

function createWranglerHarness({ organizations, rows }) {
  const calls = [];
  const objects = new Map();
  const state = {
    candidatesServed: new Set(),
    artifactManifestKey: null,
  };

  return {
    calls,
    objects,
    async runWrangler(args, options = {}) {
      calls.push({ args, input: options.input });
      if (args.includes("d1")) {
        const sql = args[args.indexOf("--command") + 1];
        if (sql.includes("FROM organizations")) return d1Response(organizations);
        if (sql.includes("FROM scans") && sql.includes("artifact_storage_version IS NULL")) {
          const org = organizations.find((item) => sql.includes(`organization_id = '${item.id}'`));
          if (!org || state.candidatesServed.has(org.id)) return d1Response([]);
          state.candidatesServed.add(org.id);
          return d1Response(rows[org.id]?.scan ? [rows[org.id].scan] : []);
        }
        if (sql.includes("FROM scan_files")) return d1Response(rows.org_123.files);
        if (sql.includes("FROM scan_findings")) {
          const selectList = sql.slice(sql.indexOf("SELECT"), sql.indexOf("FROM scan_findings"));
          const includesId = selectList
            .split("\n")
            .some((line) => line.trim().replace(/,$/, "") === "id");
          return d1Response(
            includesId
              ? rows.org_123.findings
              : rows.org_123.findings.map(({ id: _id, ...finding }) => finding),
          );
        }
        if (sql.includes("UPDATE scans")) {
          state.artifactManifestKey = /artifact_manifest_key = '([^']+)'/.exec(sql)?.[1] ?? null;
          return d1Response([]);
        }
        if (sql.includes("SELECT") && sql.includes("artifact_storage_version")) {
          return d1Response([
            {
              artifactStorageVersion: 1,
              artifactManifestKey: state.artifactManifestKey,
            },
          ]);
        }
        throw new Error(`unexpected d1 sql: ${sql}`);
      }

      const objectPath = args[args.indexOf("object") + 2];
      if (args.includes("put")) {
        objects.set(objectPath, options.input);
        return "";
      }
      if (args.includes("get")) {
        return objects.get(objectPath);
      }
      throw new Error(`unexpected wrangler args: ${args.join(" ")}`);
    },
  };
}

describe("scan artifact backfill script", () => {
  test("backfills one organization through Wrangler D1 and R2 commands", async () => {
    const rows = { org_123: await buildLegacyScanRows() };
    const harness = createWranglerHarness({
      organizations: [{ id: "org_123", name: "Org 123" }],
      rows,
    });
    const stdout = captureStream();
    const options = parseBackfillArgs(["--organization-id", "org_123", "--limit", "25"], {});

    await expect(
      runBackfill(options, { runWrangler: harness.runWrangler, stdout }),
    ).resolves.toMatchObject({
      scanned: 1,
      backfilled: 1,
    });

    expect(harness.calls.some((call) => call.args.includes("d1"))).toBe(true);
    expect(
      harness.calls.some((call) => call.args.includes("r2") && call.args.includes("put")),
    ).toBe(true);
    expect([...harness.objects.keys()]).toContain(
      "staged-publish-review-artifacts/orgs/org_123/scans/scan_1/v1/manifest.json",
    );
    expect(JSON.stringify(harness.calls)).not.toContain("cookie");
    expect(stdout.output()).toContain("nextCursor=done");
  });

  test("all-organization runs enumerate organizations from D1", async () => {
    const rows = { org_123: await buildLegacyScanRows(), org_empty: {} };
    const harness = createWranglerHarness({
      organizations: [
        { id: "org_123", name: "Org 123" },
        { id: "org_empty", name: "Empty Org" },
      ],
      rows,
    });
    const stdout = captureStream();
    const options = parseBackfillArgs(["--all-organizations"], {});

    await expect(
      runBackfill(options, { runWrangler: harness.runWrangler, stdout }),
    ).resolves.toMatchObject({
      scanned: 1,
      backfilled: 1,
    });

    expect(stdout.output()).toContain("Org 123 (org_123)");
    expect(stdout.output()).toContain("Empty Org (org_empty)");
  });

  test("rejects ambiguous all-organization resume cursors", () => {
    expect(() => parseBackfillArgs(["--all-organizations", "--cursor=scan_123"], {})).toThrow(
      "--cursor is only supported for a single organization run",
    );
  });

  test("requires an organization target", () => {
    expect(() => parseBackfillArgs([], {})).toThrow("set --organization-id or --all-organizations");
  });
});
