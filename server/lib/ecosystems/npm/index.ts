import type { NpmStagedDetails } from "./staged-publishes";
import type { PackageAdapter } from "../package-adapter";
import { acquireBaselineNpm, acquireStagedNpm, type NpmAdapterInput } from "./acquire";
import { createNpmBroker, type NpmBroker } from "./broker";
import { buildNpmFindings } from "./findings";
import { allowInsecureLocalRegistry, decryptNpmToken } from "./connection";
import { checkStagedPublishAccess, fetchStagedPublishDetails } from "./staged-publishes";
import { getNpmConnection } from "../../../db/npm-connections";

const STAGE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{5,160}$/;

export const npmAdapter: PackageAdapter<NpmAdapterInput, NpmBroker> = {
  id: "npm",

  // A staged npm candidate is private registry state; only the publishing
  // organization's token can see it, let alone download it.
  requiresConnection: true,

  parseInput(raw: unknown): NpmAdapterInput {
    if (!raw || typeof raw !== "object") {
      throw new Error("npm adapter input must be an object with a stageId");
    }
    const value = raw as Record<string, unknown>;
    const stageId = typeof value.stageId === "string" ? value.stageId.trim() : "";
    if (!STAGE_ID_RE.test(stageId)) {
      throw new Error("invalid stageId");
    }
    const maxFiles = typeof value.maxFiles === "number" ? value.maxFiles : undefined;
    return { stageId, maxFiles };
  },

  createBroker(ctx, ref) {
    return createNpmBroker(ctx, ref);
  },

  /**
   * Refuse early, and for the actual reason. A missing or unvalidated token, or
   * a token that cannot see this particular staged publish, are three different
   * problems for the maintainer and only one of them is about the release.
   * Doing this before the scan row exists keeps them out of the scan history.
   */
  async preflightStaged(ctx, input, ref) {
    const connection = await getNpmConnection(ctx.db, ref.organizationId);
    if (!connection) {
      return {
        ok: false,
        error: "Connect an organization npm token before scanning staged publishes.",
      };
    }
    if (connection.validationStatus !== "valid") {
      return {
        ok: false,
        error: "Validate the organization npm token before scanning staged publishes.",
      };
    }
    const token = await decryptNpmToken(ctx.env, connection);
    const options = { allowInsecureLocalhost: allowInsecureLocalRegistry(ctx.env) };
    const access = await checkStagedPublishAccess(
      connection.registryUrl,
      token,
      input.stageId,
      options,
    );
    if (!access.allowed) {
      return {
        ok: false,
        error: "This organization's npm token cannot access that staged publish.",
        ...(typeof access.status === "number" ? { status: access.status } : {}),
      };
    }
    const staged = await fetchStagedPublishDetails(
      connection.registryUrl,
      token,
      input.stageId,
      options,
    ).catch(() => null);
    return {
      ok: true,
      label: { packageName: staged?.packageName ?? null, version: staged?.version ?? null },
    };
  },

  acquireStaged(ctx, input, broker) {
    return acquireStagedNpm(ctx, input, broker);
  },

  acquireBaseline(ctx, input, broker, staged) {
    return acquireBaselineNpm(ctx, input, broker, staged);
  },

  runFindings(args) {
    return buildNpmFindings({
      staged: args.staged,
      details: args.details as NpmStagedDetails | null,
      fileDiff: args.fileDiff,
      manifestDiff: args.manifestDiff,
      stagedManifestText: args.stagedManifestText,
    });
  },

  describe({ staged, details, previous }) {
    const stagedDetails = details as NpmStagedDetails | null;
    return {
      name: staged.manifest?.name ?? null,
      stagedVersion: staged.manifest?.version ?? null,
      stagedTag: stagedDetails?.tag ?? null,
      previousVersion: previous?.manifest?.version ?? null,
    };
  },

  summarizeDetails(details) {
    if (!details) return null;
    const d = details as NpmStagedDetails;
    return {
      id: d.id,
      packageName: d.packageName,
      version: d.version,
      tag: d.tag,
      access: d.access,
      actor: d.actor,
      actorType: d.actorType,
      createdAt: d.createdAt,
      shasum: d.shasum,
      // Byte-verification verdict for the reviewed artifact. Persisted with the
      // report so a reviewer reading "file removed" months later can tell
      // whether the scan proved it was reading the staged bytes.
      artifactIntegrity: d.artifactIntegrity ?? null,
    };
  },
};

export type { NpmAdapterInput, NpmBroker };
export { NpmAdapterBroker } from "./broker";
