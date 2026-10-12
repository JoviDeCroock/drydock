import { Range, valid } from "semver";
import { readBoundedJson } from "../../platform/bounded-body";
import { coloCacheMatch, coloCachePut } from "../../platform/colo-cache";
import { isRecord } from "../../platform/guards";
import { emitOperationalEvent } from "../../platform/observability";
import { exactDependencyVersion, unusualDependencySpecKind } from "../../review/dependency-specs";
import type { DependencyIntelVerdict, PackageJsonDiff } from "../../review/serialize";
import { isValidLegacyNpmPackageName } from "./registry";

const FEED_URL = "https://malware-list.aikido.dev/malware_predictions.json";
const CACHE_URL = "https://drydock.org/__cache/npm-dependency-intel/aikido-v1";
const MAX_FEED_BYTES = 16 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 5_000;
const FRESH_MS = 15 * 60 * 1_000;
const UNAVAILABLE_MS = 30 * 1_000;
const MAX_SPEC_LENGTH = 500;
const MAX_DISPLAYED_VERSIONS = 5;

type FeedSnapshot =
  | { status: "complete"; checkedAt: string; packages: Map<string, Set<string>> }
  | { status: "unavailable"; checkedAt: string };

interface DependencyTarget {
  packageName: string;
  matchKind: "exact" | "range";
  exactVersion?: string;
  range?: Range;
}

let memorySnapshot: FeedSnapshot | null = null;
let pendingLoad: Promise<FeedSnapshot> | null = null;

// The entire public feed is fetched once: no reviewed dependency identity or
// private registry metadata crosses this third-party boundary.
export async function enrichNpmDependencyIntel(
  diff: PackageJsonDiff,
  ctx: ExecutionContext | null,
): Promise<PackageJsonDiff> {
  const targets = diff.dependencies.map((row) =>
    row.status === "removed" ? null : dependencyTarget(row.key, row.staged),
  );
  const snapshot = targets.some(Boolean) ? await loadFeed(ctx) : null;
  const verdicts = new Map<string, DependencyIntelVerdict>();
  const dependencies = diff.dependencies.map((row, index) => {
    const { intel: _previousIntel, ...cleanRow } = row;
    if (row.status === "removed") return cleanRow;
    const target = targets[index];
    if (!target) {
      return {
        ...cleanRow,
        intel: {
          provider: "aikido" as const,
          status: "not_checked" as const,
          packageName: row.key,
        },
      };
    }
    const key = `${target.packageName}\n${row.staged}`;
    let verdict = verdicts.get(key);
    if (!verdict) {
      verdict = matchTarget(target, snapshot);
      verdicts.set(key, verdict);
    }
    return {
      ...cleanRow,
      intel: {
        ...verdict,
        ...(verdict.matchedVersions ? { matchedVersions: [...verdict.matchedVersions] } : {}),
      },
    };
  });
  return { ...diff, dependencies };
}

function dependencyTarget(key: string, spec: string | undefined): DependencyTarget | null {
  if (!isValidLegacyNpmPackageName(key) || spec === undefined || spec.length > MAX_SPEC_LENGTH) {
    return null;
  }
  let packageName = key;
  let versionSpec = spec.trim();
  if (versionSpec.startsWith("npm:")) {
    const alias = versionSpec.slice(4).match(/^(@[^/]+\/[^@]+|[^@/]+)@(.+)$/);
    if (!alias || !isValidLegacyNpmPackageName(alias[1])) return null;
    packageName = alias[1];
    versionSpec = alias[2].trim();
  }
  if (unusualDependencySpecKind(versionSpec)) return null;
  const exactVersion = exactDependencyVersion(versionSpec);
  if (exactVersion) return { packageName, matchKind: "exact", exactVersion };
  try {
    return { packageName, matchKind: "range", range: new Range(versionSpec) };
  } catch {
    return null;
  }
}

function matchTarget(
  target: DependencyTarget,
  snapshot: FeedSnapshot | null,
): DependencyIntelVerdict {
  const base = { provider: "aikido" as const, packageName: target.packageName };
  if (!snapshot || snapshot.status === "unavailable") {
    return { ...base, status: "unavailable" };
  }
  const versions = snapshot.packages.get(target.packageName);
  const matches: string[] = [];
  for (const version of versions ?? []) {
    if (
      version === "*" ||
      (target.matchKind === "exact" ? version === target.exactVersion : target.range?.test(version))
    ) {
      matches.push(version);
    }
  }
  matches.sort();
  return {
    ...base,
    status: matches.length ? "known_malware" : "no_known_malware",
    checkedAt: snapshot.checkedAt,
    matchKind: target.matchKind,
    ...(matches.length
      ? {
          matchedVersions: matches.slice(0, MAX_DISPLAYED_VERSIONS),
          matchedVersionCount: matches.length,
        }
      : {}),
  };
}

async function loadFeed(ctx: ExecutionContext | null): Promise<FeedSnapshot> {
  if (memorySnapshot && isFresh(memorySnapshot)) return memorySnapshot;
  memorySnapshot = null;
  if (pendingLoad) return pendingLoad;
  pendingLoad = refreshFeed(ctx);
  try {
    memorySnapshot = await pendingLoad;
    return memorySnapshot;
  } finally {
    pendingLoad = null;
  }
}

async function refreshFeed(ctx: ExecutionContext | null): Promise<FeedSnapshot> {
  const cachedResponse = await coloCacheMatch(new Request(CACHE_URL));
  if (cachedResponse) {
    const cached = parseCachedSnapshot(
      await readBoundedJson(cachedResponse, {
        maxBytes: MAX_FEED_BYTES,
        deadlineMs: Date.now() + FETCH_TIMEOUT_MS,
      }),
    );
    if (cached && isFresh(cached)) return cached;
  }

  const controller = new AbortController();
  const deadlineMs = Date.now() + FETCH_TIMEOUT_MS;
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  let snapshot: FeedSnapshot;
  let failureCode = "fetch_failed";
  try {
    const response = await fetch(FEED_URL, {
      method: "GET",
      credentials: "omit",
      redirect: "error",
      headers: { accept: "application/json" },
      signal: controller.signal,
    });
    if (!response.ok) {
      await response.body?.cancel();
      failureCode = "http_status";
      throw new Error("intel_http_status");
    }
    const packages = parseFeed(
      await readBoundedJson(response, { maxBytes: MAX_FEED_BYTES, deadlineMs }),
    );
    if (!packages) {
      failureCode = "invalid_feed";
      throw new Error("intel_invalid_feed");
    }
    snapshot = { status: "complete", checkedAt: new Date().toISOString(), packages };
  } catch {
    snapshot = { status: "unavailable", checkedAt: new Date().toISOString() };
    emitOperationalEvent("warn", "dependency.intel.unavailable", {
      provider: "aikido",
      status: "unavailable",
      errorCode: failureCode,
    });
  } finally {
    clearTimeout(timeout);
  }

  if (ctx) {
    try {
      const ttlSeconds = (snapshot.status === "complete" ? FRESH_MS : UNAVAILABLE_MS) / 1_000;
      const payload =
        snapshot.status === "complete"
          ? {
              ...snapshot,
              packages: [...snapshot.packages].map(([name, versions]) => [name, [...versions]]),
            }
          : snapshot;
      coloCachePut(
        ctx,
        new Request(CACHE_URL),
        new Response(JSON.stringify(payload), {
          headers: {
            "content-type": "application/json",
            "cache-control": `public, max-age=${ttlSeconds}`,
          },
        }),
      );
    } catch {
      // Cache availability never changes the feed result already validated.
    }
  }
  return snapshot;
}

function parseFeed(value: unknown): Map<string, Set<string>> | null {
  if (!Array.isArray(value)) return null;
  const packages = new Map<string, Set<string>>();
  for (const entry of value) {
    if (
      !isRecord(entry) ||
      typeof entry.package_name !== "string" ||
      !entry.package_name ||
      entry.package_name.length > 214 ||
      typeof entry.version !== "string" ||
      !entry.version ||
      entry.version.length > 128 ||
      typeof entry.reason !== "string" ||
      !entry.reason ||
      entry.reason.length > 64
    ) {
      return null;
    }
    const reason = entry.reason.toUpperCase();
    // A new classifier could change the meaning of an absence; do not turn an
    // unrecognized feed contract into a negative malware verdict.
    if (reason !== "MALWARE" && reason !== "PROTESTWARE" && reason !== "TELEMETRY") return null;
    if (reason !== "MALWARE") continue;
    if (entry.version !== "*" && !valid(entry.version)) return null;
    const versions = packages.get(entry.package_name) ?? new Set<string>();
    versions.add(entry.version);
    packages.set(entry.package_name, versions);
  }
  return packages;
}

function parseCachedSnapshot(value: unknown): FeedSnapshot | null {
  if (!isRecord(value) || typeof value.checkedAt !== "string") return null;
  if (value.status === "unavailable") {
    return { status: "unavailable", checkedAt: value.checkedAt };
  }
  if (value.status !== "complete" || !Array.isArray(value.packages)) return null;
  const packages = new Map<string, Set<string>>();
  for (const entry of value.packages) {
    if (
      !Array.isArray(entry) ||
      entry.length !== 2 ||
      typeof entry[0] !== "string" ||
      !entry[0] ||
      entry[0].length > 214 ||
      !Array.isArray(entry[1]) ||
      !entry[1].length
    ) {
      return null;
    }
    const versions = new Set<string>();
    for (const version of entry[1]) {
      if (
        typeof version !== "string" ||
        version.length > 128 ||
        (version !== "*" && !valid(version))
      ) {
        return null;
      }
      versions.add(version);
    }
    if (packages.has(entry[0])) return null;
    packages.set(entry[0], versions);
  }
  return { status: "complete", checkedAt: value.checkedAt, packages };
}

function isFresh(snapshot: FeedSnapshot): boolean {
  const ageMs = Date.now() - Date.parse(snapshot.checkedAt);
  return ageMs >= 0 && ageMs < (snapshot.status === "complete" ? FRESH_MS : UNAVAILABLE_MS);
}
