import { isRecord } from "../../platform/guards";
import { errorMessage } from "../../platform/errors";
import { normalizeRegistryUrl, type NormalizeRegistryUrlOptions } from "./connection";
import { reliableFetch } from "../../platform/reliable-fetch";
import { normalizePeerDependenciesMeta, normalizeStringRecord } from "../../tar-parser.js";
import type { PackageJsonSummary } from "../../review";
import type { StagedArtifactIntegrity } from "../artifact-integrity";
import type { NpmStagePublisher } from "./publisher-identity";
import { isValidStageId } from "./stage-id";

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

/**
 * Staged metadata as the npm adapter carries it through a scan: the registry's
 * own stage record plus the byte-verification verdict computed for it. Only
 * the adapter reads this shape — the pipeline treats staged details as opaque.
 */
export interface NpmStagedDetails extends StagedPublishDetails {
  artifactIntegrity: StagedArtifactIntegrity;
  publisher: NpmStagePublisher;
}

export interface StagedPublishesPage {
  items: StagedPublishItem[];
  total: number | null;
  perPage: number | null;
  page: number | null;
}

export interface StagedPublishAccessResult {
  allowed: boolean;
  status: number | null;
  detail: string | null;
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

export interface ListStagedPublishesOptions extends NormalizeRegistryUrlOptions {
  perPage?: number;
  page?: number;
  packageName?: string;
}

export async function listStagedPublishes(
  registryUrl: string,
  token: string,
  options: ListStagedPublishesOptions = {},
): Promise<StagedPublishesPage> {
  const registry = normalizeRegistryUrl(registryUrl, options);
  const perPage = Math.min(Math.max(options.perPage ?? 25, 1), MAX_PER_PAGE);
  const params = new URLSearchParams({ perPage: String(perPage) });
  if (typeof options.page === "number" && Number.isFinite(options.page)) {
    params.set("page", String(Math.max(0, Math.floor(options.page))));
  }
  if (options.packageName) params.set("package", options.packageName);
  let response: Response;
  try {
    response = await reliableFetch(`${registry}/-/stage?${params.toString()}`, {
      headers: npmStageHeaders(token, "staged-list"),
    });
  } catch (err) {
    throw new StagedPublishesFetchError(0, errorMessage(err));
  }
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
  options: NormalizeRegistryUrlOptions = {},
): Promise<StagedPublishDetails> {
  if (!isValidStageId(stageId)) throw new Error("invalid stageId");
  const registry = normalizeRegistryUrl(registryUrl, options);
  let response: Response;
  try {
    response = await reliableFetch(`${registry}/-/stage/${encodeURIComponent(stageId)}`, {
      headers: npmStageHeaders(token, "staged-view"),
    });
  } catch (err) {
    throw new StagedPublishesFetchError(0, errorMessage(err));
  }
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new StagedPublishesFetchError(response.status, detail.slice(0, 200));
  }
  const data = (await response.json().catch(() => null)) as unknown;
  const parsed = parseStagedPublishDetails(data, stageId);
  if (!parsed) throw new StagedPublishesFetchError(response.status, "invalid staged details");
  return parsed;
}

export async function checkStagedPublishAccess(
  registryUrl: string,
  token: string,
  stageId: string,
  options: NormalizeRegistryUrlOptions = {},
): Promise<StagedPublishAccessResult> {
  if (!isValidStageId(stageId)) throw new Error("invalid stageId");
  const registry = normalizeRegistryUrl(registryUrl, options);
  const response = await reliableFetch(
    `${registry}/-/stage/${encodeURIComponent(stageId)}/tarball`,
    {
      headers: npmStageTarballHeaders(token),
    },
  ).catch(() => null);
  if (!response) return { allowed: true, status: null, detail: null };
  if (response.ok || response.status === 206) {
    await response.body?.cancel();
    return { allowed: true, status: response.status, detail: null };
  }
  if (response.status === 401 || response.status === 403 || response.status === 404) {
    await response.body?.cancel();
    return {
      allowed: false,
      status: response.status,
      detail: response.statusText || null,
    };
  }
  await response.body?.cancel();
  return { allowed: true, status: response.status, detail: null };
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
  const explicitIds = [readString(root.id), readString(root.stageId)].filter(
    (id): id is string => id !== null,
  );
  if (fallbackId && explicitIds.some((id) => id !== fallbackId)) return null;
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
  if (!isValidStageId(id)) return null;
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

function npmStageTarballHeaders(token: string) {
  return {
    accept: "application/octet-stream",
    authorization: `Bearer ${token}`,
    range: "bytes=0-0",
    "user-agent": "staged-publish-review/staged-tarball-access",
  };
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
  const peerDependenciesMeta = normalizePeerDependenciesMeta(value.peerDependenciesMeta);
  const optionalDependencies = normalizeStringRecord(value.optionalDependencies);
  const files = Array.isArray(value.files)
    ? value.files.filter((item): item is string => typeof item === "string")
    : [];
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
    ...(Object.keys(peerDependenciesMeta).length ? { peerDependenciesMeta } : {}),
    optionalDependencies,
    ...(files.length ? { files } : {}),
    ...(bin ? { bin } : {}),
    ...(readString(value.main) ? { main: readString(value.main)! } : {}),
    ...(readString(value.module) ? { module: readString(value.module)! } : {}),
    ...(readString(value.types) ? { types: readString(value.types)! } : {}),
    ...(readString(value.browser) ? { browser: readString(value.browser)! } : {}),
    ...("exports" in value ? { exports: value.exports } : {}),
  };
  const hasPackageData = Boolean(
    Object.keys(scripts).length ||
    Object.keys(dependencies).length ||
    Object.keys(devDependencies).length ||
    Object.keys(peerDependencies).length ||
    Object.keys(peerDependenciesMeta).length ||
    Object.keys(optionalDependencies).length ||
    files.length ||
    bin ||
    summary.main ||
    summary.module ||
    summary.types ||
    summary.browser ||
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
