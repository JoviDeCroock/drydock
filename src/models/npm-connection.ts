export interface PublicNpmConnection {
  id: string;
  organizationId: string;
  registryUrl: string;
  label: string;
  tokenFingerprint: string;
  tokenLast4: string | null;
  validationStatus: string;
  capabilitiesJson: unknown;
  validatedAt: string | number | Date | null;
  lastUsedAt: string | number | Date | null;
  createdByUserId: string | null;
  createdAt: string | number | Date;
  updatedAt: string | number | Date;
}

export interface NpmCredentialValidation {
  ok: boolean;
  status: "valid" | "invalid";
  capabilities: {
    registryAuth: boolean;
    stagedTarballAccess?: boolean;
    whoami?: string | null;
    registryUrl: string;
    stageId?: string;
    status?: number;
    stagedTarballStatus?: number;
    detail?: string;
    stagedTarballDetail?: string;
  };
}

export async function getNpmConnection(): Promise<PublicNpmConnection | null> {
  const data = await apiFetch<{ connection: PublicNpmConnection | null }>("/api/v1/npm-connection");
  return data.connection;
}

export async function saveNpmConnection(input: {
  token: string;
  label?: string;
  registryUrl?: string;
}): Promise<PublicNpmConnection | null> {
  const data = await apiFetch<{ connection: PublicNpmConnection | null }>("/api/v1/npm-connection", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });
  return data.connection;
}

export async function validateNpmConnection(stageId?: string): Promise<{
  validation: NpmCredentialValidation;
  connection: PublicNpmConnection | null;
}> {
  return apiFetch("/api/v1/npm-connection/validate", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ stageId: stageId?.trim() || undefined }),
  });
}

export async function deleteNpmConnection(): Promise<void> {
  await apiFetch<{ ok: boolean }>("/api/v1/npm-connection", { method: "DELETE" });
}

async function apiFetch<T>(input: RequestInfo | URL, init?: RequestInit): Promise<T> {
  const res = await fetch(input, {
    credentials: "same-origin",
    headers: { accept: "application/json", ...init?.headers },
    ...init,
  });
  const data = (await res.json().catch(() => null)) as (Partial<T> & { error?: string; detail?: string }) | null;
  if (!res.ok) {
    if (res.status === 401) throw new Error("Please sign in to continue.");
    const detail = typeof data?.detail === "string" ? `: ${data.detail}` : "";
    throw new Error(`${data?.error || "request failed"}${detail}`);
  }
  return data as T;
}
