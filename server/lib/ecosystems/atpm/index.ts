import { downloadAtpmArtifact } from "./download";
import { atpmStagedFindings } from "./findings";
import { resolveAtpmRepoIdentity, type AtpmRepoIdentity } from "./identity";
import {
  fetchAtpmPackageRecord,
  isValidAtpmVersion,
  type AtpmPackage,
  type AtpmVersion,
} from "./record";
import { fetchAtpmStagedVersion, type AtpmStagedVersion } from "./stage-record";
import { parseAtpmStageId, type AtpmStageRef } from "./stage-ref";
import { fetchAtpmTrustPublisher, type AtpmTrustPublisher } from "./trust-publisher";
import { buildNpmFindings } from "../npm/findings";
import { compareSemver } from "../npm/registry";
import type {
  AcquiredArtifact,
  AdapterBroker,
  AdapterContext,
  BaselineInfo,
  PackageAdapter,
} from "../package-adapter";
import { PublicDiffError } from "../../public-diff/error";

/**
 * atpm's staged-review capability: reviewing a release candidate before its
 * publisher approves it.
 *
 * This is npm's staged-publish flow with the credential removed. On npm a
 * staged candidate is private registry state, so reviewing one requires the
 * organization's token and every byte moves through `NpmStageGateway`. On atpm
 * a candidate is a `dev.atpm.alpha.stage` record in the publisher's own
 * repository with the tarball attached as a content-addressed blob — public
 * data, addressed the same way the published diff addresses a release. So this
 * adapter holds no credential at all, and its broker exists only because the
 * pipeline expects one.
 *
 * What that buys, beyond one less secret: the bytes reviewed here are pinned by
 * CID, and approving the candidate does not rebuild or re-upload anything. The
 * artifact this scan parsed is the artifact that installs. npm and PyPI workflow
 * gates have to close that gap with a checksum file the publish job re-checks;
 * here there is no gap to close.
 *
 * Drydock never approves. `npm stage approve <stageId>` stays with the
 * maintainer, and the id it takes is derived in `./stage-record.ts` so the
 * review can name the exact candidate it reviewed. See
 * `docs/atpm-staged-review.md`.
 */
export interface AtpmAdapterInput {
  ref: AtpmStageRef;
  maxFiles?: number;
}

/**
 * Staged metadata carried alongside the artifact, opaque to the pipeline. This
 * is what the workbench renders and what the report persists, so it holds
 * everything a reviewer needs to act — including the id that approves it.
 */
export interface AtpmStagedDetails {
  /** Drydock's address for the candidate: `atpm:<did>:<rkey>`. */
  id: string;
  /** The id `npm stage approve` takes, derived from the record URI and CID. */
  approveId: string;
  uri: string;
  did: string;
  /** Verified handle, when the publisher has one. */
  handle: string | null;
  pds: string;
  packageName: string;
  /** Unscoped record key the candidate would publish under. */
  recordName: string;
  version: string;
  /** Version the candidate's own manifest claims, which must agree with above. */
  declaredVersion: string | null;
  tag: string | null;
  createdAt: string;
  cid: string;
  shasum: string | null;
  /** Whether the candidate's build attestation verified, and against what. */
  provenance: AtpmStagedVersion["provenance"];
  /** The publisher's trusted-publishing declaration, when they have one. */
  trustPublisher: AtpmTrustPublisher | null;
}

/** The pipeline requires a broker; nothing on this path has a secret to hold. */
class AtpmBroker implements AdapterBroker {
  dispose(): void {}
}

interface ResolvedStaged {
  identity: AtpmRepoIdentity;
  staged: AtpmStagedVersion;
  details: AtpmStagedDetails;
}

export const atpmAdapter: PackageAdapter<AtpmAdapterInput, AtpmBroker> = {
  id: "atpm",

  // Staged candidates are public records in the publisher's own repository, so
  // there is no organization credential to hold, validate, or leak.
  requiresConnection: false,

  parseInput(raw: unknown): AtpmAdapterInput {
    if (!raw || typeof raw !== "object") {
      throw new Error("atpm adapter input must be an object with a stageId");
    }
    const value = raw as Record<string, unknown>;
    const ref = parseAtpmStageId(typeof value.stageId === "string" ? value.stageId.trim() : "");
    if (!ref) throw new Error("invalid atpm stageId");
    const maxFiles = typeof value.maxFiles === "number" ? value.maxFiles : undefined;
    return { ref, ...(maxFiles === undefined ? {} : { maxFiles }) };
  },

  createBroker() {
    return new AtpmBroker();
  },

  async acquireStaged(ctx, input) {
    const resolved = await resolveStaged(input);
    const archive = await downloadAtpmArtifact(
      ctx.env,
      ctx.executionCtx,
      resolved.identity,
      resolved.staged,
      input.maxFiles === undefined ? {} : { maxFiles: input.maxFiles },
    );
    return {
      artifact: {
        files: archive.files,
        manifest: archive.packageJson ?? null,
        ...(archive.suspiciousEntries ? { suspiciousTarEntries: archive.suspiciousEntries } : {}),
      },
      details: {
        ...resolved.details,
        // Kept off `AtpmStagedDetails` because it is only used to bind findings
        // to the artifact and would otherwise be persisted for no reader.
        archiveSha1: archive.archiveSha1 ?? null,
        archiveSha512: archive.archiveSha512 ?? null,
      },
    };
  },

  async acquireBaseline(ctx, input, _broker, staged) {
    const details = staged.details as AtpmStagedDetails;
    const identity = await resolveIdentity(input.ref);

    let published: AtpmPackage;
    try {
      published = await fetchAtpmPackageRecord(identity, details.recordName);
    } catch (err) {
      // A first release has no package record at all, which is a clean
      // no-baseline review rather than an acquisition failure.
      if (err instanceof PublicDiffError && err.status === 404) {
        return { artifact: null, baseline: noBaseline("first release of this package") };
      }
      throw err;
    }

    const selected = selectAtpmBaseline(published, details);
    if (!selected.entry) return { artifact: null, baseline: selected.info };

    const archive = await downloadAtpmArtifact(
      ctx.env,
      ctx.executionCtx,
      identity,
      selected.entry,
      input.maxFiles === undefined ? {} : { maxFiles: input.maxFiles },
    );
    return {
      artifact: {
        files: archive.files,
        manifest: archive.packageJson ?? null,
        ...(archive.suspiciousEntries ? { suspiciousTarEntries: archive.suspiciousEntries } : {}),
      },
      baseline: selected.info,
    };
  },

  runFindings(args) {
    const details = args.details as (AtpmStagedDetails & StagedDigests) | null;
    return [
      // The candidate is an ordinary npm tarball, so it gets the npm rule set
      // verbatim. `details` stays null there: those findings describe an npm
      // stage record, which has no counterpart here.
      ...buildNpmFindings({
        staged: args.staged,
        details: null,
        fileDiff: args.fileDiff,
        manifestDiff: args.manifestDiff,
        stagedManifestText: args.stagedManifestText,
      }),
      ...(details
        ? atpmStagedFindings({
            staged: {
              declaredName: details.packageName,
              version: details.version,
              declaredVersion: details.declaredVersion,
              provenance: details.provenance,
              shasum: details.shasum,
            },
            manifest: args.staged.manifest,
            archiveSha1: details.archiveSha1,
            archiveSha512: details.archiveSha512,
            trustPublisher: details.trustPublisher,
            verifiedHandle: details.handle,
          })
        : []),
    ];
  },

  describe({ staged, details, previous }) {
    const stagedDetails = details as AtpmStagedDetails | null;
    return {
      name: stagedDetails?.packageName ?? staged.manifest?.name ?? null,
      stagedVersion: stagedDetails?.version ?? staged.manifest?.version ?? null,
      stagedTag: stagedDetails?.tag ?? null,
      previousVersion: previous?.manifest?.version ?? null,
    };
  },

  summarizeDetails(details) {
    if (!details) return null;
    const value = details as AtpmStagedDetails;
    return {
      id: value.id,
      // The one field a maintainer acts on: this is what `npm stage approve`
      // takes for the candidate this report describes.
      approveId: value.approveId,
      uri: value.uri,
      did: value.did,
      handle: value.handle,
      pds: value.pds,
      packageName: value.packageName,
      version: value.version,
      tag: value.tag,
      createdAt: value.createdAt,
      cid: value.cid,
      shasum: value.shasum,
      provenance: value.provenance,
      trustPublisher: value.trustPublisher,
    };
  },
};

interface StagedDigests {
  archiveSha1: string | null;
  archiveSha512: string | null;
}

/** Resolve the publisher's identity, once per acquisition step. */
function resolveIdentity(ref: AtpmStageRef): Promise<AtpmRepoIdentity> {
  return resolveAtpmRepoIdentity({
    authority: { kind: "did", did: ref.did },
    name: "x",
    packageName: `${ref.did}/x`,
  });
}

async function resolveStaged(input: AtpmAdapterInput): Promise<ResolvedStaged> {
  const identity = await resolveIdentity(input.ref);
  const staged = await fetchAtpmStagedVersion(identity, input.ref.rkey);
  const recordName = recordNameFor(staged.declaredName);
  if (!recordName) {
    throw new PublicDiffError("staged candidate does not name a publishable package", 502);
  }
  const trustPublisher = await fetchAtpmTrustPublisher(identity, recordName);

  return {
    identity,
    staged,
    details: {
      id: input.ref.stageId,
      approveId: staged.stageId,
      uri: staged.uri,
      did: identity.did,
      handle: identity.handle,
      pds: identity.pds,
      packageName: staged.declaredName,
      recordName,
      version: staged.version,
      declaredVersion: staged.declaredVersion,
      tag: staged.tag,
      createdAt: staged.createdAt,
      cid: staged.cid,
      shasum: staged.declaredShasum,
      provenance: staged.provenance,
      trustPublisher,
    },
  };
}

/**
 * The record key a scoped atpm name publishes under. Kept syntactic: a staged
 * candidate's scope is checked against the publisher's verified handle in
 * `./findings.ts`, where a disagreement can be reported rather than thrown.
 */
function recordNameFor(packageName: string): string | null {
  const slash = packageName.indexOf("/");
  if (!packageName.startsWith("@") || slash <= 1) return null;
  if (slash !== packageName.lastIndexOf("/")) return null;
  const name = packageName.slice(slash + 1);
  return /^[a-z0-9][a-z0-9._~-]*$/.test(name) && name.length <= 209 ? name : null;
}

function noBaseline(reason: string): BaselineInfo {
  return { version: null, tag: null, source: "none", distTagVersion: null, reason };
}

/**
 * Pick the published version a candidate should be read against.
 *
 * Preference order matches npm's staged flow, because a reviewer's question is
 * the same one: what does approving this actually change for an installer? The
 * dist-tag the candidate would take is the sharpest answer — approving moves
 * that tag — so it wins when it names something published. Otherwise the
 * immediate semver predecessor, then the highest published version.
 */
export function selectAtpmBaseline(
  published: AtpmPackage,
  details: { version: string; tag: string | null },
): { entry: AtpmVersion | null; info: BaselineInfo } {
  const byVersion = new Map(published.versions.map((entry) => [entry.version, entry]));
  const distTagVersion = details.tag ? (published.tags[details.tag] ?? null) : null;

  const tagged = distTagVersion ? byVersion.get(distTagVersion) : undefined;
  if (tagged) {
    return {
      entry: tagged,
      info: {
        version: tagged.version,
        tag: details.tag,
        source: "dist-tag",
        distTagVersion,
        reason: `published version behind the ${details.tag} tag this candidate would move`,
      },
    };
  }

  const ordered = [...published.versions].sort((a, b) => compareSemver(b.version, a.version));
  const predecessor = isValidAtpmVersion(details.version)
    ? ordered.find((entry) => compareSemver(entry.version, details.version) < 0)
    : undefined;
  if (predecessor) {
    return {
      entry: predecessor,
      info: {
        version: predecessor.version,
        tag: null,
        source: "semver-predecessor",
        distTagVersion,
        reason: "highest published version below this candidate",
      },
    };
  }

  const highest = ordered[0];
  if (highest) {
    return {
      entry: highest,
      info: {
        version: highest.version,
        tag: null,
        source: "highest-published",
        distTagVersion,
        reason: "highest published version; this candidate does not supersede it",
      },
    };
  }
  return { entry: null, info: noBaseline("package record has no readable published version") };
}

export type { AtpmBroker };

/** Staged artifact plus the digests findings bind to it. */
export type AtpmStagedArtifact = AcquiredArtifact;
export type { AdapterContext };
