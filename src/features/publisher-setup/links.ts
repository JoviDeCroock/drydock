import type { PublicGithubAppInstallation } from "../../models/github-app";

/** In-app workflow examples for every gated ecosystem. */
export const PUBLISHING_GUIDE_HREF = "/docs#gate-workflow";

function encodePath(value: string) {
  return value.split("/").map(encodeURIComponent).join("/");
}

/**
 * GitHub's new-file editor inside `.github/workflows` on the default branch.
 * A repository without supported workflows may have no such directory, and the
 * editor creates it where a tree link would 404.
 */
export function newWorkflowUrl(repositoryFullName: string, defaultBranch: string) {
  return `https://github.com/${encodePath(repositoryFullName)}/new/${encodePath(defaultBranch)}/.github/workflows`;
}

export function installationSettingsUrl(installation: PublicGithubAppInstallation) {
  const id = encodeURIComponent(installation.installationId);
  return installation.accountType.toLowerCase() === "organization"
    ? `https://github.com/organizations/${encodeURIComponent(installation.accountLogin)}/settings/installations/${id}`
    : `https://github.com/settings/installations/${id}`;
}
