export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly detail?: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export async function apiFetch<T>(input: RequestInfo | URL, init?: RequestInit): Promise<T> {
  const res = await fetch(input, {
    credentials: "same-origin",
    headers: { accept: "application/json", ...init?.headers },
    ...init,
  });
  const data = (await res.json().catch(() => null)) as
    | (Partial<T> & { error?: string; detail?: string; message?: string })
    | null;
  if (!res.ok) {
    if (res.status === 401) throw new ApiError("Please sign in to continue.", 401);
    const detail = typeof data?.detail === "string" ? data.detail : undefined;
    const message = data?.message || data?.error || "request failed";
    throw new ApiError(detail ? `${message}: ${detail}` : message, res.status, detail);
  }
  return data as T;
}
