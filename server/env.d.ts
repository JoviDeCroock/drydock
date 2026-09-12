declare global {
  namespace Cloudflare {
    interface Env {
      AI: Ai;
      ASSETS?: Fetcher;
      AI_CACHE_AFFINITY?: string;
      LOADER: WorkerLoader;
      DB: D1Database;
      ARTIFACTS: R2Bucket;
      SCAN_ARTIFACT_READS_DISABLED?: string;
      COMPARE_CACHE?: KVNamespace;
      // Better Auth session cache. Optional: without it Better Auth reads and
      // writes sessions in D1 only. See server/lib/auth/index.ts.
      AUTH_SESSIONS?: KVNamespace;
      // Native Rate Limiting bindings, one per per-minute limit the app
      // enforces (see NATIVE_TIERS in server/lib/platform/rate-limit.ts and
      // `ratelimits` in wrangler.jsonc). Optional: a deployment without them
      // degrades to the D1 `rate_limits` counter.
      RATE_LIMIT_10_PER_MINUTE?: RateLimit;
      RATE_LIMIT_20_PER_MINUTE?: RateLimit;
      RATE_LIMIT_30_PER_MINUTE?: RateLimit;
      RATE_LIMIT_60_PER_MINUTE?: RateLimit;
      RATE_LIMIT_120_PER_MINUTE?: RateLimit;
      RATE_LIMIT_240_PER_MINUTE?: RateLimit;
      // Aggregate product counters. Optional: every call site is a no-op
      // without it, so local dev, tests, and self-hosted deployments that omit
      // the binding behave exactly as before. See
      // server/lib/platform/analytics.ts.
      PRODUCT_ANALYTICS?: AnalyticsEngineDataset;
      SCAN_QUEUE?: Queue<import("./lib/scan/job").QueueMessage>;
      // Per-organization staged-publish discovery sweeps, produced by the cron
      // tick. Deliberately a separate queue from SCAN_QUEUE so a discovery
      // burst (one message per organization) cannot starve scan execution.
      // Optional: without it the cron falls back to sweeping inline. The Worker
      // test config omits it; pnpm dev uses the binding from wrangler.jsonc.
      DISCOVERY_QUEUE?: Queue<import("./lib/discovery/sweep-queue").DiscoveryQueueMessage>;
      NPM_REGISTRY: string;
      ALLOW_INSECURE_LOCAL_REGISTRY?: string;
      // `.dev.vars`-only escape hatch (see securityHeadersDisabled). Never set in
      // any deployed config — production must keep the full header policy.
      DISABLE_SECURITY_HEADERS?: string;
      NPM_CONNECTIONS_ENCRYPTION_KEY?: string;
      // Ed25519 private JWK (kty OKP) used to sign public report attestations.
      // Absent → attestation endpoints return 503; sharing still works.
      ATTESTATION_SIGNING_KEY_JWK?: string;
      BETTER_AUTH_SECRET: string;
      BETTER_AUTH_URL?: string;
      AUTH_REQUIRED?: string;
      FLAGS?: Flagship;
      SEND_EMAIL?: SendEmailBinding;
      EMAIL_FROM_ADDRESS?: string;
      EMAIL_FROM_NAME?: string;
      // GitHub sign-in (Better Auth social provider). Use a dedicated classic
      // OAuth App so the grant stays identity-only; workflow-gate GitHub App
      // client ids are rejected because their user tokens can carry repository
      // permissions.
      GITHUB_OAUTH_CLIENT_ID?: string;
      GITHUB_OAUTH_CLIENT_SECRET?: string;
      GITHUB_APP_ID?: string;
      GITHUB_APP_SLUG?: string;
      GITHUB_APP_CLIENT_ID?: string;
      GITHUB_APP_CLIENT_SECRET?: string;
      GITHUB_APP_PRIVATE_KEY?: string;
      GITHUB_APP_WEBHOOK_SECRET?: string;
      GITHUB_APP_STATE_SECRET?: string;
      WORKFLOW_GATE_CALLBACK_WINDOW_MS?: string;
      SLACK_CLIENT_ID?: string;
      SLACK_CLIENT_SECRET?: string;
    }
  }

  interface SendEmailBinding {
    send(message: unknown): Promise<void>;
  }

  interface WorkerLoader {
    load(code: {
      compatibilityDate: string;
      mainModule: string;
      modules: Record<string, string>;
      env?: Record<string, unknown>;
      globalOutbound?: Fetcher | null;
      limits?: { cpuMs?: number; subRequests?: number };
    }): {
      getEntrypoint(name?: string | null, options?: unknown): { fetch(request: Request): Promise<Response> };
    };
  }

  interface Ai {
    run(
      model: string,
      input: unknown,
      options?: { extraHeaders?: Record<string, string>; gateway?: { id: string } },
    ): Promise<{ response?: unknown; usage?: unknown } | unknown>;
  }

  interface FlagshipEvaluationContext {
    [key: string]: string | number | boolean | undefined;
  }

  interface Flagship {
    getBooleanValue(
      flagKey: string,
      defaultValue: boolean,
      context?: FlagshipEvaluationContext,
    ): Promise<boolean>;
  }
}

export {};
