import { and, eq } from "drizzle-orm";
import { type AppDb } from "../../db/client";
import { githubAppInstallations, githubReleaseTargets } from "../../db/schema";
import type { InstallationRecord, ReleaseTargetRecord } from "../github-app/persistence";
import type { GithubOidcClaims } from "./oidc";

export type CiRepositoryResolutionError =
  | "repository_not_linked"
  | "repository_ambiguous"
  | "installation_inactive";

export interface ResolvedCiRepository {
  organizationId: string;
  installation: InstallationRecord;
  /** Every release target the organization has mapped for this repository. */
  releaseTargets: ReleaseTargetRecord[];
}

export class CiRepositoryError extends Error {
  constructor(
    public code: CiRepositoryResolutionError,
    message: string,
  ) {
    super(message);
    this.name = "CiRepositoryError";
  }
}

/**
 * Resolve which organization an OIDC-authenticated upload belongs to.
 *
 * The token proves "I am run N of repository R". It does not say which Drydock
 * organization should review R — that mapping is the maintainer's deliberate
 * act of installing the App and creating a release target. So we look the
 * repository up through existing release targets and require exactly one
 * organization to claim it.
 *
 * Failing closed on ambiguity matters: if two organizations both mapped the
 * same repository id, silently picking one would route a private release into
 * the wrong tenant's workbench. There is no safe default, so we refuse and make
 * a human resolve it.
 *
 * Matching on `repository_id` rather than `repository` is deliberate — GitHub
 * frees a repository *name* the moment it is renamed, but never reissues the
 * numeric id.
 */
export async function resolveCiRepository(
  db: AppDb,
  claims: Pick<GithubOidcClaims, "repositoryId" | "repository">,
): Promise<ResolvedCiRepository> {
  const rows = await db
    .select({
      target: githubReleaseTargets,
      installation: githubAppInstallations,
    })
    .from(githubReleaseTargets)
    .innerJoin(
      githubAppInstallations,
      and(
        eq(githubReleaseTargets.installationRowId, githubAppInstallations.id),
        eq(githubReleaseTargets.organizationId, githubAppInstallations.organizationId),
      ),
    )
    .where(eq(githubReleaseTargets.repositoryId, claims.repositoryId));

  if (rows.length === 0) {
    throw new CiRepositoryError(
      "repository_not_linked",
      `${claims.repository} has no Drydock release target; add one in Settings before uploading`,
    );
  }

  const organizationIds = new Set(rows.map((row) => row.target.organizationId));
  if (organizationIds.size > 1) {
    throw new CiRepositoryError(
      "repository_ambiguous",
      `${claims.repository} is mapped by more than one organization; remove the duplicate release target`,
    );
  }

  const active = rows.filter((row) => row.installation.status === "active");
  if (active.length === 0) {
    throw new CiRepositoryError(
      "installation_inactive",
      `the GitHub App installation for ${claims.repository} is not active`,
    );
  }

  const installationRow = active[0].installation;
  return {
    organizationId: installationRow.organizationId,
    installation: readInstallation(installationRow),
    releaseTargets: active.map((row) => readReleaseTarget(row.target)),
  };
}

/**
 * The ecosystem an uploaded release set should be reviewed as, when the caller
 * did not pin one.
 *
 * A repository whose every release target pins the same ecosystem almost
 * certainly publishes only that ecosystem, so inheriting it keeps the pinned
 * (more precise) classifier. Any disagreement — or any target that already
 * auto-detects — falls back to auto-detection, which is also the right answer
 * for a monorepo that publishes to several registries from one run.
 */
export function inferReleaseSetEcosystem(targets: ReleaseTargetRecord[]): string | null {
  if (targets.length === 0) return null;
  const first = targets[0].ecosystem;
  if (first === null) return null;
  return targets.every((target) => target.ecosystem === first) ? first : null;
}

function readInstallation(row: typeof githubAppInstallations.$inferSelect): InstallationRecord {
  return {
    id: row.id,
    organizationId: row.organizationId,
    installationId: row.installationId,
    accountLogin: row.accountLogin,
    accountType: row.accountType,
    targetType: row.targetType,
    status:
      row.status === "suspended" || row.status === "uninstalled" || row.status === "active"
        ? row.status
        : "active",
    installedAt: new Date(row.installedAt),
    createdAt: new Date(row.createdAt),
    updatedAt: new Date(row.updatedAt),
  };
}

function readReleaseTarget(row: typeof githubReleaseTargets.$inferSelect): ReleaseTargetRecord {
  return {
    id: row.id,
    organizationId: row.organizationId,
    installationRowId: row.installationRowId,
    ecosystem: row.ecosystem as ReleaseTargetRecord["ecosystem"],
    artifactName: row.artifactName,
    repositoryId: row.repositoryId,
    repositoryFullName: row.repositoryFullName,
    environment: row.environment,
    createdAt: new Date(row.createdAt),
    updatedAt: new Date(row.updatedAt),
  };
}
