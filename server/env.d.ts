declare global {
  namespace Cloudflare {
    interface Env {
      AI: Ai;
      AI_MODEL: string;
      LOADER: WorkerLoader;
      DB?: D1Database;
      NPM_REGISTRY: string;
      NPM_TOKEN?: string;
      BETTER_AUTH_SECRET?: string;
      BETTER_AUTH_URL?: string;
      AUTH_REQUIRED?: string;
    }
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
    run(model: string, input: unknown): Promise<{ response?: unknown } | unknown>;
  }
}

export {};
