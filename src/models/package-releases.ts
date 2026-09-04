/**
 * The package release view: one package's review history for the active
 * organization, paged newest first.
 */
import { createModel, signal } from "@preact/signals";
import type { ScanRiskSummary } from "./scan-api";
import type { SettledRegistryStatus } from "../lib/npm-stage-follow-up";
import { packageReleasesApiPath } from "../lib/package-releases-path";
import { activeOrganizationId } from "./active-organization";
import { apiFetch, errorMessage } from "./api";

export interface PackageRelease {
  id: string;
  stageId: string;
  source: string;
  status: string;
  stagedVersion: string | null;
  previousVersion: string | null;
  tag: string | null;
  baseline: {
    version: string | null;
    source: string | null;
    tag: string | null;
    distTagVersion: string | null;
  } | null;
  risk: string;
  riskSummary: ScanRiskSummary | null;
  decision: string | null;
  decisionReason: string | null;
  decidedByUserId: string | null;
  decidedByName: string | null;
  decidedAt: string | number | Date | null;
  registryUrl: string | null;
  registryVersionStatus: string | null;
  registryVersionStatusAt: string | number | Date | null;
  registryReleaseOutcome: SettledRegistryStatus | null;
  registryStatusSupersededAt: string | number | Date | null;
  createdAt: string | number | Date;
  completedAt: string | number | Date | null;
}

export interface PackageReleasesResponse {
  package: { name: string; ecosystem: string };
  summary: {
    totalReviews: number;
    channels: Array<{ tag: string | null; reviews: number }>;
    lastRelease: {
      id: string;
      version: string | null;
      tag: string | null;
      createdAt: string | number | Date;
    } | null;
    publishedWithoutDecision: number;
    publishedDespiteBlock: number;
  };
  releases: PackageRelease[];
  nextCursor: string | null;
  limit: number;
}

function listPackageReleases(
  packageName: string,
  options: { ecosystem?: string | null; cursor?: string | null; limit?: number } = {},
): Promise<PackageReleasesResponse> {
  return apiFetch<PackageReleasesResponse>(packageReleasesApiPath(packageName, options));
}

export const PackageReleasesModel = createModel((packageName: string, ecosystem: string | null) => {
  const loaded = signal(false);
  const loading = signal(false);
  const loadingMore = signal(false);
  const error = signal<string | null>(null);
  const summary = signal<PackageReleasesResponse["summary"] | null>(null);
  const releases = signal<PackageRelease[]>([]);
  const nextCursor = signal<string | null>(null);
  // The response that arrives last is not necessarily the one that was
  // asked for last: an organization switch mid-flight must not land the
  // previous organization's rows in the new one's view.
  let requestId = 0;

  async function load(): Promise<void> {
    const id = ++requestId;
    const organizationId = activeOrganizationId.peek();
    loading.value = true;
    try {
      const data = await listPackageReleases(packageName, { ecosystem });
      if (id !== requestId || organizationId !== activeOrganizationId.peek()) return;
      summary.value = data.summary;
      releases.value = data.releases;
      nextCursor.value = data.nextCursor;
      error.value = null;
    } catch (err) {
      if (id !== requestId) return;
      error.value = errorMessage(err);
    } finally {
      if (id === requestId) {
        loading.value = false;
        loaded.value = true;
      }
    }
  }

  async function loadMore(): Promise<void> {
    const cursor = nextCursor.peek();
    if (!cursor || loadingMore.peek()) return;
    const id = requestId;
    loadingMore.value = true;
    try {
      const data = await listPackageReleases(packageName, { ecosystem, cursor });
      if (id !== requestId) return;
      releases.value = [...releases.peek(), ...data.releases];
      nextCursor.value = data.nextCursor;
      error.value = null;
    } catch (err) {
      if (id !== requestId) return;
      error.value = errorMessage(err);
    } finally {
      if (id === requestId) loadingMore.value = false;
    }
  }

  return { loaded, loading, loadingMore, error, summary, releases, nextCursor, load, loadMore };
});
