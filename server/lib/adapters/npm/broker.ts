import { WorkerEntrypoint } from "cloudflare:workers";
import { createDb, getNpmConnection, type AppDb } from "../../../db";
import { allowInsecureLocalRegistry, decryptNpmToken } from "../../npm-connection";
import { fetchPackageMetadata, type RegistryMetadata } from "../../registry";
import {
  downloadInSandbox,
  sandboxErrorDetail,
  type DownloadOptions,
  type DownloadResult,
} from "../../sandbox";
import { fetchStagedPublishDetails, type StagedPublishDetails } from "../../staged-publishes";
import type { AdapterBroker, AdapterContext, AdapterConnectionRef } from "../types";

export interface NpmBroker extends AdapterBroker {
  fetchPackageMetadata(name: string): Promise<RegistryMetadata | null>;
  fetchStagedDetails(stageId: string): Promise<StagedPublishDetails | null>;
  downloadStaged(stageId: string, opts: NpmBrokerDownloadOptions): Promise<DownloadResult>;
  downloadPublished(tarballUrl: string, opts: NpmBrokerDownloadOptions): Promise<DownloadResult>;
}

export interface NpmBrokerDownloadOptions {
  maxFiles?: number;
  maxBytesPerFile?: number;
}

export interface NpmBrokerProps {
  organizationId: string;
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
    return fetchPackageMetadata(this.env, name, {
      npmToken: creds.token,
      npmRegistry: creds.registry,
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
    return downloadInSandboxForRpc(this.env, this.ctx, {
      stageId,
      maxFiles: opts.maxFiles,
      maxBytesPerFile: opts.maxBytesPerFile,
      npmToken: creds.token,
      npmRegistry: creds.registry,
    });
  }

  async downloadPublished(
    tarballUrl: string,
    opts: NpmBrokerDownloadOptions,
  ): Promise<DownloadResult> {
    const creds = await this.resolveCredentials();
    return downloadInSandboxForRpc(this.env, this.ctx, {
      tarballUrl,
      maxFiles: opts.maxFiles,
      maxBytesPerFile: opts.maxBytesPerFile,
      npmToken: creds.token,
      npmRegistry: creds.registry,
    });
  }

  private async resolveCredentials(): Promise<ResolvedCredentials> {
    return resolveNpmCredentials(this.env, createDb(this.env.DB), this.ctx.props.organizationId);
  }
}

async function resolveNpmCredentials(
  env: Cloudflare.Env,
  db: AppDb,
  organizationId: string,
): Promise<ResolvedCredentials> {
  const connection = await getNpmConnection(db, organizationId);
  if (!connection) {
    throw new Error("Connect an organization npm token before scanning staged publishes.");
  }
  if (connection.validationStatus !== "valid") {
    throw new Error("Validate the organization npm token before scanning staged publishes.");
  }
  const token = await decryptNpmToken(env, connection);
  return { token, registry: connection.registryUrl };
}

async function downloadInSandboxForRpc(
  env: Cloudflare.Env,
  ctx: ExecutionContext,
  options: DownloadOptions,
): Promise<DownloadResult> {
  try {
    return await downloadInSandbox(env, ctx, options);
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
    return fetchPackageMetadata(this.ctx.env, name, {
      npmToken: creds.token,
      npmRegistry: creds.registry,
    }).catch(() => null);
  }

  async fetchStagedDetails(stageId: string): Promise<StagedPublishDetails | null> {
    const creds = await this.resolve();
    return fetchStagedPublishDetails(creds.registry, creds.token, stageId, {
      allowInsecureLocalhost: allowInsecureLocalRegistry(this.ctx.env),
    }).catch(() => null);
  }

  async downloadStaged(stageId: string, opts: NpmBrokerDownloadOptions): Promise<DownloadResult> {
    return this.download({ stageId, ...opts });
  }

  async downloadPublished(
    tarballUrl: string,
    opts: NpmBrokerDownloadOptions,
  ): Promise<DownloadResult> {
    return this.download({ tarballUrl, ...opts });
  }

  private async download(options: Omit<DownloadOptions, "npmToken" | "npmRegistry">) {
    const creds = await this.resolve();
    return downloadInSandbox(this.ctx.env, this.ctx.executionCtx, {
      ...options,
      npmToken: creds.token,
      npmRegistry: creds.registry,
    });
  }

  private async resolve(): Promise<ResolvedCredentials> {
    return resolveNpmCredentials(this.ctx.env, this.ctx.db, this.props.organizationId);
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
    return factory({ props: { organizationId: ref.organizationId } });
  }
  return new LocalNpmBroker(ctx, { organizationId: ref.organizationId });
}
