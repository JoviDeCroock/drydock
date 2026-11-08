import { isRecord } from "../platform/guards";
import { readBoundedJson } from "../platform/bounded-body";
import { reliableFetch } from "../platform/reliable-fetch";
import { githubHeaders } from "./client";
import { generateGithubAppJwt } from "./jwt";
import {
  PublisherSetupError,
  readRegularSetupFile,
  setupDefaultHead,
  validSetupSha,
  validSetupWorkflowPath,
  type SetupGithubClient,
} from "./setup-api";
import type { GithubAppConfig } from "./config";
import type { ProtectionHealthCheck } from "./protection-health-types";

export async function readEnvironmentProtection(
  client: Pick<SetupGithubClient, "request">,
  environment: string,
  appId: string,
) {
  const data = await client.request(`/environments/${encodeURIComponent(environment)}`, {}, true);
  if (data === null)
    return { environmentExists: false, protectionEnabled: false, administratorsCanBypass: null };
  if (!isRecord(data))
    throw new PublisherSetupError(
      "github_unavailable",
      "GitHub returned invalid environment metadata.",
      502,
    );
  const rules = await client.request(
    `/environments/${encodeURIComponent(environment)}/deployment_protection_rules`,
  );
  if (
    !isRecord(rules) ||
    !Array.isArray(rules.custom_deployment_protection_rules) ||
    !Number.isSafeInteger(rules.total_count) ||
    (rules.total_count as number) < 0 ||
    (rules.total_count as number) > rules.custom_deployment_protection_rules.length
  ) {
    throw new PublisherSetupError(
      "github_unavailable",
      "GitHub did not return the complete environment protection configuration.",
      502,
    );
  }
  return {
    environmentExists: true,
    administratorsCanBypass:
      typeof data.can_admins_bypass === "boolean" ? data.can_admins_bypass : null,
    protectionEnabled: rules.custom_deployment_protection_rules.some(
      (rule) =>
        isRecord(rule) &&
        rule.enabled === true &&
        isRecord(rule.app) &&
        String(rule.app.id) === appId,
    ),
  };
}

export async function installationHasAdministrationRead(
  config: GithubAppConfig,
  installationId: string,
): Promise<boolean> {
  const response = await reliableFetch(
    `https://api.github.com/app/installations/${encodeURIComponent(installationId)}`,
    {
      redirect: "manual",
      headers: githubHeaders(await generateGithubAppJwt(config)),
      attempts: 1,
    },
  );
  if (!response.ok) {
    await response.body?.cancel();
    return false;
  }
  const body = await readBoundedJson(response, {
    maxBytes: 40_000,
    deadlineMs: Date.now() + 15_000,
  });
  if (!isRecord(body) || !isRecord(body.permissions)) return false;
  return body.permissions.administration === "read" || body.permissions.administration === "write";
}

const DEPENDENCY_CHECK_NAME = "Drydock dependency review";
function dependencySourceMatches(
  value: unknown,
  appId: string,
  field: "integration_id" | "app_id",
): boolean {
  return (
    isRecord(value) &&
    value.context === DEPENDENCY_CHECK_NAME &&
    typeof value[field] === "number" &&
    Number.isSafeInteger(value[field]) &&
    String(value[field]) === appId
  );
}

/** A configured check is verified only when the source and its bypass policy are readable. */
export async function readDependencyProtection(
  client: Pick<SetupGithubClient, "request">,
  branch: string,
  appId: string,
  administrationReadable: boolean,
): Promise<ProtectionHealthCheck> {
  const result = (
    status: ProtectionHealthCheck["status"],
    detail: string,
  ): ProtectionHealthCheck => ({
    id: "dependency-required-check",
    label: "Required dependency review",
    status,
    detail,
  });
  let rulesKnown = false;
  let bypassFound = false;
  try {
    const rules = await client.request(
      `/rules/branches/${encodeURIComponent(branch)}?per_page=100`,
    );
    if (Array.isArray(rules) && rules.length < 100 && rules.every(isRecord)) {
      rulesKnown = true;
      let detailReads = 0;
      for (const rule of rules) {
        if (rule.type !== "required_status_checks" || !isRecord(rule.parameters)) continue;
        const required = rule.parameters.required_status_checks;
        if (!Array.isArray(required)) {
          rulesKnown = false;
          continue;
        }
        if (!required.some((check) => dependencySourceMatches(check, appId, "integration_id")))
          continue;
        if (!Number.isSafeInteger(rule.ruleset_id) || (rule.ruleset_id as number) <= 0) {
          rulesKnown = false;
          continue;
        }
        if (detailReads++ >= 10) {
          rulesKnown = false;
          break;
        }
        try {
          const detail = await client.request(`/rulesets/${rule.ruleset_id}`);
          if (
            !isRecord(detail) ||
            detail.enforcement !== "active" ||
            !Array.isArray(detail.bypass_actors)
          ) {
            rulesKnown = false;
            continue;
          }
          if (detail.bypass_actors.length === 0)
            return result(
              "passed",
              `The active ruleset requires this Drydock App's check on ${branch}, with no ruleset bypass actors. Other branches and install commands are outside this check.`,
            );
          bypassFound = true;
        } catch {
          rulesKnown = false;
        }
      }
    }
  } catch {
    /* Classic protection can independently establish the requirement. */
  }
  let classicKnown = false;
  if (administrationReadable) {
    try {
      const classic = await client.request(
        `/branches/${encodeURIComponent(branch)}/protection`,
        {},
        true,
      );
      if (classic === null) classicKnown = true;
      else if (isRecord(classic)) {
        const required = classic.required_status_checks;
        const admins = classic.enforce_admins;
        if (required === null) classicKnown = true;
        else if (
          isRecord(required) &&
          Array.isArray(required.checks) &&
          isRecord(admins) &&
          typeof admins.enabled === "boolean"
        ) {
          classicKnown = true;
          if (required.checks.some((check) => dependencySourceMatches(check, appId, "app_id"))) {
            if (admins.enabled)
              return result(
                "passed",
                `Classic branch protection requires this Drydock App's check on ${branch} and enforces it for administrators. Other branches and install commands are outside this check.`,
              );
            bypassFound = true;
          }
        }
      }
    } catch {
      /* Missing access and upstream failure remain unknown evidence. */
    }
  }
  if (rulesKnown && classicKnown)
    return result(
      "failed",
      bypassFound
        ? `The dependency check on ${branch} permits protection bypass. Remove bypass actors or enforce classic protection for administrators.`
        : `No active requirement pinned to this Drydock App was found on ${branch}. Add the required check with Drydock as its source.`,
    );
  return result(
    "unknown",
    `Could not verify the required Drydock check and bypass policy on ${branch}. Classic protection needs an existing Administration read grant; inaccessible or incomplete rules remain unverified.`,
  );
}

export async function readWorkflowContinuity(
  client: SetupGithubClient,
  runId: number | null,
): Promise<ProtectionHealthCheck> {
  const result = (
    status: ProtectionHealthCheck["status"],
    detail: string,
  ): ProtectionHealthCheck => ({
    id: "workflow-continuity",
    label: "Reviewed workflow file",
    status,
    detail,
  });
  if (runId === null)
    return result(
      "unknown",
      "No approved workflow-gated release establishes a release workflow baseline yet. Run a real release through Drydock.",
    );
  try {
    const run = await client.request(`/actions/runs/${runId}`);
    if (
      !isRecord(run) ||
      run.id !== runId ||
      !isRecord(run.repository) ||
      run.repository.id !== client.repository.id ||
      typeof run.path !== "string" ||
      !validSetupWorkflowPath(run.path) ||
      typeof run.head_sha !== "string" ||
      !validSetupSha(run.head_sha)
    )
      return result(
        "unknown",
        "GitHub did not return a supported, repository-bound workflow run for the last approved gated release.",
      );
    const head = await setupDefaultHead(client);
    const reviewed = await readRegularSetupFile(client, run.path, run.head_sha);
    if (!reviewed)
      return result("unknown", "The workflow file from the reviewed release is unavailable.");
    const current = await readRegularSetupFile(client, run.path, head);
    if (!current || current.sha !== reviewed.sha || current.mode !== reviewed.mode)
      return result(
        "failed",
        `${run.path} on ${client.repository.defaultBranch} changed or was removed since the last approved gated release. Review the workflow change; this observation does not establish malicious behavior.`,
      );
    return result(
      "passed",
      `${run.path} on ${client.repository.defaultBranch} matches the last approved gated release's workflow file. Supporting scripts, reusable workflows and alternate publish paths are outside this comparison.`,
    );
  } catch {
    return result(
      "unknown",
      "The reviewed workflow file and current default-branch file could not both be read. Workflow continuity is not verified.",
    );
  }
}
