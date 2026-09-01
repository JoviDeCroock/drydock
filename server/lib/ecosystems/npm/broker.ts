import { WorkerEntrypoint } from "cloudflare:workers";
import { type AppDb, createDb } from "../../../db/client";
import { getNpmConnection } from "../../../db/npm-connections";
import { allowInsecureLocalRegistry, decryptNpmToken } from "./connection";
import { downloadPublishedTarball } from "./published-tarball";
import { fetchPackageMetadataCached } from "./registry-cache";
import type { RegistryMetadata } from "./registry";
import { downloadInSandbox, sandboxErrorDetail, type DownloadResult } from "../../sandbox";
import { fetchStagedPublishDetails, type StagedPublishDetails } from "./staged-publishes";
import type { AdapterBroker, AdapterContext, AdapterConnectionRef } from "../package-adapter";

export interface NpmBroker extends AdapterBroker {
  fetchPackageMetadata(name: string): Promise<RegistryMetadata | null>;
  fetchStagedDetails(stageId: string): Promise<StagedPublishDetails | null>;
  downloadStaged(stageId: string, opts: NpmBrokerDownloadOptions): Promise<DownloadResult>;
  downloadPublished(tarballUrl: string, opts: NpmBrokerDownloadOptions): Promise<DownloadResult>;
}

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
  connectionId?: string;
}

interface ResolvedCredentials {
  token: string;
  registry: string;
}

class NpmConnectionReplacedError extends Error {
  constructor() {
    super("The npm connection was replaced before the staged review completed.");
    this.name = "NpmConnectionReplacedError";
  }
}

// Same-script WorkerEntrypoint. The pipeline asks for a broker through the
// npm adapter; in the deployed Worker the call is routed via
// `ctx.exports.NpmAdapterBroker({ props: { organizationId, connectionId } })`, which means
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

  private async resolveCredentials(): Promise<ResolvedCredentials> {
    return resolveNpmCredentials(
      this.env,
      createDb(this.env.DB),
      this.ctx.props.organizationId,
      this.ctx.props.registryUrl,
      this.ctx.props.connectionId,
    );
  }
}

async function resolveNpmCredentials(
  env: Cloudflare.Env,
  db: AppDb,
  organizationId: string,
  expectedRegistryUrl?: string | null,
  connectionId?: string,
): Promise<ResolvedCredentials> {
  const connection = await getNpmConnection(db, organizationId);
  if (!connection) {
    throw new Error("Connect an organization npm token before scanning staged publishes.");
  }
  if (connectionId && connection.id !== connectionId) {
    throw new NpmConnectionReplacedError();
  }
  if (connection.validationStatus !== "valid") {
    throw new Error("Validate the organization npm token before scanning staged publishes.");
  }
  if (expectedRegistryUrl && connection.registryUrl !== expectedRegistryUrl) {
    throw new Error("The organization npm registry changed after this scan was queued.");
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

  private async resolve(): Promise<ResolvedCredentials> {
    return resolveNpmCredentials(
      this.ctx.env,
      this.ctx.db,
      this.props.organizationId,
      this.props.registryUrl,
      this.props.connectionId,
    );
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
  const props: NpmBrokerProps = {
    organizationId: ref.organizationId,
    registryUrl: ref.registryUrl,
    connectionId: ref.connectionId,
  };
  if (factory) {
    return factory({ props });
  }
  return new LocalNpmBroker(ctx, props);
}
