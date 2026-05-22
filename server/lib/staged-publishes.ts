import { normalizeRegistryUrl } from "./npm-connection";

export interface StagedPublishItem {
  id: string;
  packageName: string | null;
  version: string | null;
  tag: string | null;
  access: string | null;
  actor: string | null;
  createdAt: string | null;
}

export interface StagedPublishesPage {
  items: StagedPublishItem[];
  total: number | null;
  perPage: number | null;
  page: number | null;
}

export interface StartedStagedPublishScan {
  id: string;
  stageId: string;
}

export interface StagedPublishesScanResponse {
  found: number;
  created: number;
  skipped: number;
  queued: boolean;
  scans: StartedStagedPublishScan[];
}

const MAX_PER_PAGE = 100;
const STAGE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{5,160}$/;

export interface ListStagedPublishesOptions {
  perPage?: number;
  packageName?: string;
}

export async function listStagedPublishes(
  registryUrl: string,
  token: string,
  options: ListStagedPublishesOptions = {},
): Promise<StagedPublishesPage> {
  const registry = normalizeRegistryUrl(registryUrl);
  const perPage = Math.min(Math.max(options.perPage ?? 25, 1), MAX_PER_PAGE);
  const params = new URLSearchParams({ perPage: String(perPage) });
  if (options.packageName) params.set("package", options.packageName);
  const response = await fetch(`${registry}/-/stage?${params.toString()}`, {
    headers: {
      accept: "application/json",
      authorization: `Bearer ${token}`,
      "user-agent": "staged-publish-review/staged-list",
    },
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new StagedPublishesFetchError(response.status, detail.slice(0, 200));
  }
  const data = (await response.json().catch(() => null)) as unknown;
  return parseStagedPublishesResponse(data);
}

export class StagedPublishesFetchError extends Error {
  constructor(
    readonly status: number,
    readonly detail: string,
  ) {
    super(`staged publishes fetch failed: ${status}`);
    this.name = "StagedPublishesFetchError";
  }
}

export function parseStagedPublishesResponse(data: unknown): StagedPublishesPage {
  const root = isRecord(data) ? data : {};
  const rawItems = Array.isArray(root.items) ? root.items : [];
  const items: StagedPublishItem[] = [];
  for (const entry of rawItems) {
    if (!isRecord(entry)) continue;
    const id = readString(entry.id);
    if (!id || !STAGE_ID_RE.test(id)) continue;
    items.push({
      id,
      packageName: readString(entry.packageName) ?? readString(entry.name),
      version: readString(entry.version),
      tag: readString(entry.tag),
      access: readString(entry.access),
      actor: readString(entry.actor),
      createdAt: readString(entry.createdAt) ?? readString(entry.created_at),
    });
  }
  return {
    items,
    total: readNumber(root.total),
    perPage: readNumber(root.perPage),
    page: readNumber(root.page),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

function readNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}
