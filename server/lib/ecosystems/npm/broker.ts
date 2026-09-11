import { WorkerEntrypoint } from "cloudflare:workers";
import { type AppDb, createDb } from "../../../db/client";
import { getNpmConnection } from "../../../db/npm-connections";
import { allowInsecureLocalRegistry, decryptNpmToken } from "./connection";
import { downloadPublishedTarball } from "./published-tarball";
import { fetchPackageMetadataCached } from "./registry-cache";
import { fetchPackageMetadata, type RegistryMetadata } from "./registry";
import { downloadInSandbox, sandboxErrorDetail, type DownloadResult } from "../../sandbox";
import { fetchStagedPublishDetails, type StagedPublishDetails } from "./staged-publishes";
import type { AdapterBroker, AdapterContext, AdapterConnectionRef } from "../package-adapter";

const PUBLIC_DEPENDENCY_REGISTRY = "https://registry.npmjs.org";

export interface NpmBroker extends AdapterBroker {
  fetchPackageMetadata(name: string): Promise<RegistryMetadata | null>;
  fetchStagedDetails(stageId: string): Promise<StagedPublishDetails | null>;
  downloadStaged(stageId: string, opts: NpmBrokerDownloadOptions): Promise<DownloadResult>;
  downloadPublished(tarballUrl: string, opts: NpmBrokerDownloadOptions): Promise<DownloadResult>;
  /**
   * Credential-free packument read for a package this organization did not
   * publish — a dependency a release newly introduces.
   *
   * Deliberately a separate method from {@link NpmBroker.fetchPackageMetadata}
   * rather than a flag on it: the two differ in exactly the property that
   * matters (whether the org's token is attached), and a boolean parameter is
   * the kind of thing a later refactor flips by accident. Production is pinned
   * to the public npm registry; localhost is admitted only by the e2e flag.
   * These reads deliberately bypass metadata caching so a moving range or
   * dist-tag is assessed against the registry's current version snapshot.
   */
  fetchAnonymousPackageMetadata(
    name: string,
    opts?: NpmBrokerAnonymousFetchOptions,
  ): Promise<RegistryMetadata | null>;
  /**
   * Credential-free tarball fetch + credentials-free sandbox parse for a
   * dependency artifact. Same origin policy as the baseline download; no
   * `authorization` header is ever sent.
   */
  downloadAnonymousTarball(
    tarballUrl: string,
    opts: NpmBrokerDownloadOptions,
  ): Promise<DownloadResult>;
  /**
   * Registry origin this broker resolves against, for provenance labelling and
   * for the credential-free reads' origin policy. Reads the connection row
   * only — it never decrypts the token, so asking which registry to talk to
   * cannot become a reason to hold a credential in scope.
   */
  registryUrl(): Promise<string>;
}

export type NpmPublicDependencyClient = Pick<
  NpmBroker,
  "fetchAnonymousPackageMetadata" | "downloadAnonymousTarball" | "registryUrl"
>;

export interface NpmBrokerDownloadOptions {
  maxFiles?: number;
  maxBytes?: number;
  /** Remaining dependency-review deadline, enforced inside the broker. */
  timeoutMs?: number;
  /**
   * Per-file text-sample cap the sandbox applies before the parsed files cross
   * the wire. Only the baseline download sets it (see
   * BASELINE_TEXT_SAMPLE_LIMIT); the staged side is always unbounded.
   */
  maxTextSampleChars?: number;
}

interface NpmBrokerAnonymousFetchOptions {
  /** Remaining dependency-review deadline, enforced inside the broker. */
  timeoutMs?: number;
}

interface NpmBrokerProps {
  organizationId: string;
  registryUrl?: string | null;
}

interface ResolvedCredentials {
  token: string;
  registry: string;
}

function createNpmRegistryUrlSnapshot(resolve: () => Promise<string>): () => Promise<string> {
  let snapshot: Promise<string> | undefined;
  return () => (snapshot ??= resolve());
}

// Same-script WorkerEntrypoint. The pipeline asks for a broker through the
// npm adapter; in the deployed Worker the call is routed via
// `ctx.exports.NpmAdapterBroker({ props: { organizationId } })`, which means
// the decrypted npm token only exists inside this class's method-local scope.
// The orchestrator never sees it.
export class NpmAdapterBroker extends WorkerEntrypoint<Cloudflare.Env, NpmBrokerProps> {
  private readonly registryUrlSnapshot = createNpmRegistryUrlSnapshot(() =>
    resolveNpmRegistryUrl(createDb(this.env.DB), this.ctx.props.organizationId),
  );

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

  async fetchAnonymousPackageMetadata(
    name: string,
    opts?: NpmBrokerAnonymousFetchOptions,
  ): Promise<RegistryMetadata | null> {
    const signal = timeoutSignal(opts?.timeoutMs);
    const registry = await this.registryUrl();
    return fetchAnonymousPackageMetadata(this.env, registry, name, signal);
  }

  async downloadAnonymousTarball(
    tarballUrl: string,
    opts: NpmBrokerDownloadOptions,
  ): Promise<DownloadResult> {
    const signal = timeoutSignal(opts.timeoutMs);
    const registry = await this.registryUrl();
    return runRpcSafe(() =>
      downloadAnonymousTarball(this.env, this.ctx, registry, tarballUrl, opts, signal),
    );
  }

  async registryUrl(): Promise<string> {
    if (!allowInsecureLocalRegistry(this.env)) return PUBLIC_DEPENDENCY_REGISTRY;
    return publicDependencyRegistry(
      this.env,
      this.ctx.props.registryUrl ?? (await this.registryUrlSnapshot()),
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
}

/**
 * Shared credential-free reads used by both broker implementations.
 *
 * `registry` is passed in rather than read from a credential so it is obvious
 * at the call site that the token was not: these helpers take no token
 * parameter at all, which is the property the dependency-artifact path relies
 * on (see `dependency-artifacts.ts`).
 */
async function fetchAnonymousPackageMetadata(
  env: Cloudflare.Env,
  registry: string,
  name: string,
  signal?: AbortSignal,
): Promise<RegistryMetadata | null> {
  return fetchPackageMetadata(env, name, {
    npmRegistry: registry,
    abbreviated: true,
    signal,
  }).catch(() => null);
}

async function downloadAnonymousTarball(
  env: Cloudflare.Env,
  ctx: ExecutionContext,
  registry: string,
  tarballUrl: string,
  opts: NpmBrokerDownloadOptions,
  signal?: AbortSignal,
): Promise<DownloadResult> {
  return downloadPublishedTarball(env, ctx, tarballUrl, {
    registryUrl: registry,
    allowInsecureLocalhost: allowInsecureLocalRegistry(env),
    maxFiles: opts.maxFiles,
    maxBytes: opts.maxBytes,
    maxTextSampleChars: opts.maxTextSampleChars,
    signal,
    // Custom registries may mutate version-pinned URLs. Dependency evidence
    // must bind to the registry's current metadata snapshot and bytes, never a
    // seven-day shared cache entry left by an earlier review.
    cacheMode: "bypass",
    // SHA-512 matches the SRI npm publishes as `dist.integrity`, so the digest
    // Drydock recomputes is directly comparable to the one the registry
    // advertised. SHA-1 rides along for versions old enough to carry only
    // `dist.shasum`.
    archiveDigestAlgorithms: ["SHA-256", "SHA-512", "SHA-1"],
  });
}

function timeoutSignal(timeoutMs: number | undefined): AbortSignal | undefined {
  return timeoutMs === undefined
    ? undefined
    : AbortSignal.timeout(Math.max(1, Math.ceil(timeoutMs)));
}

/** Resolve the configured origin only for the explicitly enabled local-test registry path. */
async function resolveNpmRegistryUrl(db: AppDb, organizationId: string): Promise<string> {
  const connection = await getNpmConnection(db, organizationId);
  if (!connection) {
    throw new Error("Connect an organization npm token before scanning staged publishes.");
  }
  if (connection.validationStatus !== "valid") {
    throw new Error("Validate the organization npm token before scanning staged publishes.");
  }
  return connection.registryUrl;
}

async function resolveNpmCredentials(
  env: Cloudflare.Env,
  db: AppDb,
  organizationId: string,
  expectedRegistryUrl?: string | null,
): Promise<ResolvedCredentials> {
  const connection = await getNpmConnection(db, organizationId);
  if (!connection) {
    throw new Error("Connect an organization npm token before scanning staged publishes.");
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
  private readonly registryUrlSnapshot = createNpmRegistryUrlSnapshot(() =>
    resolveNpmRegistryUrl(this.ctx.db, this.props.organizationId),
  );

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

  async fetchAnonymousPackageMetadata(
    name: string,
    opts?: NpmBrokerAnonymousFetchOptions,
  ): Promise<RegistryMetadata | null> {
    const signal = timeoutSignal(opts?.timeoutMs);
    const registry = await this.registryUrl();
    return fetchAnonymousPackageMetadata(this.ctx.env, registry, name, signal);
  }

  async downloadAnonymousTarball(
    tarballUrl: string,
    opts: NpmBrokerDownloadOptions,
  ): Promise<DownloadResult> {
    const signal = timeoutSignal(opts.timeoutMs);
    const registry = await this.registryUrl();
    return downloadAnonymousTarball(
      this.ctx.env,
      this.ctx.executionCtx,
      registry,
      tarballUrl,
      opts,
      signal,
    );
  }

  async registryUrl(): Promise<string> {
    if (!allowInsecureLocalRegistry(this.ctx.env)) return PUBLIC_DEPENDENCY_REGISTRY;
    return publicDependencyRegistry(
      this.ctx.env,
      this.props.registryUrl ?? (await this.registryUrlSnapshot()),
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
}

function publicDependencyRegistry(env: Cloudflare.Env, configured: string): string {
  if (allowInsecureLocalRegistry(env)) {
    try {
      const url = new URL(configured);
      if (
        url.hostname === "127.0.0.1" ||
        url.hostname === "localhost" ||
        url.hostname === "::1" ||
        url.hostname === "[::1]"
      ) {
        return configured;
      }
    } catch {
      // The connection validator owns malformed configured URLs. The
      // credential-free dependency path still stays pinned to npm public.
    }
  }
  return PUBLIC_DEPENDENCY_REGISTRY;
}

/** Credential-free public npm client used by dependency inspection. */
export function createPublicNpmDependencyClient(ctx: AdapterContext): NpmPublicDependencyClient {
  const registry = publicDependencyRegistry(ctx.env, ctx.env.NPM_REGISTRY);
  return {
    registryUrl: async () => registry,
    fetchAnonymousPackageMetadata: (name, opts) =>
      fetchAnonymousPackageMetadata(ctx.env, registry, name, timeoutSignal(opts?.timeoutMs)),
    downloadAnonymousTarball: (tarballUrl, opts) =>
      runRpcSafe(() =>
        downloadAnonymousTarball(
          ctx.env,
          ctx.executionCtx,
          registry,
          tarballUrl,
          opts,
          timeoutSignal(opts.timeoutMs),
        ),
      ),
  };
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
