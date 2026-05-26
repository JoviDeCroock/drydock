import { ACTIVE_ORG_HEADER, activeOrganizationId } from "./active-organization";

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly detail?: string,
    readonly code?: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export async function apiFetch<T>(input: RequestInfo | URL, init?: RequestInit): Promise<T> {
  const headers: Record<string, string> = {
    accept: "application/json",
    ...(init?.headers as Record<string, string> | undefined),
  };
  const orgId = activeOrganizationId.peek();
  if (orgId) headers[ACTIVE_ORG_HEADER] = orgId;
  const res = await fetch(input, {
    credentials: "same-origin",
    ...init,
    headers,
  });
  const data = (await res.json().catch(() => null)) as
    | (Partial<T> & { error?: string; detail?: string; message?: string; code?: string })
    | null;
  if (!res.ok) {
    if (res.status === 401) throw new ApiError("Please sign in to continue.", 401);
    const detail = typeof data?.detail === "string" ? data.detail : undefined;
    const code = typeof data?.code === "string" ? data.code : undefined;
    const message = data?.message || data?.error || "request failed";
    throw new ApiError(detail ? `${message}: ${detail}` : message, res.status, detail, code);
  }
  return data as T;
}

export function apiJson<T>(
  input: RequestInfo | URL,
  body: unknown,
  init: RequestInit = {},
): Promise<T> {
  return apiFetch<T>(input, {
    method: init.method ?? "POST",
    ...init,
    headers: {
      "content-type": "application/json",
      ...(init.headers as Record<string, string> | undefined),
    },
    body: JSON.stringify(body),
  });
}

export function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (err && typeof err === "object") {
    const message = (err as Record<string, unknown>).message;
    if (typeof message === "string") return message;
  }
  return String(err);
}
