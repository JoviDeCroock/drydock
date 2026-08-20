import { resolveAtpmRepoIdentity, type AtpmRepoIdentity } from "./identity";
import { fetchAtpmPackageRecord, type AtpmPackage } from "./record";
import { fetchAtpmStagedVersion, type AtpmStagedVersion } from "./stage-record";
import {
  ATPM_NO_BASELINE_VERSION,
  formatAtpmStagedVersion,
  parseAtpmPublisherRef,
} from "./stage-ref";
import { compareSemver } from "../npm/registry";
import { PublicDiffError } from "../../public-diff/error";

/**
 * Turning "this account staged something" into a review anyone can open.
 *
 * The whole point of this module is that the caller needs almost nothing to use
 * it. atpm's staged dashboard knows the publishing account and the record key —
 * it wrote them — so that is the entire input, and everything else is resolved
 * here: which package the candidate is for, which published release it should be
 * read against, and which revision of the record is current.
 *
 * No credential is involved on either side, and none is asked for. A staged
 * candidate is a public record in the publisher's own repository; the review of
 * it is the same deterministic diff the published surface produces. Putting a
 * sign-in in front of that would be asking a maintainer to create an account
 * with a third party in order to read something already public — at exactly the
 * moment they are deciding whether to publish.
 */

export interface AtpmStagedReview {
  /** Path on this deployment that renders the review. */
  reviewPath: string;
  /** Canonical DID-form package name the review is filed under. */
  packageName: string;
  /** `@handle/name`, when the handle verified in both directions. */
  displayName: string | null;
  /** Version the candidate would publish as. */
  version: string;
  /** Published version the candidate is read against, or null for a first release. */
  baselineVersion: string | null;
  /** The id `npm stage approve` takes for this exact candidate. */
  approveId: string;
}

/**
 * Resolve a staged candidate to the diff URL that reviews it.
 *
 * Every failure here is a 404 or 502 with a short reason rather than a partial
 * answer: a link that resolves to the wrong package's review would be worse than
 * one that does not resolve at all.
 */
export async function resolveAtpmStagedReview(
  _env: Cloudflare.Env,
  _ctx: ExecutionContext,
  input: { publisher: string; rkey: string },
): Promise<AtpmStagedReview> {
  const ref = parseAtpmPublisherRef(input.publisher);
  if (!ref) throw new PublicDiffError("invalid publisher", 400);

  const identity = await resolveAtpmRepoIdentity(ref);
  const candidate = await fetchAtpmStagedVersion(identity, input.rkey);
  const recordName = recordNameOf(candidate.declaredName);
  if (!recordName) {
    throw new PublicDiffError("staged candidate does not name a publishable package", 502);
  }

  const published = await loadPublishedRecord(identity, recordName);
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
    approveId: candidate.stageId,
  };
}

/**
 * `:` and `@` are legal unencoded path characters and appear in every atpm
 * identifier, so escaping them would only make these URLs unreadable. Matches
 * how the client builds the same path.
 */
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

/** A package with no published record yet is a first release, not a failure. */
async function loadPublishedRecord(
  identity: AtpmRepoIdentity,
  recordName: string,
): Promise<AtpmPackage | null> {
  try {
    return await fetchAtpmPackageRecord(identity, recordName);
  } catch (err) {
    if (err instanceof PublicDiffError && err.status === 404) return null;
    throw err;
  }
}

/**
 * Which published release this candidate should be read against.
 *
 * The reviewer's question is "what does approving this change for someone who
 * installs it?", so the sharpest answer is the release the candidate would
 * displace: whatever currently sits behind the dist-tag it would move. Failing
 * that, its immediate semver predecessor, then the highest published version.
 * Same order the authenticated staged review uses, because it is the same
 * question.
 */
export function selectBaselineVersion(
  published: AtpmPackage,
  candidate: Pick<AtpmStagedVersion, "version" | "tag">,
): string | null {
  const byVersion = new Set(published.versions.map((entry) => entry.version));

  const tagged = candidate.tag ? published.tags[candidate.tag] : null;
  if (tagged && byVersion.has(tagged)) return tagged;

  const ordered = [...published.versions]
    .map((entry) => entry.version)
    .sort((a, b) => compareSemver(b, a));
  const predecessor = ordered.find((version) => compareSemver(version, candidate.version) < 0);
  return predecessor ?? ordered[0] ?? null;
}
