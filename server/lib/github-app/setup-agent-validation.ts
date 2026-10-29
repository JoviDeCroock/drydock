import { parseDocument } from "yaml";
import { isRecord } from "../platform/guards";
import {
  SETUP_REVIEW_MAX_PAGES,
  SETUP_REVIEW_PAGE_CHARS,
  setupAgentProposalBytes,
} from "./setup-agent-tools";
import { canonicalJson } from "../platform/canonical-json";
import { SETUP_ARTIFACT_NAMES } from "./setup-types";
import type { SetupAgentState, SetupAgentValidation } from "./setup-agent-types";

// A standalone `publish` token catches wrappers and flag orders (`pnpm -r publish`,
// `npm --provenance publish`, `changeset publish`) without matching names like publish-x.mjs.
const publisherCommand = /(?<![\w./-])publish(?![\w./-])|\btwine\s+upload\b/;

function workflow(content: string): Record<string, unknown> {
  const document = parseDocument(content, { strict: true, uniqueKeys: true });
  if (document.errors.length || document.warnings.length)
    throw new Error("Invalid YAML, duplicate keys, or unsupported tags.");
  const value: unknown = document.toJS({ maxAliasCount: 0 });
  if (!isRecord(value) || !isRecord(value.jobs)) throw new Error("A workflow must declare jobs.");
  return value;
}
function steps(job: Record<string, unknown>) {
  return Array.isArray(job.steps) ? job.steps.filter(isRecord) : [];
}
function jobsOf(value: Record<string, unknown> | null) {
  return value && isRecord(value.jobs) ? value.jobs : {};
}
function environment(job: Record<string, unknown>) {
  const value = isRecord(job.environment) ? job.environment.name : job.environment;
  return typeof value === "string" ? value.trim().toLowerCase() : null;
}
function strings(value: unknown, result: string[] = []): string[] {
  if (typeof value === "string") result.push(value);
  else if (Array.isArray(value)) for (const item of value) strings(item, result);
  else if (isRecord(value))
    for (const [key, item] of Object.entries(value)) {
      result.push(key);
      strings(item, result);
    }
  return result;
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
// YAML escapes such as "$\x7B{" decode to an expression GitHub evaluates, so workflow
// secrets are read from parsed scalars as well as the raw text.
function workflowSecretNames(content: string) {
  const result = secretNames(content);
  try {
    for (const text of strings(workflow(content)))
      for (const name of secretNames(text)) result.add(name);
  } catch {
    /* Unparseable workflows are rejected separately. */
  }
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
// A SHA can name an imposter commit pushed to a fork of the action's repository, which
// neither the judge nor a maintainer can tell apart; new references therefore use a tag.
const RELEASE_TAG = /^(?:v\d+(?:\.\d+){0,2}|release\/v\d+)$/;
function actionIdentity(reference: string) {
  const name = reference.trim().split("@")[0]!.toLowerCase();
  return name.startsWith("./") || name.startsWith("docker://")
    ? name
    : name.split("/").slice(0, 2).join("/");
}
function actionReferences(value: Record<string, unknown>) {
  const result: string[] = [];
  for (const job of Object.values(jobsOf(value))) {
    if (!isRecord(job)) continue;
    if (typeof job.uses === "string") result.push(job.uses.trim());
    for (const step of steps(job)) if (typeof step.uses === "string") result.push(step.uses.trim());
  }
  return result;
}
function images(job: Record<string, unknown>) {
  const result: string[] = [];
  const container = isRecord(job.container) ? job.container.image : job.container;
  if (typeof container === "string") result.push(container.trim());
  if (isRecord(job.services))
    for (const service of Object.values(job.services))
      if (isRecord(service) && typeof service.image === "string") result.push(service.image.trim());
  return result;
}
function writeScopes(permissions: unknown) {
  if (permissions === "write-all") return new Set(["*"]);
  if (!isRecord(permissions)) return new Set<string>();
  return new Set(
    Object.entries(permissions)
      .filter(([, level]) => level === "write")
      .map(([scope]) => scope),
  );
}
function grantsIdToken(permissions: unknown) {
  const scopes = writeScopes(permissions);
  return scopes.has("*") || scopes.has("id-token");
}

// Supporting files stay where other CI, hooks, editors, and package managers do not pick
// them up: scripts and data under .github/ outside workflows and actions. Other files can
// run before review (CI that ignores [skip ci], review-triggered workflows) or redirect
// publishing (manifests, registry configuration, .gitattributes, CODEOWNERS).
const SUPPORTING_FILE =
  /^\.github\/(?!workflows\/|actions\/)(?:[A-Za-z0-9_-][A-Za-z0-9._-]*\/)*[A-Za-z0-9_-][A-Za-z0-9._-]*\.(?:mjs|cjs|js|sh|py|json)$/;

// The protected job holds the OIDC grant, so it only runs setup, the single candidate
// download, and publishers; caches, scripts actions, and local or container code are out.
const PROTECTED_ACTIONS = new Set([
  "actions/checkout",
  "actions/setup-node",
  "actions/setup-python",
  "actions/download-artifact",
  ...KNOWN_ACTIONS,
]);
const PROTECTED_REFUSED_ACTIONS = new Set(["actions/cache", "actions/github-script"]);
const REGISTRY_HOSTS = new Set([
  "registry.npmjs.org",
  "upload.pypi.org",
  "test.pypi.org",
  "pypi.org",
  "marketplace.visualstudio.com",
  "open-vsx.org",
  "github.com",
  "api.github.com",
  "uploads.github.com",
]);
// Variables that load code or reconfigure where a package manager sends credentials,
// without appearing as a command in the reviewed diff.
const LOADER_ENV =
  /^(?:BASH_ENV|ENV|SHELLOPTS|BASHOPTS|PS4|PROMPT_COMMAND|IFS|PATH|NODE_OPTIONS|NODE_PATH|NODE_EXTRA_CA_CERTS|NODE_TLS_REJECT_UNAUTHORIZED|LD_\w+|DYLD_\w+|PYTHON\w*|PIP_\w+|UV_(?!PUBLISH_TOKEN$)\w+|TWINE_(?!USERNAME$|PASSWORD$)\w+|NPM_CONFIG_\w+|YARN_\w+|PNPM_\w+|COREPACK_\w+|BUN_\w+|(?:HTTPS?|ALL|NO)_PROXY|SSL_CERT_\w+|REQUESTS_CA_BUNDLE|CURL_CA_BUNDLE|GIT_\w+|PERL5?\w*|RUBY\w*|JAVA_TOOL_OPTIONS|_JAVA_OPTIONS)$/i;
const REGISTRY_FLAG =
  /(?:^|\s)--(?:registry|index-url|extra-index-url|index|publish-url|repository-url|check-url|userconfig|globalconfig)\b|--ignore-scripts[= ]false\b|\b(?:npm|pnpm|yarn)\s+config\s+set\b/;
const PACKAGE_MANAGERS = new Set(["npm", "pnpm", "yarn", "bun"]);
const PACKAGE_MANAGER_BUILDS = new Set([
  "ci",
  "i",
  "install",
  "add",
  "rebuild",
  "run",
  "run-script",
  "exec",
  "dlx",
  "x",
  "pack",
  "build",
  "test",
  "create",
  "init",
  "link",
]);
const BUILD_TOOLS = new Set([
  "npx",
  "pnpx",
  "bunx",
  "uvx",
  "corepack",
  "make",
  "cmake",
  "tsc",
  "node-gyp",
  "pip",
  "pip3",
]);
const INTERPRETERS = new Set([
  "node",
  "python",
  "python3",
  "bash",
  "sh",
  "deno",
  "tsx",
  "ruby",
  "perl",
  "pwsh",
]);
const SHELLS = new Set(["bash", "sh", "pwsh", "powershell", "python", "cmd"]);

// Installing or running a publisher CLI fetches the registry's tool, not repository code.
const PUBLISHER_TOOL = /^(?:npm|twine|@vscode\/vsce|ovsx)(?:(?:@|==)[A-Za-z0-9.^~_-]+)?$/;
function publisherTool(command: string, rest: string[]) {
  const operands = rest.filter((token) => !token.startsWith("-"));
  if (command === "npx") return PUBLISHER_TOOL.test(operands[0] ?? "") && operands[1] === "publish";
  const install =
    (command === "npm" &&
      /^(?:i|install)$/.test(operands[0] ?? "") &&
      rest.some((token) => /^(?:-g|--global)$/.test(token))) ||
    (/^pip3?$/.test(command) && operands[0] === "install") ||
    (/^python\d*(?:\.\d+)?$/.test(command) &&
      rest[0] === "-m" &&
      rest[1] === "pip" &&
      operands[1] === "install");
  const packages = operands.slice(command.startsWith("python") ? 2 : 1);
  return install && packages.length > 0 && packages.every((token) => PUBLISHER_TOOL.test(token));
}
function commandSegments(run: string) {
  return run
    .split(/&&|\|\||[;|\n]/)
    .map((segment) =>
      segment
        .trim()
        .split(/\s+/)
        .filter(Boolean)
        .filter((token, index, all) => !all.slice(0, index + 1).every(isPrefixToken)),
    )
    .filter((tokens) => tokens.length);
}
function isPrefixToken(token: string) {
  return /^(?:do|then|else|time|exec|env|[A-Za-z_][A-Za-z0-9_]*=\S*)$/.test(token);
}
function unquote(token: string) {
  return token.replace(/^["']|["']$/g, "");
}
function hosts(text: string) {
  return [...text.matchAll(/(?:[a-z][a-z0-9+.-]*:)?\/\/([A-Za-z0-9.-]+)/gi)].map(([, host]) =>
    host!.toLowerCase(),
  );
}
function envPairs(value: unknown) {
  return isRecord(value?.constructor === Object ? value : null)
    ? Object.entries(value as Record<string, unknown>).map(
        ([key, item]) => `${key}=${canonicalJson(item)}`,
      )
    : [];
}
function allEnvPairs(value: Record<string, unknown>) {
  const result = new Set(envPairs(value.env));
  for (const job of Object.values(jobsOf(value))) {
    if (!isRecord(job)) continue;
    for (const pair of envPairs(job.env)) result.add(pair);
    for (const step of steps(job)) for (const pair of envPairs(step.env)) result.add(pair);
  }
  return result;
}
function loaderEnvIssues(env: unknown, original: Set<string>, where: string) {
  if (!isRecord(env)) return [];
  return Object.entries(env)
    .filter(([key, item]) => LOADER_ENV.test(key) && !original.has(`${key}=${canonicalJson(item)}`))
    .map(([key]) => `${where}: ${key} changes how code loads or where publishing connects.`);
}

interface ProtectedContext {
  where: string;
  artifactName: string;
  ecosystem: SetupAgentState["request"]["ecosystem"];
  trustedActions: Set<string>;
  originalEnv: Set<string>;
  originalHosts: Set<string>;
}

/** Issues for one protected job; the producer dependency is checked by the caller. */
function protectedJobIssues(job: Record<string, unknown>, context: ProtectedContext) {
  const { where } = context;
  const issues: string[] = [];
  const jobSteps = steps(job);
  if (job["continue-on-error"]) issues.push(`${where}: the protected job cannot ignore failures.`);
  for (const key of ["container", "services", "defaults", "uses"])
    if (job[key] !== undefined)
      issues.push(`${where}: the protected job cannot use ${key}; it runs on the plain runner.`);
  issues.push(...loaderEnvIssues(job.env, context.originalEnv, where));
  for (const host of new Set(hosts(strings(job).join("\n"))))
    if (!REGISTRY_HOSTS.has(host) && !context.originalHosts.has(host))
      issues.push(`${where}: ${host} is not a package registry the protected job may contact.`);

  const downloads = jobSteps
    .map((step, index) => ({ step, index }))
    .filter(
      ({ step }) =>
        typeof step.uses === "string" && actionIdentity(step.uses) === "actions/download-artifact",
    );
  const download = downloads[0];
  if (
    downloads.length !== 1 ||
    !artifact(download!.step, "actions/download-artifact", context.artifactName)
  )
    issues.push(
      `${where}: download exactly one artifact, the current-run ${context.artifactName} candidate.`,
    );
  const downloadWith = download && isRecord(download.step.with) ? download.step.with : {};
  if (Object.keys(downloadWith).some((key) => key !== "name" && key !== "path"))
    issues.push(`${where}: the candidate download takes only name and path.`);
  const rawPath = downloadWith.path;
  const downloadPath =
    typeof rawPath === "string" ? rawPath.trim().replace(/^\.\//, "").replace(/\/+$/, "") : "";
  if (
    rawPath !== undefined &&
    (typeof rawPath !== "string" || rawPath.includes("${{") || /(?:^|\/)\.\.(?:\/|$)/.test(rawPath))
  )
    issues.push(`${where}: the candidate download path is a literal workspace directory.`);
  const downloadIndex = download?.index ?? -1;
  const checkoutIndex = jobSteps.findIndex(
    (step) => typeof step.uses === "string" && actionIdentity(step.uses) === "actions/checkout",
  );

  function checkCommand(run: string, label: string, index: number) {
    for (const tokens of commandSegments(run)) {
      const [command, ...rest] = tokens.map(unquote);
      if (!command) continue;
      if (
        !publisherTool(command, rest) &&
        (BUILD_TOOLS.has(command) ||
          (PACKAGE_MANAGERS.has(command) &&
            rest.some((token) => PACKAGE_MANAGER_BUILDS.has(token))) ||
          (/^python\d*(?:\.\d+)?$/.test(command) &&
            rest[0] === "-m" &&
            /^(?:build|pip)$/.test(rest[1] ?? "")) ||
          (["uv", "poetry", "hatch"].includes(command) &&
            rest.some((token) => /^(?:build|sync|run|pip|tool|add|install|venv)$/.test(token))) ||
          (["vsce", "ovsx"].includes(command) && rest.includes("package")))
      )
        issues.push(`${label}: move builds and dependency installation before the protected job.`);
      if (command === "gh" && rest.includes("download"))
        issues.push(`${label}: download only the named candidate artifact.`);
      if (
        context.ecosystem === "npm" &&
        ["npm", "pnpm", "yarn"].includes(command) &&
        rest.includes("publish") &&
        !rest.some((token) => /\.tgz$|^\$\{?\w+\}?$/.test(token))
      )
        issues.push(
          `${label}: publish the downloaded .tgz candidates, not the checked-out source.`,
        );
      if (publisherTool(command, rest)) continue;
      const script = INTERPRETERS.has(command)
        ? rest.find((token) => !token.startsWith("-"))
        : command.includes("/")
          ? command
          : undefined;
      if (script === undefined) continue;
      const normalized = script.replace(/^\.\//, "");
      // Candidate archives are unreviewed build output; only checked-out, reviewed source runs.
      if (checkoutIndex < 0 || checkoutIndex > index)
        issues.push(`${label}: check out the repository before running ${normalized}.`);
      else if (
        downloadIndex >= 0 &&
        (!downloadPath || downloadPath === "." || normalized.startsWith(`${downloadPath}/`))
      )
        issues.push(
          `${label}: download candidates into their own directory and run scripts only from the checkout.`,
        );
    }
  }

  jobSteps.forEach((step, index) => {
    const label = `${where} step ${index + 1}`;
    issues.push(...loaderEnvIssues(step.env, context.originalEnv, label));
    const stepWith = isRecord(step.with) ? step.with : {};
    if (typeof step.uses === "string") {
      const identity = actionIdentity(step.uses);
      if (
        PROTECTED_REFUSED_ACTIONS.has(identity) ||
        identity.startsWith("./") ||
        identity.startsWith("docker://") ||
        (!PROTECTED_ACTIONS.has(identity) && !context.trustedActions.has(identity))
      )
        issues.push(`${label}: ${identity} cannot run with the protected job's credentials.`);
      if (identity === "actions/checkout" && ("ref" in stepWith || "repository" in stepWith))
        issues.push(`${label}: check out this run's commit, not another ref or repository.`);
      if (
        identity === "pnpm/action-setup" &&
        stepWith.run_install !== undefined &&
        stepWith.run_install !== false &&
        stepWith.run_install !== "false"
      )
        issues.push(`${label}: install dependencies before the protected job.`);
      if (identity === "actions/setup-python" && "pip-install" in stepWith)
        issues.push(`${label}: install dependencies before the protected job.`);
    }
    if (step.shell !== undefined && !(typeof step.shell === "string" && SHELLS.has(step.shell)))
      issues.push(`${label}: use a standard shell.`);
    // changesets/action runs its version and publish inputs as shell commands.
    const commands = [
      step.run,
      ...(typeof step.uses === "string" && actionIdentity(step.uses) === "changesets/action"
        ? [stepWith.publish, stepWith.version]
        : []),
    ].filter((command): command is string => typeof command === "string");
    for (const command of commands) {
      if (REGISTRY_FLAG.test(command))
        issues.push(`${label}: keep the default registry and package-manager configuration.`);
      checkCommand(command, label, index);
    }
  });
  if (checkoutIndex > downloadIndex && downloadIndex >= 0)
    issues.push(`${where}: check out before downloading so candidates cannot be overwritten.`);
  if (jobSteps.some((step, index) => publisher(step) && index <= downloadIndex))
    issues.push(`${where}: publishing must follow the artifact download.`);
  return issues;
}

/** Checks observable configuration facts; arbitrary script semantics remain a review responsibility. */
export function validateSetupAgentChanges(state: SetupAgentState): SetupAgentValidation {
  const issues: string[] = [];
  const environmentName = state.request.environment;
  const artifactName = SETUP_ARTIFACT_NAMES[state.request.ecosystem];
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
  const reviewPages = changed.reduce(
    (sum, file) =>
      sum +
      Math.max(
        1,
        Math.ceil(
          Math.max(file.originalContent?.length ?? 0, file.content.length) /
            SETUP_REVIEW_PAGE_CHARS,
        ),
      ),
    0,
  );
  if (reviewPages > SETUP_REVIEW_MAX_PAGES)
    issues.push(
      `The proposal needs ${reviewPages} review pages; keep changed files within ${SETUP_REVIEW_MAX_PAGES} so independent review can read every change.`,
    );
  const folded = new Map<string, number>();
  for (const path of Object.keys(state.files))
    folded.set(path.toLowerCase(), (folded.get(path.toLowerCase()) ?? 0) + 1);
  const actionDirectories = Object.keys(state.files)
    .filter((path) => /(?:^|\/)action\.ya?ml$/.test(path))
    .map((path) => path.replace(/action\.ya?ml$/, ""));
  for (const file of changed) {
    if ((folded.get(file.path.toLowerCase()) ?? 0) > 1)
      issues.push(`${file.path}: another path differs only by letter case.`);
    if (file.path === state.request.workflowPath) continue;
    if (file.path.startsWith(".github/workflows/") || /(?:^|\/)action\.ya?ml$/.test(file.path))
      issues.push(
        `${file.path}: only the selected workflow can change; other workflows and actions can run before review.`,
      );
    else if (
      !SUPPORTING_FILE.test(file.path) ||
      actionDirectories.some((directory) => file.path.startsWith(directory))
    )
      issues.push(
        `${file.path}: supporting changes are limited to .mjs, .cjs, .js, .sh, .py, or .json files under .github/ outside workflows and actions; other repository files can run in CI, hooks, or package managers before review.`,
      );
  }
  // Only the selected workflow's own source establishes a secret for it; documentation the
  // agent read, and secrets other workflows use for unrelated purposes, do not.
  const originalSecrets =
    selected.originalContent === null ? new Set() : workflowSecretNames(selected.originalContent);
  for (const file of changed) {
    const names = /\.ya?ml$/.test(file.path)
      ? workflowSecretNames(file.content)
      : secretNames(file.content);
    if ([...names].some((name) => !originalSecrets.has(name)))
      issues.push(`${file.path}: the change adds a secret reference absent from inspected source.`);
  }
  const workflows = Object.values(state.files).filter(
    (file) =>
      /^\.github\/workflows\/[^/]+\.ya?ml$/.test(file.path) &&
      (file.originalContent !== file.content || file.path === state.request.workflowPath),
  );
  const trustedActions = new Set(KNOWN_ACTIONS);
  const originalReferences = new Set<string>();
  const originalImages = new Set<string>();
  for (const file of Object.values(state.files))
    if (file.originalContent !== null && /^\.github\/workflows\/[^/]+\.ya?ml$/.test(file.path))
      try {
        const original = workflow(file.originalContent);
        for (const reference of actionReferences(original)) {
          originalReferences.add(reference);
          trustedActions.add(actionIdentity(reference));
        }
        for (const job of Object.values(jobsOf(original)))
          if (isRecord(job)) for (const image of images(job)) originalImages.add(image);
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
        `${file.path}: use valid YAML with direct jobs, no duplicate keys, aliases, or custom tags.`,
      );
      continue;
    }
    for (const reference of new Set(actionReferences(after))) {
      const identity = actionIdentity(reference);
      if (!identity.startsWith("actions/") && !trustedActions.has(identity))
        issues.push(
          `${file.path}: ${identity} is not used by the inspected workflows; keep new actions out of the proposal.`,
        );
      else if (
        !originalReferences.has(reference) &&
        !identity.startsWith("./") &&
        !RELEASE_TAG.test(reference.slice(reference.indexOf("@") + 1))
      )
        issues.push(
          `${file.path}: reference ${identity} by a release tag such as v4; commit pins must already appear in the inspected workflows.`,
        );
    }
    if (canonicalJson(before?.defaults ?? null) !== canonicalJson(after.defaults ?? null))
      issues.push(`${file.path}: workflow defaults stay unchanged.`);
    const originalEnv = before ? allEnvPairs(before) : new Set<string>();
    const originalHosts = new Set(before ? hosts(strings(before).join("\n")) : []);
    const workflowPermissionsChanged =
      canonicalJson(before?.permissions ?? null) !== canonicalJson(after.permissions ?? null);
    // Write scopes stay within what the original workflow already granted somewhere.
    const originalWrites = writeScopes(before?.permissions);
    for (const job of Object.values(jobsOf(before)))
      if (isRecord(job))
        for (const scope of writeScopes(job.permissions)) originalWrites.add(scope);
    const broadened = (permissions: unknown) =>
      !originalWrites.has("*") &&
      [...writeScopes(permissions)].some(
        (scope) => scope !== "id-token" && !originalWrites.has(scope),
      );
    if (workflowPermissionsChanged && broadened(after.permissions))
      issues.push(`${file.path}: workflow permissions cannot add write scopes.`);
    if (workflowPermissionsChanged && grantsIdToken(after.permissions))
      issues.push(`${file.path}: grant id-token: write on the protected job, not the workflow.`);
    issues.push(...loaderEnvIssues(after.env, originalEnv, file.path));

    const jobs = jobsOf(after);
    const originalJobs = jobsOf(before);
    for (const [jobId, job] of Object.entries(jobs)) {
      if (!isRecord(job)) continue;
      const where = `${file.path}/${jobId}`;
      const unchanged =
        Object.hasOwn(originalJobs, jobId) &&
        canonicalJson(originalJobs[jobId]) === canonicalJson(job);
      const protectedJob = environment(job) === environmentName;
      if (!unchanged) {
        if (broadened(job.permissions))
          issues.push(`${where}: job permissions cannot add write scopes.`);
        for (const image of images(job))
          if (protectedJob || !originalImages.has(image))
            issues.push(`${where}: ${image} is not a container image the inspected workflows use.`);
        const original = originalJobs[jobId];
        if (
          job.secrets === "inherit" &&
          !(isRecord(original) && original.secrets === "inherit" && original.uses === job.uses)
        )
          issues.push(`${where}: pass named secrets instead of inheriting all of them.`);
      }
      if (
        !protectedJob &&
        (!unchanged || workflowPermissionsChanged) &&
        grantsIdToken(job.permissions !== undefined ? job.permissions : after.permissions)
      )
        issues.push(`${where}: grant id-token: write only to the protected job.`);
      if (steps(job).some(publisher) && !protectedJob)
        issues.push(`${where}: a known publisher is outside the requested environment.`);
      if (!protectedJob) continue;
      const jobIssues = protectedJobIssues(job, {
        where,
        artifactName,
        ecosystem: state.request.ecosystem,
        trustedActions,
        originalEnv,
        originalHosts,
      });
      const needs =
        typeof job.needs === "string" ? [job.needs] : Array.isArray(job.needs) ? job.needs : [];
      const producer = needs.some((id) => {
        const upstream = jobs[String(id)];
        return (
          isRecord(upstream) &&
          environment(upstream) !== environmentName &&
          steps(upstream).some(
            (step) =>
              artifact(step, "actions/upload-artifact", artifactName) &&
              isRecord(step.with) &&
              step.with["if-no-files-found"] !== "ignore",
          )
        );
      });
      if (!producer)
        jobIssues.push(
          `${where}: depend on an unprotected job that uploads the named release candidate.`,
        );
      if (!jobIssues.length) gateFound = true;
      // An unchanged protected job is the maintainer's own; only drafted ones must meet the contract.
      else if (!unchanged) issues.push(...jobIssues);
    }
  }
  if (!gateFound)
    issues.push(
      "Provide a literal protected publish environment, matching current-run artifact download, and an upstream candidate upload.",
    );
  return { valid: issues.length === 0, issues: issues.slice(0, 12) };
}
