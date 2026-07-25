declare global {
  namespace Cloudflare {
    interface Env {
      AI: Ai;
      ASSETS?: Fetcher;
      AI_CACHE_AFFINITY?: string;
      LOADER: WorkerLoader;
      DB: D1Database;
      ARTIFACTS?: R2Bucket;
      SCAN_ARTIFACT_READS_DISABLED?: string;
      COMPARE_CACHE?: KVNamespace;
      // Aggregate product counters. Optional: every call site is a no-op
      // without it, so local dev, tests, and self-hosted deployments that omit
      // the binding behave exactly as before. See
      // server/lib/platform/analytics.ts.
      PRODUCT_ANALYTICS?: AnalyticsEngineDataset;
      SCAN_QUEUE?: Queue<import("./lib/scan/job").QueueMessage>;
      NPM_REGISTRY: string;
      ALLOW_INSECURE_LOCAL_REGISTRY?: string;
      // `.dev.vars`-only escape hatch (see securityHeadersDisabled). Never set in
      // any deployed config — production must keep the full header policy.
      DISABLE_SECURITY_HEADERS?: string;
      NPM_CONNECTIONS_ENCRYPTION_KEY?: string;
      BETTER_AUTH_SECRET: string;
      BETTER_AUTH_URL?: string;
      AUTH_REQUIRED?: string;
      FLAGS?: Flagship;
      SEND_EMAIL?: SendEmailBinding;
      EMAIL_FROM_ADDRESS?: string;
      EMAIL_FROM_NAME?: string;
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
