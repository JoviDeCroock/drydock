import { appendFileSync } from "node:fs";
import path from "node:path";
import { createDrydockClient } from "./client.mjs";
import { discoverDependencyPairs } from "./lockfiles.mjs";
import { evaluateVerdict, loadPolicy, requiresListedReview } from "./policy.mjs";
import { renderReport } from "./report.mjs";

export { createDrydockClient } from "./client.mjs";
export {
  diffPackageVersions,
  discoverDependencyPairs,
  parseLockfile,
  parsePackageLock,
  parsePnpmLock,
  resolveBaseRevision,
} from "./lockfiles.mjs";
export { evaluateVerdict, loadPolicy, requiresListedReview, validatePolicy } from "./policy.mjs";
export { renderReport } from "./report.mjs";

function usage() {
  return `Usage: drydock verify [options]

Options:
  --base <ref>       Git base ref or commit (default: PR base, origin/main, or HEAD^)
  --policy <path>    Policy file (default: drydock.policy.json)
  --endpoint <url>   Drydock origin (default: https://drydock.org)
  --help             Show this help
`;
}

function parseArguments(argv) {
  const args = [...argv];
  if (args[0] === "verify") args.shift();
  const options = {};
  for (let index = 0; index < args.length; index++) {
    const argument = args[index];
    if (argument === "--help" || argument === "-h") return { help: true };
    if (argument === "--base" || argument === "--policy" || argument === "--endpoint") {
      const value = args[++index];
      if (!value) throw new Error(`${argument} requires a value`);
      options[argument.slice(2)] = value;
      continue;
    }
    throw new Error(`unknown argument ${JSON.stringify(argument)}`);
  }
  return options;
}

export async function verifyDependencies(
  {
    cwd = process.cwd(),
    base,
    policyPath = "drydock.policy.json",
    endpoint = process.env.DRYDOCK_URL ?? "https://drydock.org",
    env = process.env,
    now = Date.now(),
    pairs,
  } = {},
  dependencies = {},
) {
  const policy = dependencies.policy ?? loadPolicy(path.resolve(cwd, policyPath));
  const discovery = pairs
    ? { baseRevision: base ?? null, lockfiles: [], pairs }
    : discoverDependencyPairs({ cwd, base, env });
  const client =
    dependencies.client ??
    createDrydockClient({ endpoint, fetchImpl: dependencies.fetchImpl, sleep: dependencies.sleep });
  const results = [];

  for (const pair of discovery.pairs) {
    let verdict;
    let listedReview;
    let listedReviewUnavailable = false;
    const unavailable = [];
    if (pair.unavailableReason) {
      unavailable.push(pair.unavailableReason);
    } else {
      try {
        verdict = await client.verdict(pair);
      } catch (error) {
        unavailable.push(
          `verdict unavailable (${error instanceof Error ? error.message : String(error)})`,
        );
      }
    }
    if (requiresListedReview(policy, pair.name)) {
      const publishedSha1 = verdict?.to?.integrity?.sha1;
      if (typeof publishedSha1 !== "string") {
        listedReviewUnavailable = true;
        unavailable.push("listed review unavailable (published artifact digest is unavailable)");
      } else {
        try {
          listedReview = await client.listedReview(pair, publishedSha1);
        } catch (error) {
          listedReviewUnavailable = true;
          unavailable.push(
            `listed review unavailable (${error instanceof Error ? error.message : String(error)})`,
          );
        }
      }
    }

    let evaluation = { violations: [], unavailable: [] };
    if (verdict) {
      evaluation = evaluateVerdict(pair, verdict, policy, {
        now,
        listedReview,
        listedReviewUnavailable,
      });
    } else if (requiresListedReview(policy, pair.name) && listedReview?.listed === false) {
      evaluation.violations.push("a listed maintainer review is required");
    }
    const allUnavailable = [...unavailable, ...evaluation.unavailable];
    results.push({
      pair,
      verdict,
      listedReview,
      violations: evaluation.violations,
      warnings: policy.onUnavailable === "warn" ? allUnavailable : [],
      unavailableFailures: policy.onUnavailable === "fail" ? allUnavailable : [],
    });
  }

  for (const result of results) result.violations.push(...result.unavailableFailures);
  return {
    ok: results.every((result) => result.violations.length === 0),
    report: renderReport(results, discovery),
    results,
    ...discovery,
  };
}

export async function runCli(argv, io = {}) {
  const stdout = io.stdout ?? process.stdout;
  const stderr = io.stderr ?? process.stderr;
  try {
    const args = parseArguments(argv);
    if (args.help) {
      stdout.write(usage());
      return 0;
    }
    const result = await verifyDependencies(
      {
        cwd: io.cwd ?? process.cwd(),
        base: args.base,
        policyPath: args.policy,
        endpoint: args.endpoint,
        env: io.env ?? process.env,
      },
      { fetchImpl: io.fetchImpl, sleep: io.sleep },
    );
    stdout.write(result.report);
    const summaryPath = (io.env ?? process.env).GITHUB_STEP_SUMMARY;
    if (summaryPath) appendFileSync(summaryPath, `${result.report}\n`, "utf8");
    return result.ok ? 0 : 1;
  } catch (error) {
    stderr.write(`drydock verify: ${error instanceof Error ? error.message : String(error)}\n`);
    return 2;
  }
}
