import { createDb, type AppDb } from "../../db/client";
import { recordScanEvent } from "../../db/events";
import { dependencyReviewAvailable } from "../dependency-review/flag";
import { getDependencyReviewSettings } from "../../db/dependency-reviews";
import {
  claimProtectionHealth,
  getProtectionHealthRow,
  listProtectionHealthRows,
  latestReviewedWorkflowRun,
  publicProtectionHealth,
  storedProtectionHealthStatus,
  saveProtectionHealth,
  type ProtectionHealthRow,
} from "../../db/protection-health";
import { mapWithConcurrency } from "../platform/concurrency";
import { emitOperationalEvent } from "../platform/observability";
import { readGithubAppConfig } from "./config";
import { createSetupClient } from "./setup-api";
import {
  installationHasAdministrationRead,
  readDependencyProtection,
  readEnvironmentProtection,
  readWorkflowContinuity,
} from "./protection-health";
import {
  protectionHealthStatus,
  type ProtectionHealthCheck,
  type ProtectionHealthSnapshot,
} from "./protection-health-types";

export const PROTECTION_HEALTH_BATCH_LIMIT = 20;
const check = (
  id: string,
  label: string,
  status: ProtectionHealthCheck["status"],
  detail: string,
): ProtectionHealthCheck => ({ id, label, status, detail });
async function collect(
  db: AppDb,
  env: Cloudflare.Env,
  row: ProtectionHealthRow,
): Promise<ProtectionHealthSnapshot> {
  if (row.installation.status !== "active")
    return {
      defaultBranch: null,
      checks: [
        check(
          "installation-active",
          "GitHub App installation",
          "failed",
          `The installation is ${row.installation.status}; restore the App before relying on its controls.`,
        ),
      ],
    };
  const readDeadlineMs = Date.now() + 120_000;
  const config = readGithubAppConfig(env);
  const administrationReadable = await installationHasAdministrationRead(
    config,
    row.installation.installationId,
  );
  const client = await createSetupClient(
    config,
    row.installation.installationId,
    row.target.repositoryFullName,
    false,
    false,
    administrationReadable,
    readDeadlineMs,
  );
  try {
    if (client.repository.id !== row.target.repositoryId)
      throw new Error("repository identity changed");
    const checks: ProtectionHealthCheck[] = [
      check(
        "installation-active",
        "GitHub App installation",
        "passed",
        "The mapped repository is accessible through its active installation.",
      ),
    ];
    try {
      const evidence = await readEnvironmentProtection(
        client,
        row.target.environment,
        config.appId,
      );
      checks.push(
        check(
          "environment-exists",
          "Mapped Environment",
          evidence.environmentExists ? "passed" : "failed",
          evidence.environmentExists
            ? `The mapped Environment ${row.target.environment} exists.`
            : `The mapped Environment ${row.target.environment} was not found.`,
        ),
      );
      checks.push(
        check(
          "protection-rule",
          "Drydock protection rule",
          evidence.protectionEnabled ? "passed" : "failed",
          evidence.protectionEnabled
            ? "This Drydock App's deployment protection rule is enabled on the mapped Environment. Only jobs targeting it are covered."
            : "This Drydock App's protection rule is absent or disabled on the mapped Environment.",
        ),
      );
      checks.push(
        check(
          "administrator-bypass",
          "Environment administrator bypass",
          evidence.administratorsCanBypass === false
            ? "passed"
            : evidence.administratorsCanBypass === true
              ? "failed"
              : "unknown",
          evidence.administratorsCanBypass === false
            ? "Administrator bypass is disabled for this Environment."
            : evidence.administratorsCanBypass === true
              ? "Administrators can bypass this Environment's deployment protection."
              : "GitHub did not report the Environment's administrator bypass setting.",
        ),
      );
    } catch {
      checks.push(
        check(
          "environment-protection",
          "Mapped Environment protection",
          "unknown",
          "The Environment protection configuration could not be read completely. Previous evidence is not a current verification.",
        ),
      );
    }
    checks.push(await readWorkflowContinuity(client, await latestReviewedWorkflowRun(db, row)));
    const settings = await getDependencyReviewSettings(db, row.target.organizationId);
    const dependencyEnabled =
      settings.enabled && (await dependencyReviewAvailable(env, row.target.organizationId));
    checks.push(
      check(
        "dependency-review-enabled",
        "Dependency review",
        dependencyEnabled ? "passed" : "failed",
        dependencyEnabled
          ? "Dependency review is enabled for this organization. The required-check configuration is assessed separately."
          : "Dependency review is disabled for this organization; turn it on and require its check to protect merges.",
      ),
    );
    if (dependencyEnabled)
      checks.push(
        await readDependencyProtection(
          client,
          client.repository.defaultBranch,
          config.appId,
          administrationReadable,
        ),
      );
    return { defaultBranch: client.repository.defaultBranch, checks };
  } finally {
    await client.revokeToken();
  }
}
export async function refreshProtectionHealth(
  db: AppDb,
  env: Cloudflare.Env,
  organizationId: string,
  targetId: string,
) {
  const row = await getProtectionHealthRow(db, organizationId, targetId);
  if (!row) return null;
  const previousStatus = storedProtectionHealthStatus(row);
  const leaseId = await claimProtectionHealth(db, row, new Date());
  if (leaseId) {
    let snapshot: ProtectionHealthSnapshot;
    try {
      snapshot = await collect(db, env, row);
    } catch {
      snapshot = {
        defaultBranch: null,
        checks: [
          check(
            "configuration-read",
            "Protection configuration",
            "unknown",
            "Drydock could not read the current GitHub configuration. Check the App's access and retry.",
          ),
        ],
      };
      emitOperationalEvent("warn", "github_app.protection_health.check_failed", {
        organizationId,
        releaseTargetId: targetId,
      });
    }
    if (await saveProtectionHealth(db, row, leaseId, snapshot, new Date())) {
      const status = protectionHealthStatus(snapshot.checks);
      if (previousStatus !== status) {
        await recordScanEvent(db, {
          organizationId,
          type: "github_app.protection_health.changed",
          metadata: {
            releaseTargetId: targetId,
            repositoryFullName: row.target.repositoryFullName,
            environment: row.target.environment,
            previousStatus,
            status,
          },
        });
        emitOperationalEvent(
          status === "protected" ? "info" : "warn",
          "github_app.protection_health.changed",
          { organizationId, releaseTargetId: targetId, previousStatus, status },
        );
      }
    }
  }
  const latest = await getProtectionHealthRow(db, organizationId, targetId);
  return latest ? publicProtectionHealth(latest) : null;
}
export async function sweepProtectionHealth(env: Cloudflare.Env): Promise<void> {
  const db = createDb(env.DB);
  const rows = await listProtectionHealthRows(
    db,
    undefined,
    new Date(),
    PROTECTION_HEALTH_BATCH_LIMIT,
  );
  await mapWithConcurrency(rows, 3, async (row) => {
    try {
      await refreshProtectionHealth(db, env, row.target.organizationId, row.target.id);
    } catch {
      emitOperationalEvent("warn", "github_app.protection_health.target_failed", {
        organizationId: row.target.organizationId,
        releaseTargetId: row.target.id,
      });
    }
  });
}
