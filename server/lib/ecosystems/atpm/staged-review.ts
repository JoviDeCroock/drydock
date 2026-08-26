import type { AtpmRepoIdentity } from "./identity";
import type { AtpmPackage } from "./record";
import { fetchRecordCached, resolveIdentityCached } from "./metadata-cache";
import { fetchAtpmStagedVersion, type AtpmStagedVersion } from "./stage-record";
import {
  ATPM_NO_BASELINE_VERSION,
  formatAtpmStagedVersion,
  parseAtpmPublisherRef,
} from "./stage-ref";
import { compareSemver } from "../npm/registry";
import { PublicDiffError } from "../../public-diff/error";

export interface AtpmStagedReview {
  reviewPath: string;
  packageName: string;
  displayName: string | null;
  version: string;
  baselineVersion: string | null;
}

export async function resolveAtpmStagedReview(
  env: Cloudflare.Env,
  ctx: ExecutionContext,
  input: { publisher: string; rkey: string },
): Promise<AtpmStagedReview> {
  const ref = parseAtpmPublisherRef(input.publisher);
  if (!ref) throw new PublicDiffError("invalid publisher", 400);

  const identity = (await resolveIdentityCached(env, ctx, ref)).value;
  const candidate = await fetchAtpmStagedVersion(identity, input.rkey);
  const recordName = recordNameOf(candidate.declaredName);
  if (!recordName) {
    throw new PublicDiffError("staged candidate does not name a publishable package", 502);
  }

  const published = await loadPublishedRecord(env, ctx, identity, recordName);
  const baselineVersion = published ? selectBaselineVersion(published, candidate) : null;

  const packageName = `${identity.did}/${recordName}`;
  const from = baselineVersion ?? ATPM_NO_BASELINE_VERSION;
  const to = formatAtpmStagedVersion(candidate.rkey, candidate.recordCid);

  return {
    reviewPath: `/diff/atpm/${encodePathSegment(identity.did)}/${encodePathSegment(recordName)}/${encodeURIComponent(from)}/${encodeURIComponent(to)}`,
    packageName,
    displayName: identity.handle ? `@${identity.handle}/${recordName}` : null,
    version: candidate.version,
    baselineVersion,
  };
}

function encodePathSegment(segment: string): string {
  return encodeURIComponent(segment).replace(/^%40/, "@").replace(/%3A/g, ":");
}

function recordNameOf(packageName: string): string | null {
  const slash = packageName.indexOf("/");
  if (!packageName.startsWith("@") || slash <= 1) return null;
  if (slash !== packageName.lastIndexOf("/")) return null;
  const name = packageName.slice(slash + 1);
  return /^[a-z0-9][a-z0-9._~-]*$/.test(name) ? name : null;
}

async function loadPublishedRecord(
  env: Cloudflare.Env,
  ctx: ExecutionContext,
  identity: AtpmRepoIdentity,
  recordName: string,
): Promise<AtpmPackage | null> {
  try {
    return (await fetchRecordCached(env, ctx, identity, recordName)).value;
  } catch (err) {
    if (err instanceof PublicDiffError && err.status === 404) return null;
    throw err;
  }
}

export function selectBaselineVersion(
  published: AtpmPackage,
  candidate: Pick<AtpmStagedVersion, "version" | "tag">,
): string | null {
  const byVersion = new Set(published.versions.map((entry) => entry.version));
  const unreadableVersions = new Set(published.unreadableVersions);

  const tagged = candidate.tag ? published.tags[candidate.tag] : null;
  if (tagged && unreadableVersions.has(tagged)) {
    throw new PublicDiffError("tagged baseline version metadata is unreadable", 502);
  }
  if (tagged && byVersion.has(tagged)) return tagged;

  const ordered = [...new Set([...byVersion, ...unreadableVersions])].sort((a, b) =>
    compareSemver(b, a),
  );
  const predecessor = ordered.find((version) => compareSemver(version, candidate.version) < 0);
  const baseline = predecessor ?? ordered[0] ?? null;
  if (baseline && unreadableVersions.has(baseline)) {
    throw new PublicDiffError("baseline version metadata is unreadable", 502);
  }
  return baseline;
}
