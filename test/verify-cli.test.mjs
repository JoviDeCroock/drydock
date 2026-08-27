import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, test } from "vitest";
import {
  createDrydockClient,
  runCli,
  validatePolicy,
  verifyDependencies,
} from "../packages/verify/src/index.mjs";

function consumerRepository(policy) {
  const cwd = mkdtempSync(path.join(tmpdir(), "drydock-verify-"));
  execFileSync("git", ["init", "-q"], { cwd });
  execFileSync("git", ["config", "user.email", "verify@example.com"], { cwd });
  execFileSync("git", ["config", "user.name", "Verify Test"], { cwd });
  writeFileSync(
    path.join(cwd, "package-lock.json"),
    JSON.stringify({
      lockfileVersion: 3,
      packages: {
        "": {},
        "node_modules/left-pad": {
          version: "1.0.0",
          resolved: "https://registry.npmjs.org/left-pad/-/left-pad-1.0.0.tgz",
        },
      },
    }),
  );
  writeFileSync(path.join(cwd, "drydock.policy.json"), JSON.stringify(policy));
  execFileSync("git", ["add", "."], { cwd });
  execFileSync("git", ["commit", "-qm", "base"], { cwd });
  writeFileSync(
    path.join(cwd, "package-lock.json"),
    JSON.stringify({
      lockfileVersion: 3,
      packages: {
        "": {},
        "node_modules/left-pad": {
          version: "2.0.0",
          resolved: "https://registry.npmjs.org/left-pad/-/left-pad-2.0.0.tgz",
        },
      },
    }),
  );
  return cwd;
}

function verdict(overrides = {}) {
  return {
    schema: "drydock.verdict.v1",
    grade: "notable",
    to: {
      version: "2.0.0",
      publishedAt: "2026-08-01T00:00:00.000Z",
      integrity: { sha1: "a".repeat(40) },
    },
    capabilities: { escalations: [], confident: true },
    diffUrl: "https://drydock.org/diff/left-pad/1.0.0/2.0.0",
    ...overrides,
  };
}

function response(body, status = 200, headers = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

describe("drydock verify CLI", () => {
  test("honors the public endpoint's full fixed-window retry delay", async () => {
    const sleeps = [];
    let calls = 0;
    const client = createDrydockClient({
      fetchImpl: async () => {
        calls++;
        return calls === 1
          ? response({ error: "busy" }, 429, { "retry-after": "42" })
          : response(verdict());
      },
      sleep: async (milliseconds) => sleeps.push(milliseconds),
    });

    await expect(
      client.verdict({ ecosystem: "npm", name: "left-pad", from: "1.0.0", to: "2.0.0" }),
    ).resolves.toMatchObject({ schema: "drydock.verdict.v1" });
    expect(sleeps).toEqual([42_000]);
  });

  test("writes a failing GitHub summary with a human review link", async () => {
    const cwd = consumerRepository({ maxGrade: "clear", onUnavailable: "fail" });
    const summary = path.join(cwd, "summary.md");
    let output = "";
    const exitCode = await runCli(["verify", "--base", "HEAD"], {
      cwd,
      env: { GITHUB_STEP_SUMMARY: summary },
      fetchImpl: async () => response(verdict()),
      stdout: { write: (chunk) => (output += chunk) },
      stderr: { write: () => {} },
    });

    expect(exitCode).toBe(1);
    expect(output).toContain("grade notable exceeds clear");
    expect(output).toContain("[review](https://drydock.org/diff/left-pad/1.0.0/2.0.0)");
    expect(readFileSync(summary, "utf8")).toContain("| left-pad | 1.0.0 → 2.0.0 |");
  });

  test("warns and passes when the verdict stays unavailable under fail-open policy", async () => {
    const cwd = consumerRepository({ onUnavailable: "warn" });
    let output = "";
    let calls = 0;
    const exitCode = await runCli(["--base", "HEAD"], {
      cwd,
      env: {},
      fetchImpl: async () => {
        calls++;
        return response({ error: "busy" }, 429, { "retry-after": "0" });
      },
      sleep: async () => {},
      stdout: { write: (chunk) => (output += chunk) },
      stderr: { write: () => {} },
    });

    expect(exitCode).toBe(0);
    expect(calls).toBe(3);
    expect(output).toContain("warn: verdict unavailable (HTTP 429)");
  });

  test("queries listed-review policy for the upgraded version and fails when absent", async () => {
    const cwd = consumerRepository({ requireListedReview: ["left-*"] });
    const urls = [];
    const exitCode = await runCli(["verify", "--base", "HEAD"], {
      cwd,
      env: {},
      fetchImpl: async (url) => {
        urls.push(String(url));
        return String(url).includes("/public/reviews/")
          ? response({ schema: "drydock.review-lookup.v1", listed: false })
          : response(verdict({ grade: "clear" }));
      },
      stdout: { write: () => {} },
      stderr: { write: () => {} },
    });

    expect(exitCode).toBe(1);
    expect(urls[1]).toBe(
      `https://drydock.org/public/reviews/npm/left-pad/2.0.0?sha1=${"a".repeat(40)}`,
    );
  });

  test("warns when a verdict outage also prevents byte-bound listed-review lookup", async () => {
    const cwd = consumerRepository({ requireListedReview: ["left-pad"], onUnavailable: "warn" });
    const exitCode = await runCli(["verify", "--base", "HEAD"], {
      cwd,
      env: {},
      fetchImpl: async (url) =>
        String(url).includes("/public/reviews/")
          ? response({ schema: "drydock.review-lookup.v1", listed: false })
          : response({ error: "busy" }, 503, { "retry-after": "0" }),
      sleep: async () => {},
      stdout: { write: () => {} },
      stderr: { write: () => {} },
    });

    expect(exitCode).toBe(0);
  });

  test("routes unsupported dependency sources through onUnavailable without a public request", async () => {
    let requests = 0;
    const result = await verifyDependencies(
      {
        pairs: [
          {
            ecosystem: "npm",
            name: "private-package",
            from: "1.0.0",
            to: "2.0.0",
            unavailableReason: "dependency is not resolved from the public npm registry",
          },
        ],
      },
      {
        policy: validatePolicy({ onUnavailable: "fail" }),
        client: {
          verdict: async () => requests++,
          listedReview: async () => requests++,
        },
      },
    );

    expect(requests).toBe(0);
    expect(result.ok).toBe(false);
    expect(result.results[0].violations).toContain(
      "dependency is not resolved from the public npm registry",
    );
  });
});
