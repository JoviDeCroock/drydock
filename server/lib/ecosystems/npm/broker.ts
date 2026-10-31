import { WorkerEntrypoint } from "cloudflare:workers";
import { type AppDb, createDb } from "../../../db/client";
import { getNpmConnection } from "../../../db/npm-connections";
import { allowInsecureLocalRegistry, decryptNpmToken } from "./connection";
import { downloadPublishedTarball } from "./published-tarball";
import { fetchPackageMetadataCached, readPackageVersions } from "./registry-cache";
import type { RegistryMetadata } from "./registry";
import { downloadInSandbox, sandboxErrorDetail, type DownloadResult } from "../../sandbox";
import { ScanPreconditionError } from "../../scan/errors";
import { fetchStagedPublishDetails, type StagedPublishDetails } from "./staged-publishes";
import type { AdapterBroker, AdapterContext, AdapterConnectionRef } from "../package-adapter";
import type { PackageVersionsLookup, PackageVersionsReadMode } from "./dependency-readiness";

// SHA-1 binds the review to npm's own stage record (`shasum`); SHA-256 is the
// digest a workflow gate recomputes for the same `.tgz`, so a stage can be
// matched back to the gated review of the same bytes (gate continuity).
const STAGED_ARCHIVE_DIGESTS = ["SHA-1", "SHA-256"] as const;

export interface NpmBroker extends AdapterBroker {
  fetchPackageMetadata(name: string): Promise<RegistryMetadata | null>;
  fetchStagedDetails(stageId: string): Promise<StagedPublishDetails | null>;
  downloadStaged(stageId: string, opts: NpmBrokerDownloadOptions): Promise<DownloadResult>;
  downloadPublished(tarballUrl: string, opts: NpmBrokerDownloadOptions): Promise<DownloadResult>;
  /**
   * Whether the organization's connection can serve credentialed reads for
   * this ref (present, validated, still on the expected registry, token
   * decryptable). Never returns the token.
   */
  connectionStatus(): Promise<NpmConnectionStatus>;
  /** Published versions of a dependency, read with the organization's credential. */
  fetchPackageVersions(
    name: string,
    mode: PackageVersionsReadMode,
  ): Promise<PackageVersionsLookup | null>;
}

type NpmConnectionStatus =
  | { status: "ready"; registryUrl: string }
  | { status: "unavailable"; reason: "missing" | "unvalidated" | "changed" | "credential" };

export interface NpmBrokerDownloadOptions {
  maxFiles?: number;
  /**
   * Per-file text-sample cap the sandbox applies before the parsed files cross
   * the wire. Only the baseline download sets it (see
   * BASELINE_TEXT_SAMPLE_LIMIT); the staged side is always unbounded.
   */
  maxTextSampleChars?: number;
}

interface NpmBrokerProps {
  organizationId: string;
  registryUrl?: string | null;
}

interface ResolvedCredentials {
  token: string;
  registry: string;
}

// Same-script WorkerEntrypoint. The pipeline asks for a broker through the
// npm adapter; in the deployed Worker the call is routed via
// `ctx.exports.NpmAdapterBroker({ props: { organizationId } })`, which means
// the decrypted npm token only exists inside this class's method-local scope.
// The orchestrator never sees it.
export class NpmAdapterBroker extends WorkerEntrypoint<Cloudflare.Env, NpmBrokerProps> {
  dispose(): void {}

  async fetchPackageMetadata(name: string): Promise<RegistryMetadata | null> {
    const creds = await this.resolveCredentials();
    return fetchPackageMetadataCached(this.env, this.ctx, {
      packageName: name,
      registryUrl: creds.registry,
      cacheScope: `org:${this.ctx.props.organizationId}`,
      npmToken: creds.token,
      // The pipeline reads tarball URLs and dist-tags only.
      abbreviated: true,
    }).catch(() => null);
  }

  async fetchStagedDetails(stageId: string): Promise<StagedPublishDetails | null> {
    const creds = await this.resolveCredentials();
    return fetchStagedPublishDetails(creds.registry, creds.token, stageId, {
      allowInsecureLocalhost: allowInsecureLocalRegistry(this.env),
    }).catch(() => null);
  }

  async downloadStaged(stageId: string, opts: NpmBrokerDownloadOptions): Promise<DownloadResult> {
    const creds = await this.resolveCredentials();
    return runRpcSafe(() =>
      downloadInSandbox(this.env, this.ctx, {
        stageId,
        maxFiles: opts.maxFiles,
        npmToken: creds.token,
        npmRegistry: creds.registry,
        tarRootStrip: "strip1",
        archiveDigestAlgorithms: STAGED_ARCHIVE_DIGESTS,
      }),
    );
  }

  async downloadPublished(
    tarballUrl: string,
    opts: NpmBrokerDownloadOptions,
  ): Promise<DownloadResult> {
    const creds = await this.resolveCredentials();
    return runRpcSafe(() =>
      downloadPublishedTarball(this.env, this.ctx, tarballUrl, {
        registryUrl: creds.registry,
        npmToken: creds.token,
        allowInsecureLocalhost: allowInsecureLocalRegistry(this.env),
        maxFiles: opts.maxFiles,
        maxTextSampleChars: opts.maxTextSampleChars,
      }),
    );
  }

  async connectionStatus(): Promise<NpmConnectionStatus> {
    return connectionStatusOf(this.readinessCredentials());
  }

  async fetchPackageVersions(
    name: string,
    mode: PackageVersionsReadMode,
  ): Promise<PackageVersionsLookup | null> {
    return readPackageVersionsWith(
      this.env,
      this.ctx,
      this.ctx.props.organizationId,
      this.readinessCredentials(),
      name,
      mode,
    );
  }

  private async resolveCredentials(): Promise<ResolvedCredentials> {
    return resolveNpmCredentials(
      this.env,
      createDb(this.env.DB),
      this.ctx.props.organizationId,
      this.ctx.props.registryUrl,
    );
  }

  // At most one resolution per broker instance for the readiness reads; an
  // RPC-routed call may still land on a fresh instance and resolve again.
  private readinessCreds?: Promise<ResolvedCredentials>;
  private readinessCredentials(): Promise<ResolvedCredentials> {
    this.readinessCreds ??= this.resolveCredentials();
    return this.readinessCreds;
  }
}

async function connectionStatusOf(
  credentials: Promise<ResolvedCredentials>,
): Promise<NpmConnectionStatus> {
  try {
    const { registry } = await credentials;
    return { status: "ready", registryUrl: registry };
  } catch (err) {
    const code = err instanceof ScanPreconditionError ? err.code : null;
    const reason =
      code === "npm_connection_missing"
        ? "missing"
        : code === "npm_connection_unvalidated"
          ? "unvalidated"
          : code === "npm_connection_changed"
            ? "changed"
            : "credential";
    return { status: "unavailable", reason };
  }
}

async function readPackageVersionsWith(
  env: Cloudflare.Env,
  ctx: ExecutionContext,
  organizationId: string,
  credentials: Promise<ResolvedCredentials>,
  name: string,
  mode: PackageVersionsReadMode,
): Promise<PackageVersionsLookup | null> {
  let creds: ResolvedCredentials;
  try {
    creds = await credentials;
  } catch {
    return mode === "cache" ? null : { status: "error" };
  }
  return readPackageVersions(
    env,
    ctx,
    {
      packageName: name,
      registryUrl: creds.registry,
      // The same partition as the pipeline's own abbreviated reads.
      cacheScope: `org:${organizationId}`,
      npmToken: creds.token,
    },
    mode,
  );
}

async function resolveNpmCredentials(
  env: Cloudflare.Env,
  db: AppDb,
  organizationId: string,
  expectedRegistryUrl?: string | null,
): Promise<ResolvedCredentials> {
  const connection = await getNpmConnection(db, organizationId);
  if (!connection) {
    throw new ScanPreconditionError("npm_connection_missing");
  }
  if (connection.validationStatus !== "valid") {
    throw new ScanPreconditionError("npm_connection_unvalidated");
  }
  if (expectedRegistryUrl && connection.registryUrl !== expectedRegistryUrl) {
    throw new ScanPreconditionError("npm_connection_changed");
  }
  const token = await decryptNpmToken(env, connection);
  return { token, registry: connection.registryUrl };
}

// WorkerEntrypoint RPC re-throws errors as opaque objects, so translate the
// structured SandboxError detail into an RPC-safe Error the orchestrator can
// still recognize via `sandboxErrorDetail`.
async function runRpcSafe<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    const detail = sandboxErrorDetail(err);
    if (detail === null) throw err;
    const rpcSafe = new Error(detail);
    rpcSafe.name = "SandboxError";
    throw rpcSafe;
  }
}

// Local broker used when the Cloudflare runtime is not in play (tests, scripts
// that exercise the pipeline directly). It mirrors the WorkerEntrypoint
// behavior but lets vitest mock the credential resolution and downstream
// fetchers at module boundaries.
class LocalNpmBroker implements NpmBroker {
  constructor(
    private readonly ctx: AdapterContext,
    private readonly props: NpmBrokerProps,
  ) {}

  dispose(): void {}

  async fetchPackageMetadata(name: string): Promise<RegistryMetadata | null> {
    const creds = await this.resolve();
    return fetchPackageMetadataCached(this.ctx.env, this.ctx.executionCtx, {
      packageName: name,
      registryUrl: creds.registry,
      cacheScope: `org:${this.props.organizationId}`,
      npmToken: creds.token,
      abbreviated: true,
    }).catch(() => null);
  }

  async fetchStagedDetails(stageId: string): Promise<StagedPublishDetails | null> {
    const creds = await this.resolve();
    return fetchStagedPublishDetails(creds.registry, creds.token, stageId, {
      allowInsecureLocalhost: allowInsecureLocalRegistry(this.ctx.env),
    }).catch(() => null);
  }

  async downloadStaged(stageId: string, opts: NpmBrokerDownloadOptions): Promise<DownloadResult> {
    const creds = await this.resolve();
    return downloadInSandbox(this.ctx.env, this.ctx.executionCtx, {
      stageId,
      maxFiles: opts.maxFiles,
      npmToken: creds.token,
      npmRegistry: creds.registry,
      tarRootStrip: "strip1",
      archiveDigestAlgorithms: STAGED_ARCHIVE_DIGESTS,
    });
  }

  async downloadPublished(
    tarballUrl: string,
    opts: NpmBrokerDownloadOptions,
  ): Promise<DownloadResult> {
    const creds = await this.resolve();
    return downloadPublishedTarball(this.ctx.env, this.ctx.executionCtx, tarballUrl, {
      registryUrl: creds.registry,
      npmToken: creds.token,
      allowInsecureLocalhost: allowInsecureLocalRegistry(this.ctx.env),
      maxFiles: opts.maxFiles,
      maxTextSampleChars: opts.maxTextSampleChars,
    });
  }

  async connectionStatus(): Promise<NpmConnectionStatus> {
    return connectionStatusOf(this.readinessCredentials());
  }

  async fetchPackageVersions(
    name: string,
    mode: PackageVersionsReadMode,
  ): Promise<PackageVersionsLookup | null> {
    return readPackageVersionsWith(
      this.ctx.env,
      this.ctx.executionCtx,
      this.props.organizationId,
      this.readinessCredentials(),
      name,
      mode,
    );
  }

  private async resolve(): Promise<ResolvedCredentials> {
    return resolveNpmCredentials(
      this.ctx.env,
      this.ctx.db,
      this.props.organizationId,
      this.props.registryUrl,
    );
  }

  private readinessCreds?: Promise<ResolvedCredentials>;
  private readinessCredentials(): Promise<ResolvedCredentials> {
    this.readinessCreds ??= this.resolve();
    return this.readinessCreds;
  }
}

interface CtxWithExports {
  exports?: {
    NpmAdapterBroker?: (options: { props: NpmBrokerProps }) => NpmBroker;
  };
}

export function createNpmBroker(ctx: AdapterContext, ref: AdapterConnectionRef): NpmBroker {
  const ctxExports = (ctx.executionCtx as unknown as CtxWithExports).exports;
  const factory = ctxExports?.NpmAdapterBroker;
  if (factory) {
    return factory({
      props: { organizationId: ref.organizationId, registryUrl: ref.registryUrl },
    });
  }
  return new LocalNpmBroker(ctx, {
    organizationId: ref.organizationId,
    registryUrl: ref.registryUrl,
  });
}
