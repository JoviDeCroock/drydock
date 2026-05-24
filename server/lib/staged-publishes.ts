import { normalizeRegistryUrl } from "./npm-connection";
import { normalizeStringRecord } from "./tar-parser.js";
import type { PackageJsonSummary } from "./review";

export interface StagedPublishItem {
  id: string;
  packageName: string | null;
  version: string | null;
  tag: string | null;
  access: string | null;
  actor: string | null;
  actorType: string | null;
  createdAt: string | null;
  shasum: string | null;
}

export interface StagedPublishDetails extends StagedPublishItem {
  packageJson: PackageJsonSummary | null;
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
  packageName: string | null;
  version: string | null;
  tag: string | null;
  access: string | null;
  actor: string | null;
  createdAt: string | null;
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
    headers: npmStageHeaders(token, "staged-list"),
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new StagedPublishesFetchError(response.status, detail.slice(0, 200));
  }
  const data = (await response.json().catch(() => null)) as unknown;
  return parseStagedPublishesResponse(data);
}

export async function fetchStagedPublishDetails(
  registryUrl: string,
  token: string,
  stageId: string,
): Promise<StagedPublishDetails> {
  if (!STAGE_ID_RE.test(stageId)) throw new Error("invalid stageId");
  const registry = normalizeRegistryUrl(registryUrl);
  const response = await fetch(`${registry}/-/stage/${encodeURIComponent(stageId)}`, {
    headers: npmStageHeaders(token, "staged-view"),
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new StagedPublishesFetchError(response.status, detail.slice(0, 200));
  }
  const data = (await response.json().catch(() => null)) as unknown;
  logStagedPublishDetailsResponse(stageId, data);
  const parsed = parseStagedPublishDetails(data, stageId);
  if (!parsed) throw new StagedPublishesFetchError(response.status, "invalid staged details");
  return parsed;
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
    const item = parseStagedPublishItem(entry);
    if (item) items.push(item);
  }
  return {
    items,
    total: readNumber(root.total),
    perPage: readNumber(root.perPage),
    page: readNumber(root.page),
  };
}

export function parseStagedPublishDetails(
  data: unknown,
  fallbackId?: string,
): StagedPublishDetails | null {
  const root = isRecord(data) ? data : {};
  const item = parseStagedPublishItem(root, fallbackId);
  if (!item) return null;
  return {
    ...item,
    packageJson: extractPackageJsonSummary(root, item),
  };
}

function parseStagedPublishItem(value: unknown, fallbackId?: string): StagedPublishItem | null {
  if (!isRecord(value)) return null;
  const id = readString(value.id) ?? readString(value.stageId) ?? fallbackId ?? null;
  if (!id || !STAGE_ID_RE.test(id)) return null;
  return {
    id,
    packageName: readString(value.packageName) ?? readString(value.name),
    version: readString(value.version),
    tag: readString(value.tag),
    access: readString(value.access),
    actor: readString(value.actor),
    actorType: readString(value.actorType) ?? readString(value.actor_type),
    createdAt: readString(value.createdAt) ?? readString(value.created_at),
    shasum: readString(value.shasum),
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

function npmStageHeaders(token: string, userAgentSuffix: string) {
  return {
    accept: "application/json",
    authorization: `Bearer ${token}`,
    "user-agent": `staged-publish-review/${userAgentSuffix}`,
  };
}

function logStagedPublishDetailsResponse(stageId: string, data: unknown): void {
  try {
    const json = JSON.stringify({ stageId, response: redactLogValue(data) });
    const maxLength = 12_000;
    console.log(
      "npm staged view response",
      json.length > maxLength ? `${json.slice(0, maxLength)}...[truncated]` : json,
    );
  } catch (err) {
    console.log("npm staged view response unavailable", {
      stageId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

function redactLogValue(value: unknown, depth = 0): unknown {
  if (depth > 8) return "[MaxDepth]";
  if (typeof value === "string") return value.length > 1_000 ? `${value.slice(0, 1_000)}…` : value;
  if (Array.isArray(value)) return value.map((item) => redactLogValue(item, depth + 1));
  if (!isRecord(value)) return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, nested]) => [
      key,
      /token|authorization|password|secret|otp|auth/i.test(key)
        ? "[REDACTED]"
        : redactLogValue(nested, depth + 1),
    ]),
  );
}

function extractPackageJsonSummary(
  root: Record<string, unknown>,
  item: StagedPublishItem,
): PackageJsonSummary | null {
  const byVersion = readVersionManifest(root, item.version);
  const candidates = [
    root.manifest,
    root.packageJson,
    root.package_json,
    root.versionManifest,
    byVersion,
    isRecord(root.metadata) ? readVersionManifest(root.metadata, item.version) : null,
    isRecord(root.packument) ? readVersionManifest(root.packument, item.version) : null,
    root,
  ];

  for (const candidate of candidates) {
    const summary = readPackageJsonSummary(candidate, item.packageName, item.version);
    if (summary) return summary;
  }
  return null;
}

function readVersionManifest(root: Record<string, unknown>, version: string | null) {
  if (!version || !isRecord(root.versions)) return null;
  return root.versions[version];
}

function readPackageJsonSummary(
  value: unknown,
  fallbackName: string | null,
  fallbackVersion: string | null,
): PackageJsonSummary | null {
  if (!isRecord(value)) return null;
  const ownName = readString(value.name) ?? readString(value.packageName);
  const ownVersion = readString(value.version);
  const scripts = normalizeStringRecord(value.scripts);
  const implicitScripts = normalizeStringRecord(value.implicitScripts);
  const dependencies = normalizeStringRecord(value.dependencies);
  const devDependencies = normalizeStringRecord(value.devDependencies);
  const peerDependencies = normalizeStringRecord(value.peerDependencies);
  const optionalDependencies = normalizeStringRecord(value.optionalDependencies);
  const bin = readBin(value.bin);
  const gypfile = typeof value.gypfile === "boolean" ? value.gypfile : undefined;
  const summary: PackageJsonSummary = {
    name: ownName ?? fallbackName ?? undefined,
    version: ownVersion ?? fallbackVersion ?? undefined,
    scripts,
    ...(Object.keys(implicitScripts).length ? { implicitScripts } : {}),
    ...(typeof gypfile === "boolean" ? { gypfile } : {}),
    dependencies,
    devDependencies,
    peerDependencies,
    optionalDependencies,
    ...(bin ? { bin } : {}),
    ...(readString(value.main) ? { main: readString(value.main)! } : {}),
    ...(readString(value.module) ? { module: readString(value.module)! } : {}),
    ...(readString(value.types) ? { types: readString(value.types)! } : {}),
    ...("exports" in value ? { exports: value.exports } : {}),
  };
  const hasPackageData = Boolean(
    Object.keys(scripts).length ||
    Object.keys(dependencies).length ||
    Object.keys(devDependencies).length ||
    Object.keys(peerDependencies).length ||
    Object.keys(optionalDependencies).length ||
    bin ||
    summary.main ||
    summary.module ||
    summary.types ||
    "exports" in summary ||
    typeof summary.gypfile === "boolean",
  );
  return hasPackageData ? summary : null;
}

function readBin(value: unknown): string | Record<string, string> | undefined {
  if (typeof value === "string") return value;
  const bin = normalizeStringRecord(value);
  return Object.keys(bin).length ? bin : undefined;
}
