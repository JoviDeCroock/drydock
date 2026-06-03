declare global {
  namespace Cloudflare {
    interface Env {
      AI: Ai;
      AI_CACHE_AFFINITY?: string;
      LOADER: WorkerLoader;
      DB: D1Database;
      COMPARE_CACHE?: KVNamespace;
      SCAN_QUEUE?: Queue<import("./lib/scan-job").QueueMessage>;
      NPM_REGISTRY: string;
      ALLOW_INSECURE_LOCAL_REGISTRY?: string;
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
