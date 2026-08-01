/**
 * The request carried a structurally valid session for a principal that no
 * longer exists (or may no longer act). Thrown from deep helpers that discover
 * this while doing their own work; `app.onError` turns it into a 401 so no
 * caller has to thread a nullable identity through its return type.
 */
export class UnauthorizedError extends Error {
  constructor(message = "unauthorized") {
    super(message);
    this.name = "UnauthorizedError";
  }
}

export function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (err && typeof err === "object") {
    const message = (err as Record<string, unknown>).message;
    if (typeof message === "string") return message;
  }
  return String(err);
}
