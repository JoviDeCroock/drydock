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

/**
 * The caller is authenticated and a member of the organization, but its role
 * does not grant the action. Thrown by `requireOrganizationRole` so a handler
 * states its role predicate once; `app.onError` turns it into the same
 * `{ error: "forbidden" }` 403 the inline checks used to return.
 */
export class ForbiddenError extends Error {
  constructor(message = "forbidden") {
    super(message);
    this.name = "ForbiddenError";
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
