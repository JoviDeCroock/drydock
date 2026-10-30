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
const publisherCommand =
  /(?<![\w./-])publish(?![\w./-])|\btwine\s+upload\b|\bsemantic-release\b|\brelease-it\b|\bnx\s+release\b/;

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

// Supporting files are new scripts and data under .github/ outside workflows and actions:
// nothing else in the repository can already reference them, so CI that ignores [skip ci],
// review-triggered workflows, hooks, and package managers cannot run or reinterpret them
// before review. Existing files, manifests, and repository configuration stay unchanged.
const SUPPORTING_FILE =
  /^\.github\/(?!workflows\/|actions\/)(?:[A-Za-z0-9_-][A-Za-z0-9._-]*\/)*[A-Za-z0-9_-][A-Za-z0-9._-]*\.(?:mjs|cjs|js|sh|py|json)$/;
// These events run the PR's merge ref, so a drafted workflow on them would run before review.
const REVIEW_EVENTS = ["pull_request_review", "pull_request_review_comment"];

// The protected job holds the OIDC grant, so every action input and shell command in it is
// allowlisted: setup, the single candidate download, checksums, git tagging, publisher CLIs
// over candidate paths, and reviewed scripts from a checkout made before the download.
const PROTECTED_INPUTS: Record<string, ReadonlySet<string>> = {
  "actions/checkout": new Set([
    "persist-credentials",
    "fetch-depth",
    "fetch-tags",
    "sparse-checkout",
    "sparse-checkout-cone-mode",
    "show-progress",
    "filter",
    "lfs",
  ]),
  "actions/setup-node": new Set([
    "node-version",
    "node-version-file",
    "registry-url",
    "scope",
    "always-auth",
    "package-manager-cache",
    "check-latest",
    "architecture",
  ]),
  "actions/setup-python": new Set([
    "python-version",
    "python-version-file",
    "architecture",
    "check-latest",
  ]),
  "actions/download-artifact": new Set(["name", "path"]),
  "astral-sh/setup-uv": new Set(["version", "python-version"]),
  "pnpm/action-setup": new Set(["version", "run_install"]),
  "oven-sh/setup-bun": new Set(["bun-version", "bun-version-file"]),
  "pypa/gh-action-pypi-publish": new Set([
    "packages-dir",
    "repository-url",
    "attestations",
    "print-hash",
    "verbose",
    "skip-existing",
  ]),
  "changesets/action": new Set([
    "publish",
    "createGithubReleases",
    "commitMode",
    "title",
    "commit",
    "setupGitUser",
  ]),
};
const REGISTRY_HOSTS = new Set([
  "registry.npmjs.org",
  "upload.pypi.org",
  "test.pypi.org",
  "marketplace.visualstudio.com",
  "open-vsx.org",
]);
// Variables that load code, move configuration lookup, or redirect where a package
// manager sends credentials, without appearing as a command in the reviewed diff.
const LOADER_ENV =
  /^(?:BASH_ENV|ENV|SHELLOPTS|BASHOPTS|PS4|PROMPT_COMMAND|IFS|PATH|HOME|USERPROFILE|APPDATA|XDG_\w+|NODE_OPTIONS|NODE_PATH|NODE_EXTRA_CA_CERTS|NODE_TLS_REJECT_UNAUTHORIZED|LD_\w+|DYLD_\w+|PYTHON\w*|PIP_\w+|UV_(?!PUBLISH_TOKEN$)\w+|TWINE_(?!USERNAME$|PASSWORD$)\w+|NPM_CONFIG_\w+|YARN_\w+|PNPM_\w+|COREPACK_\w+|BUN_\w+|(?:HTTPS?|ALL|NO)_PROXY|SSL_CERT_\w+|REQUESTS_CA_BUNDLE|CURL_CA_BUNDLE|GIT_\w+|PERL5?\w*|RUBY\w*|JAVA_TOOL_OPTIONS|_JAVA_OPTIONS|ACTIONS_\w+)$/i;
const REGISTRY_FLAG =
  /--(?:registry|index-url|extra-index-url|index|publish-url|repository-url|check-url|userconfig|globalconfig|config-file|directory|project)\b|--ignore-scripts[= ]false\b/;
const REGISTRY_TOKEN =
  /^(?:NPM_TOKEN|NODE_AUTH_TOKEN|TWINE_PASSWORD|TWINE_USERNAME|UV_PUBLISH_TOKEN|VSCE_PAT|OVSX_PAT)$|NPM|PYPI|TWINE|VSCE|OVSX|REGISTRY|PUBLISH/i;
const SHELLS = new Set(["bash", "sh", "pwsh", "powershell", "python", "cmd"]);
const CANDIDATE_SUFFIX: Record<SetupAgentState["request"]["ecosystem"], RegExp> = {
  npm: /\.tgz$/,
  pypi: /(?:\*|\.whl|\.tar\.gz)$/,
  vscode: /\.vsix$/,
};
// Installing a publisher CLI fetches the registry's tool, not repository code.
const PUBLISHER_TOOL = /^(?:npm|twine|@vscode\/vsce|ovsx)(?:(?:@|==)[A-Za-z0-9.^~_-]+)?$/;
const VALUE_FLAGS = new Set([
  "--access",
  "--tag",
  "--otp",
  "-p",
  "--pat",
  "-u",
  "--username",
  "--password",
  "--token",
  "--trusted-publishing",
]);

function commandSegments(run: string) {
  return run
    .replace(/\\\n/g, " ")
    .split(/&&|\|\||[;&|\n]/)
    .map((segment) => segment.trim().split(/\s+/).filter(Boolean).map(unquote))
    .filter((tokens) => tokens.length);
}
function unquote(token: string) {
  return token.replace(/^["']|["']$/g, "");
}
function operands(tokens: string[]) {
  const result: string[] = [];
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index]!;
    if (VALUE_FLAGS.has(token)) index++;
    else if (!token.startsWith("-")) result.push(token);
  }
  return result;
}
function workspacePath(token: string) {
  const stripped = token.replace(/^(?:\$\{?GITHUB_WORKSPACE\}?|\$\{?PWD\}?)\//, "");
  if (stripped.startsWith("/") || stripped.includes("$")) return null;
  const parts: string[] = [];
  for (const part of stripped.split("/"))
    if (part === "..") {
      if (!parts.pop()) return null;
    } else if (part && part !== ".") parts.push(part);
  return parts.join("/");
}
function urlIssues(text: string, allowed: Set<string>) {
  const issues: string[] = [];
  for (const [match] of text.matchAll(/(?:\b[a-z][a-z0-9+.-]*:)?\/\/[^\s"'<>`]+/gi)) {
    let url: URL;
    try {
      url = new URL(match.startsWith("//") ? `https:${match}` : match);
    } catch {
      issues.push(`${match} is not a well-formed registry address.`);
      continue;
    }
    if (url.username || url.password)
      issues.push(`${url.hostname}: addresses carry no credentials.`);
    else if (!REGISTRY_HOSTS.has(url.hostname) && !allowed.has(url.hostname))
      issues.push(`${url.hostname} is not a package registry the protected job may contact.`);
  }
  return issues;
}
function urlHosts(text: string) {
  const result = new Set<string>();
  for (const [match] of text.matchAll(/(?:\b[a-z][a-z0-9+.-]*:)?\/\/[^\s"'<>`]+/gi))
    try {
      result.add(new URL(match.startsWith("//") ? `https:${match}` : match).hostname);
    } catch {
      /* Malformed addresses establish no trusted host. */
    }
  return result;
}
function envPairs(value: unknown) {
  return isRecord(value)
    ? Object.entries(value).map(([key, item]) => `${key}=${canonicalJson(item)}`)
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
function registryTokenUse(job: Record<string, unknown>) {
  const envKeys = [job.env, ...steps(job).map((step) => step.env)].flatMap((env) =>
    isRecord(env) ? Object.keys(env) : [],
  );
  return (
    envKeys.some((key) => REGISTRY_TOKEN.test(key)) ||
    [...secretNames(strings(job).join("\n"))].some(
      (name) => name !== "GITHUB_TOKEN" && REGISTRY_TOKEN.test(name),
    )
  );
}

interface ProtectedContext {
  where: string;
  artifactName: string;
  ecosystem: SetupAgentState["request"]["ecosystem"];
  originalSteps: Set<string>;
  originalEnv: Set<string>;
  originalHosts: Set<string>;
  workflowDefaults: unknown;
}

/** Issues for one protected job; the producer dependency is checked by the caller. */
function protectedJobIssues(job: Record<string, unknown>, context: ProtectedContext) {
  const { where } = context;
  const issues: string[] = [];
  const jobSteps = steps(job);
  if (job["continue-on-error"]) issues.push(`${where}: the protected job cannot ignore failures.`);
  for (const key of ["container", "services", "defaults", "uses", "strategy"])
    if (job[key] !== undefined)
      issues.push(`${where}: the protected job cannot use ${key}; it runs on the plain runner.`);
  const defaultsRun = isRecord(context.workflowDefaults) ? context.workflowDefaults.run : undefined;
  if (
    defaultsRun !== undefined &&
    !(
      isRecord(defaultsRun) &&
      Object.keys(defaultsRun).every((key) => key === "shell") &&
      typeof defaultsRun.shell === "string" &&
      SHELLS.has(defaultsRun.shell)
    )
  )
    issues.push(
      `${where}: workflow run defaults other than a standard shell reach the protected job.`,
    );
  issues.push(...loaderEnvIssues(job.env, context.originalEnv, where));
  for (const issue of urlIssues(strings([job.env, job.steps]).join("\n"), context.originalHosts))
    issues.push(`${where}: ${issue}`);

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
  const rawPath = download && isRecord(download.step.with) ? download.step.with.path : undefined;
  // A dedicated directory keeps candidate files from overwriting the checkout or supplying
  // configuration (.npmrc, uv.toml, pyproject.toml) that publishers read from the workspace.
  const downloadPath =
    typeof rawPath === "string" ? rawPath.trim().replace(/^\.\//, "").replace(/\/+$/, "") : "";
  if (!/^[A-Za-z0-9_-][A-Za-z0-9._-]*$/.test(downloadPath))
    issues.push(
      `${where}: download candidates into one dedicated directory, for example path: candidates.`,
    );
  const downloadIndex = download?.index ?? -1;
  const checkoutIndex = jobSteps.findIndex(
    (step) => typeof step.uses === "string" && actionIdentity(step.uses) === "actions/checkout",
  );
  const isCandidate = (path: string | null) =>
    path !== null &&
    path.startsWith(`${downloadPath}/`) &&
    CANDIDATE_SUFFIX[context.ecosystem].test(path);

  function commandIssues(run: string, index: number): string[] {
    if (/[<>`]|\$\(|\$\{\{|ACTIONS_|GITHUB_ENV|GITHUB_PATH|GITHUB_OUTPUT/.test(run))
      return [
        "use plain commands without redirection, substitution, expressions, or runner files.",
      ];
    if (REGISTRY_FLAG.test(run)) return ["keep the default registry and configuration."];
    const result: string[] = [];
    const loops = new Map<string, boolean>();
    const candidate = (token: string) => {
      const variable = /^\$\{?(\w+)\}?$/.exec(token)?.[1];
      return variable ? loops.get(variable) === true : isCandidate(workspacePath(token));
    };
    const publishes = (tokens: string[]) => {
      const targets = operands(tokens);
      return targets.length > 0 && targets.every(candidate);
    };
    for (let tokens of commandSegments(run)) {
      if (tokens[0] === "do") tokens = tokens.slice(1);
      const [command = "", ...rest] = tokens;
      const args = operands(rest);
      let allowed = false;
      let target = true;
      if (command === "done" && !rest.length) allowed = true;
      else if (command === "for" && rest[1] === "in" && /^\w+$/.test(rest[0] ?? "")) {
        const items = rest.slice(2);
        loops.set(
          rest[0]!,
          items.length > 0 && items.every((item) => isCandidate(workspacePath(item))),
        );
        allowed = true;
      } else if (
        command === "set" &&
        rest.every((token) => /^(?:[-+][euxo]+|pipefail)$/.test(token))
      )
        allowed = true;
      else if (
        command === "echo" ||
        (command === "corepack" && canonicalJson(rest) === '["enable"]')
      )
        allowed = true;
      else if (["ls", "sha256sum", "sha512sum", "shasum"].includes(command))
        allowed = args.every(
          (arg) => isCandidate(workspacePath(arg)) || workspacePath(arg) === downloadPath,
        );
      else if (command === "git")
        allowed =
          (rest[0] === "config" &&
            /^user\.(?:name|email)$/.test(rest[1] ?? "") &&
            rest.length === 3) ||
          rest[0] === "tag" ||
          (rest[0] === "push" &&
            rest.every((token) => !token.includes(":") || token === "--follow-tags"));
      else if (
        (command === "npm" &&
          /^(?:i|install)$/.test(args[0] ?? "") &&
          rest.some((token) => /^(?:-g|--global)$/.test(token))) ||
        (/^pip3?$/.test(command) && args[0] === "install") ||
        (/^python3?$/.test(command) &&
          rest[0] === "-m" &&
          rest[1] === "pip" &&
          args[1] === "install")
      ) {
        const packages = args.slice(command.startsWith("python") ? 2 : 1);
        allowed = packages.length > 0 && packages.every((token) => PUBLISHER_TOOL.test(token));
      } else if (context.ecosystem === "npm" && ["npm", "pnpm"].includes(command)) {
        const publish =
          rest[0] === "publish" ? 1 : rest[0] === "stage" && rest[1] === "publish" ? 2 : 0;
        allowed = publish > 0;
        target = publishes(rest.slice(publish));
      } else if (
        context.ecosystem === "pypi" &&
        (command === "twine" ||
          (/^python3?$/.test(command) && rest[0] === "-m" && rest[1] === "twine"))
      ) {
        const sub = command === "twine" ? rest : rest.slice(2);
        allowed = sub[0] === "upload";
        target = publishes(sub.slice(1));
      } else if (context.ecosystem === "pypi" && command === "uv" && rest[0] === "publish") {
        allowed = true;
        target = operands(rest.slice(1)).length
          ? publishes(rest.slice(1))
          : downloadPath === "dist";
      } else if (
        context.ecosystem === "vscode" &&
        (["vsce", "ovsx"].includes(command) || command === "npx")
      ) {
        const sub =
          command === "npx" ? rest.filter((token) => !/^(?:-y|--yes)$/.test(token)) : rest;
        const tool = command === "npx" ? sub[0] : command;
        const args = command === "npx" ? sub.slice(1) : sub;
        allowed =
          /^(?:vsce|ovsx|@vscode\/vsce|ovsx)(?:@[A-Za-z0-9.^~_-]+)?$/.test(tool ?? "") &&
          args[0] === "publish";
        const packageFlag = args.findIndex((token) => token === "--packagePath" || token === "-i");
        const paths = [
          ...operands(args.slice(1)),
          ...(packageFlag >= 0 ? [args[packageFlag + 1] ?? ""] : []),
        ];
        target = paths.length > 0 && paths.every(candidate);
      } else if (["node", "python", "python3", "bash", "sh"].includes(command)) {
        // A reviewed script from the checkout, invoked directly: interpreter flags (-e, -c,
        // --require, -m) would run code that is not a reviewed file.
        const script = workspacePath(rest[0] ?? "");
        allowed = Boolean(script?.startsWith(".github/")) && !rest[0]!.startsWith("-");
        if (allowed && (checkoutIndex < 0 || checkoutIndex > index))
          result.push(`check out the repository before running ${script}.`);
      }
      if (!allowed)
        result.push(
          `${command} is not a setup, checksum, tagging, publisher, or reviewed .github/ script command.`,
        );
      else if (!target)
        result.push(
          `publish the downloaded candidates under ${downloadPath || "the download path"}/.`,
        );
    }
    return result;
  }

  jobSteps.forEach((step, index) => {
    const label = `${where} step ${index + 1}`;
    issues.push(...loaderEnvIssues(step.env, context.originalEnv, label));
    if (step["working-directory"] !== undefined)
      issues.push(`${label}: run from the workspace root.`);
    if (step.shell !== undefined && !(typeof step.shell === "string" && SHELLS.has(step.shell)))
      issues.push(`${label}: use a standard shell.`);
    const stepWith = isRecord(step.with) ? step.with : {};
    let commands = typeof step.run === "string" ? [step.run] : [];
    if (typeof step.uses === "string") {
      const identity = actionIdentity(step.uses);
      const inputs = PROTECTED_INPUTS[identity];
      // Other actions the original workflows trusted run only exactly as the original ran them.
      const original = context.originalSteps.has(
        canonicalJson({ uses: step.uses.trim(), with: step.with ?? null }),
      );
      if (!inputs && !original)
        issues.push(`${label}: ${identity} cannot run with the protected job's credentials.`);
      else if (inputs && Object.keys(stepWith).some((key) => !inputs.has(key)))
        issues.push(`${label}: ${identity} takes only ${[...inputs].join(", ")} here.`);
      if (
        identity === "pnpm/action-setup" &&
        stepWith.run_install !== undefined &&
        stepWith.run_install !== false &&
        stepWith.run_install !== "false"
      )
        issues.push(`${label}: install dependencies before the protected job.`);
      if (identity === "pypa/gh-action-pypi-publish") {
        const directory = workspacePath(String(stepWith["packages-dir"] ?? "dist/"))?.replace(
          /\/+$/,
          "",
        );
        if (directory !== downloadPath)
          issues.push(
            `${label}: publish the downloaded candidates from ${downloadPath || "the download path"}.`,
          );
      }
      // changesets/action runs its publish input as a shell command.
      if (identity === "changesets/action" && typeof stepWith.publish === "string")
        commands = [stepWith.publish];
    }
    for (const command of commands)
      for (const issue of commandIssues(command, index)) issues.push(`${label}: ${issue}`);
  });
  if (downloadIndex >= 0 && checkoutIndex > downloadIndex)
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
      file.originalContent !== null ||
      !SUPPORTING_FILE.test(file.path) ||
      actionDirectories.some((directory) => file.path.startsWith(directory))
    )
      issues.push(
        `${file.path}: supporting changes are new .mjs, .cjs, .js, .sh, .py, or .json files under .github/ outside workflows and actions; existing and other repository files can run in CI, hooks, or package managers before review.`,
      );
  }
  // Only the selected workflow's own source establishes a secret for it; documentation the
  // agent read, and secrets other workflows use for unrelated purposes, do not.
  // GITHUB_TOKEN is the run's own token, not a stored secret.
  const originalSecrets = new Set([
    "GITHUB_TOKEN",
    ...(selected.originalContent === null ? [] : workflowSecretNames(selected.originalContent)),
  ]);
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
  const originalSteps = new Set<string>();
  for (const file of Object.values(state.files))
    if (file.originalContent !== null && /^\.github\/workflows\/[^/]+\.ya?ml$/.test(file.path))
      try {
        const original = workflow(file.originalContent);
        for (const reference of actionReferences(original)) {
          originalReferences.add(reference);
          trustedActions.add(actionIdentity(reference));
        }
        for (const job of Object.values(jobsOf(original))) {
          if (!isRecord(job)) continue;
          for (const image of images(job)) originalImages.add(image);
          for (const step of steps(job))
            if (typeof step.uses === "string")
              originalSteps.add(canonicalJson({ uses: step.uses.trim(), with: step.with ?? null }));
        }
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
      const triggers = strings(after.on);
      if (REVIEW_EVENTS.some((event) => triggers.includes(event)))
        issues.push(
          `${file.path}: review events run this workflow from the pull request before review; set up this workflow manually.`,
        );
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
    const originalHosts = before ? urlHosts(strings(before).join("\n")) : new Set<string>();
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
      if (!protectedJob && !unchanged && registryTokenUse(job))
        issues.push(`${where}: registry credentials belong only to the protected job.`);
      if (!protectedJob) continue;
      const originalJob = originalJobs[jobId];
      if (
        !unchanged &&
        !(
          isRecord(originalJob) &&
          canonicalJson(originalJob["runs-on"]) === canonicalJson(job["runs-on"])
        ) &&
        !(
          typeof job["runs-on"] === "string" &&
          /^(?:ubuntu|windows|macos)-(?:latest|\d[\w.-]*)$/.test(job["runs-on"])
        )
      )
        issues.push(`${where}: run the protected job on a GitHub-hosted runner label.`);
      const jobIssues = protectedJobIssues(job, {
        where,
        artifactName,
        ecosystem: state.request.ecosystem,
        originalSteps,
        originalEnv,
        originalHosts,
        workflowDefaults: after.defaults,
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
      // An unchanged protected job that neither publishes nor holds OIDC is the maintainer's
      // own (for example a deployment); anything that can release must meet the contract.
      else if (
        !unchanged ||
        steps(job).some(publisher) ||
        registryTokenUse(job) ||
        grantsIdToken(job.permissions !== undefined ? job.permissions : after.permissions)
      )
        issues.push(...jobIssues);
    }
  }
  if (!gateFound)
    issues.push(
      "Provide a literal protected publish environment, matching current-run artifact download, and an upstream candidate upload.",
    );
  return { valid: issues.length === 0, issues: issues.slice(0, 12) };
}
