/**
 * Published-pair reviews: the authenticated scan pipeline over two releases
 * that are already public.
 *
 * An organization gets nothing out of Drydock until npm emits a staged publish,
 * which is an external event nobody in the product can trigger. This capability
 * removes that wait: the same pipeline — deterministic rules, AI review,
 * release memory, persistence, decisions, share links — runs over a published
 * `package@version` and its predecessor.
 *
 * Acquisition is the ecosystem's existing `publicDiff` capability, so this adds
 * no egress: the same public registry brokers `/diff` already uses, with no
 * credential resolved, attached, or reachable on this path. An organization's
 * npm token is neither required nor consulted.
 */
import type {
  AcquiredArtifact,
  AdapterBroker,
  AdapterContext,
  BaselineInfo,
  PackageAdapter,
  StagedDetails,
} from "./package-adapter";
import type { Finding } from "../review";
import type { PublicDiffAcquiredSources, PublicDiffAdapter } from "../public-diff/types";

/** A resolved published pair. Every field is registry-confirmed before it is queued. */
export interface PublishedPairRef {
  ecosystem: string;
  packageName: string;
  version: string;
  baselineVersion: string;
}

export type PublishedPairResolution =
  | { ok: true; pair: PublishedPairRef }
  | { ok: false; error: string; status: 400 | 404 };

export interface PublishedPairAdapter extends PackageAdapter<
  PublishedPairRef,
  PublishedPairBroker
> {
  /**
   * Confirm the requested release exists and choose the version it is compared
   * against, before a scan row is created. Callers resolve first so the queued
   * message names an exact pair and a failed lookup is a request error rather
   * than a scan that fails minutes later.
   */
  resolvePair(
    env: Cloudflare.Env,
    executionCtx: ExecutionContext,
    request: { packageName: string; version: string; baselineVersion?: string | null },
  ): Promise<PublishedPairResolution>;
}

/**
 * Both package sides plus the ecosystem's finding builder, acquired once.
 *
 * `PublicDiffAdapter.acquire` returns both versions together while
 * `PackageAdapter` asks for them in two calls, so the staged call acquires and
 * the baseline call reads what it left here.
 */
class PublishedPairBroker implements AdapterBroker {
  sources: PublicDiffAcquiredSources | null = null;

  constructor(readonly diff: PublicDiffAdapter) {}

  dispose(): void {
    this.sources = null;
  }
}

interface PublishedPairDetails extends PublishedPairRef {
  registryUrl: string;
  notices: string[];
  // Carried on the details object because `runFindings` is handed no broker,
  // and the builder closes over the acquired artifacts. `summarizeDetails`
  // deliberately does not return it — only its own fields are persisted.
  buildFindings: PublicDiffAcquiredSources["buildFindings"];
}

export function publishedPairAdapter(diff: PublicDiffAdapter): PublishedPairAdapter {
  return {
    id: diff.ecosystem,
    codePatternSet: diff.codePatternSet,

    parseInput(raw: unknown): PublishedPairRef {
      const value = (raw ?? {}) as Record<string, unknown>;
      const packageName = typeof value.packageName === "string" ? value.packageName : "";
      const version = typeof value.version === "string" ? value.version : "";
      const baselineVersion =
        typeof value.baselineVersion === "string" ? value.baselineVersion : "";
      if (!diff.isValidPackageName(packageName)) throw new Error("invalid package name");
      if (!isPlainVersion(diff, version) || !isPlainVersion(diff, baselineVersion)) {
        throw new Error("invalid version");
      }
      return { ecosystem: diff.ecosystem, packageName, version, baselineVersion };
    },

    createBroker() {
      return new PublishedPairBroker(diff);
    },

    async resolvePair(env, executionCtx, request) {
      const packageName = diff.normalizePackageName(request.packageName.trim());
      const version = request.version.trim();
      const requested = request.baselineVersion?.trim() || null;
      if (!diff.isValidPackageName(packageName)) {
        return { ok: false, error: "invalid package name", status: 400 };
      }
      if (!isPlainVersion(diff, version)) {
        return { ok: false, error: "invalid version", status: 400 };
      }
      if (requested !== null && !isPlainVersion(diff, requested)) {
        return { ok: false, error: "invalid baseline version", status: 400 };
      }

      const listing = await diff.listVersions(env, executionCtx, packageName);
      const index = listing.versions.findIndex((entry) => entry.version === version);
      if (index < 0) {
        return { ok: false, error: "that version is not published", status: 404 };
      }
      if (requested !== null && !listing.versions.some((entry) => entry.version === requested)) {
        return { ok: false, error: "that baseline version is not published", status: 404 };
      }
      // Listings are newest-first in every ecosystem that implements them, so
      // the next entry is the release this one shipped on top of.
      const baselineVersion = requested ?? listing.versions[index + 1]?.version ?? null;
      if (!baselineVersion) {
        return {
          ok: false,
          error: "This package needs at least two published versions to review.",
          status: 400,
        };
      }
      return {
        ok: true,
        pair: {
          ecosystem: diff.ecosystem,
          packageName: listing.packageName,
          version,
          baselineVersion,
        },
      };
    },

    async acquireStaged(
      ctx: AdapterContext,
      input: PublishedPairRef,
      broker: PublishedPairBroker,
    ): Promise<{ artifact: AcquiredArtifact; details: StagedDetails }> {
      const sources = await diff.acquire(ctx.env, ctx.executionCtx, {
        ecosystem: diff.ecosystem,
        packageName: input.packageName,
        fromVersion: input.baselineVersion,
        toVersion: input.version,
        registryUrl: diff.registryUrl,
      });
      broker.sources = sources;
      const details: PublishedPairDetails = {
        ...input,
        registryUrl: diff.registryUrl,
        notices: sources.notices ?? [],
        buildFindings: sources.buildFindings,
      };
      return {
        artifact: { files: sources.to.files, manifest: sources.to.packageJson },
        details,
      };
    },

    async acquireBaseline(
      _ctx: AdapterContext,
      input: PublishedPairRef,
      broker: PublishedPairBroker,
    ): Promise<{ artifact: AcquiredArtifact | null; baseline: BaselineInfo }> {
      const sources = broker.sources;
      const baseline: BaselineInfo = {
        version: input.baselineVersion,
        tag: null,
        source: "published-pair",
        distTagVersion: null,
        reason: "published-pair",
      };
      if (!sources) return { artifact: null, baseline: { ...baseline, source: "none" } };
      return {
        artifact: { files: sources.from.files, manifest: sources.from.packageJson },
        baseline,
      };
    },

    runFindings(args): Finding[] {
      const details = args.details as PublishedPairDetails;
      return details.buildFindings(args.fileDiff, args.manifestDiff);
    },

    describe({ details }) {
      const d = details as PublishedPairDetails;
      return {
        // Registry coordinates, not the manifest: the reviewed bytes are
        // hostile evidence and must not rename the release they were fetched as.
        name: d.packageName,
        stagedVersion: d.version,
        stagedTag: null,
        previousVersion: d.baselineVersion,
      };
    },

    summarizeDetails(details) {
      const d = details as PublishedPairDetails | null;
      if (!d) return null;
      return {
        mode: "published_pair",
        ecosystem: d.ecosystem,
        packageName: d.packageName,
        version: d.version,
        baselineVersion: d.baselineVersion,
        registryUrl: d.registryUrl,
        notices: d.notices,
      };
    },
  };
}

/**
 * Stable identity for a published pair, stored in the scan's `stage_id`.
 *
 * A published review has no registry stage record, but the column is the
 * scan's natural key everywhere downstream. The `published:` prefix keeps it
 * out of npm's stage-id shape, so nothing that consumes stage ids can mistake
 * one for the other.
 */
export function publishedPairStageId(pair: PublishedPairRef): string {
  return `published:${pair.ecosystem}:${pair.packageName}@${pair.version}`;
}

/**
 * A published release, excluding the mutable reference forms an ecosystem's
 * public diff also accepts (npm's pkg.pr.new preview URLs). A persisted review
 * names the bytes it reviewed, and a preview ref can be rewritten under it.
 */
const PLAIN_VERSION_RE = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,127}$/;

function isPlainVersion(diff: PublicDiffAdapter, version: string): boolean {
  return PLAIN_VERSION_RE.test(version) && diff.isValidVersion(version);
}
