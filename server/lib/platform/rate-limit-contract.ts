// Leaf contract shared by the limiter and its D1 fallback, so neither has to
// import the other.
export interface RateLimitInput {
  key: string;
  limit: number;
  windowMs: number;
}

export class RateLimitError extends Error {
  constructor(public retryAfterSeconds: number) {
    super("rate limit exceeded");
    this.name = "RateLimitError";
  }
}

/**
 * Enforces `input` over a fixed window starting at `nowMs` when no native
 * binding can express it. Throws `RateLimitError` when the budget is spent.
 */
export type RateLimitFallback = (
  env: Cloudflare.Env,
  input: RateLimitInput,
  nowMs: number,
) => Promise<void>;
