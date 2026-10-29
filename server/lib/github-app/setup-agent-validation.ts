import { parseDocument } from "yaml";
import { isRecord } from "../platform/guards";
import { setupAgentProposalBytes } from "./setup-agent-tools";
import { canonicalJson } from "../platform/canonical-json";
import { SETUP_ARTIFACT_NAMES } from "./setup-types";
import type { SetupAgentState, SetupAgentValidation } from "./setup-agent-types";

const publisherCommand =
  /\b(?:npm\s+(?:stage\s+)?publish|pnpm\s+publish|yarn\s+(?:npm\s+)?publish|twine\s+upload|uv\s+publish|(?:vsce|ovsx)\s+publish)\b/;
const buildCommand =
  /\b(?:npm\s+(?:ci|install)|pnpm\s+install|yarn\s+install|(?:npm|pnpm|yarn|bun)\s+(?:pack|build|run\s+build)|python\s+-m\s+build|uv\s+build|vsce\s+package)\b/;

function workflow(content: string): Record<string, unknown> {
  const document = parseDocument(content, { strict: true, uniqueKeys: true });
  if (document.errors.length || document.warnings.length)
    throw new Error("Invalid YAML, duplicate keys, or unsupported tags.");
  const value: unknown = document.toJS({ maxAliasCount: 20 });
  if (!isRecord(value) || !isRecord(value.jobs)) throw new Error("A workflow must declare jobs.");
  return value;
}
function steps(job: Record<string, unknown>) {
  return Array.isArray(job.steps) ? job.steps.filter(isRecord) : [];
}
function environment(job: Record<string, unknown>) {
  const value = isRecord(job.environment) ? job.environment.name : job.environment;
  return typeof value === "string" ? value.trim().toLowerCase() : null;
}
function secretNames(content: string) {
  const result = new Set<string>();
  for (const [, expression] of content.matchAll(/\$\{\{([\s\S]*?)\}\}/g))
    for (const match of expression.matchAll(
      /\bsecrets\b(?:\s*\.\s*([A-Za-z_][A-Za-z0-9_-]*)|\s*\[\s*'([^']+)'\s*\])?/g,
    ))
      result.add((match[1] ?? match[2] ?? "*").toUpperCase());
  return result;
}
function publisher(step: Record<string, unknown>) {
  if (typeof step.run === "string" && publisherCommand.test(step.run)) return true;
  if (typeof step.uses !== "string") return false;
  if (step.uses.startsWith("changesets/action@"))
    return (
      isRecord(step.with) &&
      typeof step.with.publish === "string" &&
      Boolean(step.with.publish.trim())
    );
  return /(?:^|\/)(?:gh-action-pypi-publish|npm-publish)(?:@|\/)/.test(step.uses);
}
function artifact(step: Record<string, unknown>, action: string, name: string) {
  return (
    typeof step.uses === "string" &&
    step.uses.startsWith(`${action}@`) &&
    isRecord(step.with) &&
    step.with.name === name &&
    !step.if &&
    !step["continue-on-error"]
  );
}

// Repository text can steer the agent, so new third-party code and OIDC grants are
// limited to what the inspected source already trusted plus the common release actions.
const KNOWN_ACTIONS = new Set([
  "changesets/action",
  "pnpm/action-setup",
  "pypa/gh-action-pypi-publish",
  "astral-sh/setup-uv",
  "oven-sh/setup-bun",
]);
function actionIdentity(reference: string) {
  const name = reference.trim().split("@")[0]!.toLowerCase();
  return name.startsWith("./") || name.startsWith("docker://")
    ? name
    : name.split("/").slice(0, 2).join("/");
}
function actionReferences(value: Record<string, unknown>) {
  const result: string[] = [];
  for (const job of Object.values(isRecord(value.jobs) ? value.jobs : {})) {
    if (!isRecord(job)) continue;
    if (typeof job.uses === "string") result.push(job.uses);
    for (const step of steps(job)) if (typeof step.uses === "string") result.push(step.uses);
  }
  return result;
}
// Registry and credential configuration redirects where the protected publisher sends its token.
const REGISTRY_CONFIG =
  /(?:^|\/)(?:\.npmrc|\.yarnrc|\.yarnrc\.yml|\.pypirc|pip\.conf|bunfig\.toml)$/;
function publishConfig(content: string | null) {
  if (content === null) return null;
  try {
    const value: unknown = JSON.parse(content);
    return canonicalJson(isRecord(value) ? (value.publishConfig ?? null) : null);
  } catch {
    return "unparseable";
  }
}
function grantsIdToken(permissions: unknown) {
  return (
    permissions === "write-all" || (isRecord(permissions) && permissions["id-token"] === "write")
  );
}
function idTokenJobs(value: Record<string, unknown>, environmentName: string) {
  const result = new Set<string>();
  for (const [jobId, job] of Object.entries(isRecord(value.jobs) ? value.jobs : {}))
    if (
      isRecord(job) &&
      environment(job) !== environmentName &&
      grantsIdToken(job.permissions !== undefined ? job.permissions : value.permissions)
    )
      result.add(jobId);
  return result;
}

/** Checks observable configuration facts; arbitrary script semantics remain a review responsibility. */
export function validateSetupAgentChanges(state: SetupAgentState): SetupAgentValidation {
  const issues: string[] = [];
  const selected = state.files[state.request.workflowPath];
  if (!selected)
    return { valid: false, issues: ["Read and retain the selected workflow before submission."] };
  const changed = Object.values(state.files).filter(
    (file) => file.originalContent !== file.content,
  );
  if (!changed.length) issues.push("The proposal contains no changes.");
  if (
    changed.length > 13 ||
    changed.filter((file) => file.path !== state.request.workflowPath).length > 12 ||
    setupAgentProposalBytes(state, changed) > 262_144
  )
    issues.push("The proposed file set exceeds the change budget.");
  for (const file of changed) {
    if (!/^[A-Za-z0-9._@+/-]+$/.test(file.path))
      issues.push(`${file.path}: changed paths use only letters, digits, and . _ @ + / -.`);
    if (
      file.path !== state.request.workflowPath &&
      (file.path.startsWith(".github/workflows/") || /(?:^|\/)action\.ya?ml$/.test(file.path))
    )
      issues.push(
        `${file.path}: only the selected workflow can change; other workflows and actions can run before review.`,
      );
    if (REGISTRY_CONFIG.test(file.path))
      issues.push(`${file.path}: registry and credential configuration stays unchanged.`);
    if (
      /(?:^|\/)package\.json$/.test(file.path) &&
      publishConfig(file.originalContent) !== publishConfig(file.content)
    )
      issues.push(`${file.path}: publishConfig stays unchanged.`);
  }
  // Only workflow source can establish a secret; documentation the agent read cannot.
  const originalSecrets = new Set(
    Object.values(state.files).flatMap((file) =>
      file.originalContent === null || !file.path.startsWith(".github/workflows/")
        ? []
        : [...secretNames(file.originalContent)],
    ),
  );
  for (const file of changed)
    if ([...secretNames(file.content)].some((name) => !originalSecrets.has(name)))
      issues.push(`${file.path}: the change adds a secret reference absent from inspected source.`);
  const workflows = Object.values(state.files).filter(
    (file) =>
      /^\.github\/workflows\/[^/]+\.ya?ml$/.test(file.path) &&
      (file.originalContent !== file.content || file.path === state.request.workflowPath),
  );
  const trustedActions = new Set(KNOWN_ACTIONS);
  for (const file of Object.values(state.files))
    if (file.originalContent !== null && /^\.github\/workflows\/[^/]+\.ya?ml$/.test(file.path))
      try {
        for (const reference of actionReferences(workflow(file.originalContent)))
          trustedActions.add(actionIdentity(reference));
      } catch {
        /* An unparseable original contributes no trusted actions. */
      }
  let gateFound = false;
  for (const file of workflows) {
    let after: Record<string, unknown>;
    let before: Record<string, unknown> | null = null;
    try {
      after = workflow(file.content);
      if (file.originalContent !== null) {
        before = workflow(file.originalContent);
        if (canonicalJson(before.on) !== canonicalJson(after.on))
          issues.push(`${file.path}: preserve the existing workflow triggers.`);
      }
    } catch {
      issues.push(
        `${file.path}: use valid YAML with direct jobs, no duplicate keys or custom tags.`,
      );
      continue;
    }
    for (const reference of new Set(actionReferences(after).map(actionIdentity)))
      if (!reference.startsWith("actions/") && !trustedActions.has(reference))
        issues.push(
          `${file.path}: ${reference} is not used by the inspected workflows; keep new actions out of the proposal.`,
        );
    const previousGrants = before ? idTokenJobs(before, state.request.environment) : new Set();
    for (const jobId of idTokenJobs(after, state.request.environment))
      if (!previousGrants.has(jobId))
        issues.push(`${file.path}/${jobId}: grant id-token: write only to the protected job.`);
    const jobs = after.jobs as Record<string, unknown>;
    for (const [jobId, job] of Object.entries(jobs)) {
      if (!isRecord(job)) continue;
      const jobSteps = steps(job);
      const protectedJob = environment(job) === state.request.environment;
      if (jobSteps.some(publisher) && !protectedJob)
        issues.push(
          `${file.path}/${jobId}: a known publisher is outside the requested environment.`,
        );
      if (!protectedJob) continue;
      if (job["continue-on-error"])
        issues.push(`${file.path}/${jobId}: the protected job cannot ignore failures.`);
      const downloadIndex = jobSteps.findIndex((step) =>
        artifact(step, "actions/download-artifact", SETUP_ARTIFACT_NAMES[state.request.ecosystem]),
      );
      const download = jobSteps[downloadIndex];
      if (!download) {
        if (jobSteps.some(publisher))
          issues.push(
            `${file.path}/${jobId}: every protected publisher must download the matching current-run candidate artifact.`,
          );
        continue;
      }
      if (
        isRecord(download.with) &&
        (download.with["run-id"] !== undefined || download.with["repository"] !== undefined)
      )
        issues.push(`${file.path}/${jobId}: download the artifact from this run.`);
      if (
        jobSteps.some(
          (step) =>
            typeof step.run === "string" &&
            buildCommand.test(step.run) &&
            !/^npm (?:install|i) (?:-g|--global) npm@[A-Za-z0-9.^~_-]+$/.test(step.run.trim()),
        )
      )
        issues.push(
          `${file.path}/${jobId}: move builds and dependency installation before the protected job.`,
        );
      if (jobSteps.some((step, index) => publisher(step) && index <= downloadIndex))
        issues.push(`${file.path}/${jobId}: publishing must follow the artifact download.`);
      const needs =
        typeof job.needs === "string" ? [job.needs] : Array.isArray(job.needs) ? job.needs : [];
      const producer = needs.some((id) => {
        const upstream = jobs[String(id)];
        return (
          isRecord(upstream) &&
          environment(upstream) !== state.request.environment &&
          steps(upstream).some(
            (step) =>
              artifact(
                step,
                "actions/upload-artifact",
                SETUP_ARTIFACT_NAMES[state.request.ecosystem],
              ) &&
              isRecord(step.with) &&
              step.with["if-no-files-found"] !== "ignore",
          )
        );
      });
      if (producer) gateFound = true;
      else
        issues.push(
          `${file.path}/${jobId}: depend on an unprotected job that uploads the named release candidate.`,
        );
    }
  }
  if (!gateFound)
    issues.push(
      "Provide a literal protected publish environment, matching current-run artifact download, and an upstream candidate upload.",
    );
  return { valid: issues.length === 0, issues: issues.slice(0, 12) };
}
