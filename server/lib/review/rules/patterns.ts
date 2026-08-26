import type { CodePatternSet } from "..";

export const CONSUMER_INSTALL_LIFECYCLE_SCRIPTS = ["preinstall", "install", "postinstall"];

// An interpreter handed a command string instead of an argv vector. Real build
// tooling does this constantly, so it stays inside process-execution — the
// weak-on-its-own capability — exactly as it did before the remote-shell split.
const SHELL_INTERPRETER_PATTERNS = [
  /\b(?:ba|z|k|da)?sh\s+-c\b/,
  /\bpowershell\s/i,
  /\bpwsh\s/i,
  /\bcmd(?:\.exe)?\s+\/c\b/i,
];
const JS_PROCESS_EXECUTION_PATTERNS = [
  /\bchild_process\b/,
  /\bexecSync\b/,
  /\bexecFileSync\b/,
  /\bspawn\(/,
  /\bspawnSync\(/,
  ...SHELL_INTERPRETER_PATTERNS,
];
const PYTHON_PROCESS_EXECUTION_PATTERNS = [
  /\bsubprocess\b/,
  /\bos\.system\s*\(/,
  /\bos\.popen\s*\(/,
  /\bPopen\s*\(/,
  /\bpty\.spawn\s*\(/,
  /\bcommands\.getoutput\s*\(/,
];

// Shell *commands*, not spawn *APIs*. The process-execution patterns above match
// the language-level call that starts a subprocess; these match the command
// string handed to it. The distinction matters because a lone process spawn is
// weak evidence (build tooling shells out constantly) while a shell command that
// reaches the *network* is not — and neither the JS nor the Python network
// patterns can see it, because both model in-language APIs. So
// `execSync('curl … | bash')` used to score as a single weak capability and the
// whole release rolled up to low.
//
// Command strings are language-agnostic, so both ecosystems share these sets.
const SHELL_NETWORK_TOOL_PATTERNS = [
  /\bcurl\s/,
  /\bwget\s/,
  // `nc` requires a flag. Bare `\bnc\s` reads a two-letter identifier as a
  // reverse shell: `nc` is a ubiquitous variable name in scientific Python
  // (`nc = netCDF4.Dataset(...)`), and no real netcat invocation omits flags.
  /\bnc\s+-\w/,
  /\bnetcat\s/,
  // bash's virtual TCP device: `exec 3<>/dev/tcp/host/port` is the dependency-
  // free reverse-shell primitive when curl/nc are unavailable.
  /\/dev\/tcp\//,
  /\bInvoke-WebRequest\b/i,
  // Case-sensitive and call-shaped. PowerShell's is `(New-Object
  // Net.WebClient).DownloadString(...)`; a case-insensitive bare word also
  // matched the common JavaScript `downloadString(text, filename)` helper.
  /\.DownloadString\s*\(/,
];
// Download-and-execute: a network tool composed with an interpreter in one
// command. Unlike a bare shell tool there is no benign reading of these — a
// release that adds one is fetching and running code it did not ship.
const SHELL_DOWNLOAD_EXECUTE_PATTERNS = [
  // The interpreter may sit behind any number of intermediate pipe stages
  // (`| base64 -d | bash`, `| gunzip | sh` — the standard obfuscated forms), an
  // absolute path (`| /bin/bash`), and a privilege/environment prefix
  // (`| sudo -E bash`, `| env bash`). The trailing `\b` is what keeps
  // `| sha256sum` and `| shasum` out.
  /\b(?:curl|wget)\b[^\n;&]*\|\s*(?:(?:sudo|env|command|exec|xargs)(?:\s+-{1,2}\w+)*\s+)*(?:\S*\/)?(?:ba|z|k|da)?sh\b/i,
  /\b(?:curl|wget)\b[^\n;&]*\|\s*(?:(?:sudo|env|command|exec|xargs)(?:\s+-{1,2}\w+)*\s+)*(?:\S*\/)?(?:python[\d.]*|perl|ruby|node)\b/i,
  /\$\(\s*(?:curl|wget)\b/i,
  /<\(\s*(?:curl|wget)\b/i,
  // Backtick command substitution: `` eval `curl -s https://x` ``.
  /`\s*(?:curl|wget)\b/i,
  /\bnc\s[^\n]*\s-e\s/,
  /(?:\bInvoke-WebRequest\b|\.DownloadString\s*\(|\biwr\b)[^\n]*\|\s*(?:iex|Invoke-Expression)\b/i,
  /\bpowershell\b[^\n]*\s-(?:enc|EncodedCommand)\b/i,
];
const SHELL_REMOTE_PATTERNS = [...SHELL_NETWORK_TOOL_PATTERNS, ...SHELL_DOWNLOAD_EXECUTE_PATTERNS];

// Exported for the risk layer: a shell network tool is an egress sink for the
// credential collect-and-exfiltrate chain exactly like `fetch()` is.
export const SHELL_NETWORK_TOOL_PATTERN_SET = SHELL_NETWORK_TOOL_PATTERNS;
export const SHELL_DOWNLOAD_EXECUTE_PATTERN_SET = SHELL_DOWNLOAD_EXECUTE_PATTERNS;
const JS_NETWORK_ACCESS_PATTERNS = [
  /\brequire\(["'](?:node:)?(?:http|https|net|dns)["']\)/,
  /\bfrom\s+["'](?:node:)?(?:http|https|net|dns)["']/,
  /\b(?:global|globalThis|self|window)\.fetch\s*\(/,
  /(?<![\w$.])fetch\s*\((?![^\n;]*\)\s*\{)/,
  /\bXMLHttpRequest\b/,
  /\baxios\s*\./,
];
const PYTHON_NETWORK_ACCESS_PATTERNS = [
  /\burllib\.request\b/,
  /\brequests\.(?:get|post|put|patch|delete|request)\b/,
  /\bhttp\.client\b/,
  /\bhttplib\b/,
  /\bsocket\.socket\s*\(/,
  /\bftplib\b/,
  /\bsmtplib\b/,
  /\burlopen\s*\(/,
];
const JS_DYNAMIC_EVALUATION_PATTERNS = [
  /\beval\s*\(/,
  /\bnew\s+Function\s*\(/,
  // `node -e` is an interpreter-backed eval even when launched through the
  // child-process API instead of JavaScript's in-process eval primitives.
  /\bspawn(?:Sync)?\s*\(\s*["'`]node(?:js)?["'`]\s*,\s*\[\s*["'`](?:-e|--eval)["'`]/,
  // The whole compile/instantiate family: instantiate(Streaming) — not bare
  // compile — is the loader idiom packed wasm payloads actually use (typically
  // `WebAssembly.instantiateStreaming(fetch(...))`).
  /\bWebAssembly\.(?:compile|compileStreaming|instantiate|instantiateStreaming)\s*\(/,
  // require.resolve( was evaluated as a candidate here and rejected: it only
  // resolves a path (never executes code) and is the standard jest/babel/webpack
  // preset idiom, so it flagged the legit-require-resolve benign hard-negative.
  /\batob\s*\(/,
  /\bBuffer\.from\s*\([^,]+,\s*["']base64["']\s*\)/,
];
const PYTHON_DYNAMIC_EVALUATION_PATTERNS = [
  /(?<!\.)\bexec\s*\(/,
  /\b__import__\s*\(/,
  /\bimportlib\.import_module\s*\(/,
  /\bmarshal\.loads\s*\(/,
  /(?<!\.)\bcompile\s*\(/,
  /\bbase64\.b(?:64|32|16)decode\s*\(/,
  /\bzlib\.decompress\s*\(/,
  /\blzma\.decompress\s*\(/,
  /\bcodecs\.decode\s*\(/,
  /\bbytes\.fromhex\s*\(/,
];
const JS_CREDENTIAL_ACCESS_PATTERNS = [
  /\bprocess\.env\b/,
  /\bnpm_config_/,
  /\bNPM_TOKEN\b/,
  /\bGITHUB_TOKEN\b/,
  /\bAWS_SECRET\b/,
  /\bPRIVATE_KEY\b/,
  // Sensitive credential file paths read directly from disk. The Python set
  // already covers these; JS code that reads them (e.g.
  // `fs.readFileSync(os.homedir() + '/.aws/credentials')`) is the same
  // credential-theft capability and was previously an unmodeled gap.
  /\.aws\/credentials/,
  /\.ssh\/id_/,
  /\.netrc/,
];
const PYTHON_CREDENTIAL_ACCESS_PATTERNS = [
  /\bos\.environ\b/,
  /\bos\.getenv\s*\(/,
  /\bgetpass\b/,
  /\bkeyring\b/,
  /\.aws\/credentials/,
  /\.ssh\/id_/,
  /\.netrc/,
];

// Self-propagation: the primitives a payload needs to put itself into the *next*
// artifact rather than only into the machine it landed on. Publishing to a
// registry and rewriting the packages already installed alongside this one are
// both ordinary developer actions in the right place — a release CLI, a patch
// tool — so the propagation rules gate on install-time reachability instead of
// trying to tell those apart by pattern. See `propagation.ts`.
// The separator class covers both the shell form (`npm publish`) and the argv
// form a spawn call uses (`["npm", "publish"]`), which is the same command.
const JS_REGISTRY_PUBLISH_PATTERNS = [
  /\b(?:npm|pnpm|yarn|bun)\b["'\s,[\]]{1,12}publish\b/,
  /\bnpm\b["'\s,[\]]{1,12}stage["'\s,[\]]{1,12}(?:publish|approve)\b/,
  /\bnpm\b["'\s,[\]]{1,12}dist-tag["'\s,[\]]{1,12}add\b/,
  /\blibnpmpublish(?:\.publish)?\s*\(/,
];
const PYTHON_REGISTRY_PUBLISH_PATTERNS = [
  /\btwine\b["'\s,[\]]{1,12}upload\b/,
  /\btwine\.commands\.upload(?:\.upload)?\s*\(/,
  /\bsetup\.py\b[^\n]*\bupload\b/,
];
// The directory a package manager unpacks dependencies into. A path literal
// naming it is what separates "this package writes files" (every build tool)
// from "this package writes into its neighbours".
const JS_INSTALL_ROOT_PATH_PATTERNS = [/\bnode_modules\b/];
const PYTHON_INSTALL_ROOT_PATH_PATTERNS = [/\bsite-packages\b/, /\bdist-packages\b/];
const JS_INSTALL_WRITE_PATTERNS = [
  /\b(?:writeFile|appendFile|copyFile|outputFile)(?:Sync)?\s*\(/,
  /\bcreateWriteStream\s*\(/,
  /\bcpSync\s*\(/,
];
const PYTHON_INSTALL_WRITE_PATTERNS = [
  /\bopen\s*\([^)\n]*["'][wax]b?\+?["']/,
  /\bshutil\.(?:copy|copy2|copyfile|copytree|move)\s*\(/,
  /\.write_(?:text|bytes)\s*\(/,
];

export const JS_PATTERN_SET = {
  processExecution: JS_PROCESS_EXECUTION_PATTERNS,
  remoteShell: SHELL_REMOTE_PATTERNS,
  networkAccess: JS_NETWORK_ACCESS_PATTERNS,
  dynamicEvaluation: JS_DYNAMIC_EVALUATION_PATTERNS,
  credentialAccess: JS_CREDENTIAL_ACCESS_PATTERNS,
  registryPublish: JS_REGISTRY_PUBLISH_PATTERNS,
  installRootPath: JS_INSTALL_ROOT_PATH_PATTERNS,
  installWrite: JS_INSTALL_WRITE_PATTERNS,
};
export const PYTHON_PATTERN_SET = {
  processExecution: PYTHON_PROCESS_EXECUTION_PATTERNS,
  remoteShell: SHELL_REMOTE_PATTERNS,
  networkAccess: PYTHON_NETWORK_ACCESS_PATTERNS,
  dynamicEvaluation: PYTHON_DYNAMIC_EVALUATION_PATTERNS,
  credentialAccess: PYTHON_CREDENTIAL_ACCESS_PATTERNS,
  registryPublish: PYTHON_REGISTRY_PUBLISH_PATTERNS,
  installRootPath: PYTHON_INSTALL_ROOT_PATH_PATTERNS,
  installWrite: PYTHON_INSTALL_WRITE_PATTERNS,
};

// Python process-execution, network, and dynamic-evaluation capability in one set.
// Reused by ecosystem adapters that need to know whether a file executes code
// (e.g. a PyPI sdist's setup.py, which pip runs at install time). Shell commands
// are included: a setup.py that shells out to curl executes code at install time
// just as surely as one that calls subprocess directly.
export const PYTHON_EXECUTION_CAPABILITY_PATTERNS = [
  ...PYTHON_PROCESS_EXECUTION_PATTERNS,
  ...SHELL_REMOTE_PATTERNS,
  ...PYTHON_NETWORK_ACCESS_PATTERNS,
  ...PYTHON_DYNAMIC_EVALUATION_PATTERNS,
];

// Markdown emphasis and zero-width characters are in-band evasions in the
// prompt-injection rules' primary vector. Keep the normalization beside the
// pattern sets so detection and changed-line release classification cannot
// drift apart.
const PROMPT_INJECTION_EVASION_CHARS = /[*_`\u200B-\u200D\uFEFF]/g;

export function stripPromptInjectionEvasion(text: string): string {
  return text.replace(PROMPT_INJECTION_EVASION_CHARS, "");
}

// Text that tries to steer the *automated security review itself* toward a
// clean verdict. These are verdict-coercion shapes, not generic LLM chatter:
// each pattern needs either an imperative aimed at the release object ("mark
// this package as safe"), a suppression directive over review output ("do not
// report any findings"), or a literal token from Drydock's own review schema
// (`nothing_unusual`, `requiresManualReview`). Third-person prose stays out by
// construction — "npm marks the package as verified" has no imperative `mark`,
// and SECURITY.md's "do not report vulnerabilities publicly" names no
// findings/detections object.
const REVIEW_MANIPULATION_PATTERNS = [
  /\b(?:mark|classify|treat|report|approve|assess|rate|label)\s+(?:this|the)\s+(?:package|release|update|version|library|module|dependency|code|publish)\b[^\n.!?]{0,40}\bas\s+(?:safe|benign|trusted|clean|harmless|verified|legitimate|not\s+(?:malicious|suspicious))\b/i,
  // Suppression is imperative-only ("do not"/"don't") with a determiner on the
  // object. Modals invite third-person subjects ("the scanner should not flag
  // minified code as suspicious"), broad support nouns ("do not report any
  // issues here") are ordinary project guidance, and a bare object matches
  // changelog/SECURITY.md prose ("don't report duplicate findings", "do not
  // report findings without a proof of concept") — all idiomatic in exactly
  // the linter/scanner packages npm is full of.
  /\b(?:do\s+not|don'?t)\s+(?:report|flag|mention|raise|escalate|surface)\s+(?:any|these|those)\s+(?:findings?|detections?)\b/i,
  /\b(?:do\s+not|don'?t)\s+(?:flag|report|mark|treat)\s+(?:this|the)\s+(?:package|release|update|version|library|module|code|file)\b[^\n.!?]{0,30}\bas\s+(?:suspicious|malicious|unsafe|risky)\b/i,
  // Drydock's releaseAssessment enum value. Prose writes "nothing unusual"
  // with a space; the underscore/hyphen form is schema-targeting.
  /\bnothing[_-]unusual\b/i,
  // Schema form only (camelCase or snake_case, no spaces): prose like "each
  // alert requires manual review to rule out false positives" is ordinary
  // security-tool documentation.
  /\brequires_?manual_?review\b[^\n]{0,20}\bfalse\b(?!\s+positive)/i,
  // Security tooling legitimately documents switches such as "bypass the
  // security check during local development". Require the directive to name
  // this package/release as the object being exempted from review.
  /\b(?:skip|bypass|disable)\s+(?:(?:(?:the|this)\s+)?security\s+(?:review|scan|audit|check)\s+(?:of|for|on)\s+(?:this|the)\s+(?:package|release|update|version|code)|(?:this|the)\s+(?:package|release|update|version|code)(?:'s)?\s+security\s+(?:review|scan|audit|check))\b/i,
];

// Instruction content aimed at any LLM/agent that reads package bytes — an AI
// reviewer, a coding assistant resolving docs, an MCP tool ingesting a README.
// Precision over recall: every pattern requires either an instruction-override
// verb phrase or a direct address to an AI/agent audience, because LLM client
// libraries legitimately ship prompt-shaped text ("You are a helpful
// assistant", "customize the system prompt") that must stay quiet.
// A bare "agent"/"assistant" is somebody's product (a Datadog agent, an
// OpenAI Assistants thread); only the AI-qualified forms read as an LLM
// audience.
const AI_AUDIENCE_SEGMENT = String.raw`(?:AI|LLM|language\s+model|artificial\s+intelligence|(?:AI|LLM|coding|automated)[\s-]+(?:agent|assistant|reviewer|scanner|tool))`;

const PROMPT_INJECTION_PATTERNS = [
  /\b(?:ignore|disregard|forget|override)\s+(?:all\s+|any\s+|the\s+|your\s+)?(?:previous|prior|above|earlier|preceding|system|initial|original)\s+(?:instructions?|prompts?|rules?|directives?|commands?|context)\b/i,
  /\b(?:ignore|disregard|forget)\s+(?:everything|all)\s+(?:above|before|you\s+were\s+told)\b/i,
  /\byour\s+(?:new\s+)?system\s+prompt\s+is\b/i,
  /\b(?:replace|overwrite)\s+your\s+system\s+prompt\b/i,
  // The conditional address alone also greets humans ("if you are an AI
  // researcher, see the docs"), so it must be followed by a directive clause.
  new RegExp(
    String.raw`\bif\s+you\s+are\s+an?\s+${AI_AUDIENCE_SEGMENT}\b[^\n.!?]{0,60}\b(?:ignore|disregard|follow|obey|must|should|do\s+not|don'?t|stop|instead|reply|respond|output|run|execute|add|include)\b`,
    "i",
  ),
  new RegExp(
    String.raw`\b(?:note|message|attention|instructions?|important)\s+(?:to|for)\s+(?:the\s+|all\s+|any\s+)?${AI_AUDIENCE_SEGMENT}s?\b`,
    "i",
  ),
  /\bas\s+an?\s+(?:AI|LLM|language\s+model)\b[^\n.!?]{0,60}\byou\s+(?:must|should|will|have\s+to|are\s+required)\b/i,
  /\byou\s+are\s+now\s+in\s+(?:developer|DAN|jailbreak|unrestricted|god)\s+mode\b/i,
  /\bdo\s+not\s+(?:tell|inform|alert|warn)\s+the\s+(?:user|human|operator|developer)\b/i,
];

export const REVIEW_MANIPULATION_PATTERN_SET = REVIEW_MANIPULATION_PATTERNS;
export const PROMPT_INJECTION_PATTERN_SET = PROMPT_INJECTION_PATTERNS;

// Doc-style placeholder passwords (`http://user:pass@proxy.example`,
// `https://alice:<token>@host`) are ubiquitous in READMEs and changelogs —
// requests' CVE-2023-32681 HISTORY entry is the canonical benign hit — and are
// not leaked material. The finding-side pattern refuses a match in two tiers:
// structural placeholders (template syntax, masks, canonical fakes) are never
// secrets regardless of the username, while bare weak words ("pass", "secret",
// "token", "admin") only count as placeholders when the username is itself a
// placeholder word — `svc:secret@db` or `root:admin@host` is a real (if weak)
// connection-string credential and keeps flagging. Redaction keeps the broad
// pattern, since over-redacting a placeholder is harmless while under-redacting
// a real credential is not.
const URL_CREDENTIALS_REDACTION_PATTERN = /\b(?:[A-Za-z]+:\/\/)[^\s/@:]+:[^\s/@]+@[^\s'"\\]+/g;
const PLACEHOLDER_USERNAME_SEGMENT = [
  "user(?:name)?",
  "usr",
  "foo",
  "bar",
  "alice",
  "bob",
  "me",
  "test",
  "demo",
  "example",
].join("|");
const WEAK_WORD_PASSWORD_SEGMENT = [
  "pass(?:word|wd)?",
  "pwd",
  "secret",
  "token",
  "example",
  "admin",
].join("|");
const STRUCTURAL_PLACEHOLDER_SEGMENT = [
  "changeme",
  "hunter2",
  "(?:your|my)[-_]?(?:password|token|secret|key)",
  "x{3,}",
  "\\*{3,}",
  "<[^>@\\s]*>",
  "\\{[^}@\\s]*\\}",
  "\\$\\{[^}@\\s]*\\}",
  "\\$[A-Za-z_][A-Za-z0-9_]*",
  "%[^%@\\s]+%",
].join("|");
const URL_CREDENTIALS_FINDING_PATTERN = new RegExp(
  String.raw`\b(?:[A-Za-z]+:\/\/)(?!(?:${PLACEHOLDER_USERNAME_SEGMENT}):(?:${WEAK_WORD_PASSWORD_SEGMENT}|${STRUCTURAL_PLACEHOLDER_SEGMENT})@|[^\s/@:]+:(?:${STRUCTURAL_PLACEHOLDER_SEGMENT})@)[^\s/@:]+:[^\s/@]+@[^\s'"\\]+`,
  "gi",
);

export const SECRET_PATTERNS: Array<[RegExp, string]> = [
  [/npm_[A-Za-z0-9]{20,}/g, "[REDACTED_NPM_TOKEN]"],
  [/gh[pousr]_[A-Za-z0-9_]{20,}/g, "[REDACTED_GITHUB_TOKEN]"],
  [/github_pat_[A-Za-z0-9_]{20,}/g, "[REDACTED_GITHUB_TOKEN]"],
  [/AKIA[0-9A-Z]{16}/g, "[REDACTED_AWS_ACCESS_KEY]"],
  [/ASIA[0-9A-Z]{16}/g, "[REDACTED_AWS_SESSION_KEY]"],
  [/AIza[0-9A-Za-z\-_]{35}/g, "[REDACTED_GOOGLE_API_KEY]"],
  [/ya29\.[0-9A-Za-z\-_]{20,}/g, "[REDACTED_GOOGLE_OAUTH_TOKEN]"],
  [/sk_(?:live|test)_[0-9a-zA-Z]{16,}/g, "[REDACTED_STRIPE_KEY]"],
  [/rk_(?:live|test)_[0-9a-zA-Z]{16,}/g, "[REDACTED_STRIPE_KEY]"],
  [/xox[abprs]-[A-Za-z0-9-]{10,}/g, "[REDACTED_SLACK_TOKEN]"],
  [/https:\/\/hooks\.slack\.com\/services\/[A-Za-z0-9/]+/g, "[REDACTED_SLACK_WEBHOOK]"],
  [/eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, "[REDACTED_JWT]"],
  [URL_CREDENTIALS_REDACTION_PATTERN, "[REDACTED_URL_WITH_CREDENTIALS]"],
  [
    /-----BEGIN (?:RSA |OPENSSH |EC |DSA |PGP |ENCRYPTED )?PRIVATE KEY(?: BLOCK)?-----[\s\S]*?-----END (?:RSA |OPENSSH |EC |DSA |PGP |ENCRYPTED )?PRIVATE KEY(?: BLOCK)?-----/g,
    "[REDACTED_PRIVATE_KEY]",
  ],
  [/(authorization\s*[:=]\s*)['"]?Bearer\s+[A-Za-z0-9._\-+/=]{16,}/gi, "$1[REDACTED_BEARER]"],
  ...genericSecretPatterns(),
];

// Detection-side view of SECRET_PATTERNS: identical except the URL-credentials
// pattern requires a non-placeholder password. Redaction stays on the broad set.
export const FINDING_SECRET_PATTERNS: Array<[RegExp, string]> = SECRET_PATTERNS.map(
  ([pattern, label]) =>
    pattern === URL_CREDENTIALS_REDACTION_PATTERN
      ? [URL_CREDENTIALS_FINDING_PATTERN, label]
      : [pattern, label],
);

export const HIGH_CONFIDENCE_SECRET_PATTERNS: Array<[RegExp, string]> =
  FINDING_SECRET_PATTERNS.slice(0, -1);

function genericSecretPatterns(): Array<[RegExp, string]> {
  return [
    [
      /(?<![A-Za-z0-9])((?:secret|token|password|passwd|pwd|api[_-]?key|access[_-]?key|client[_-]?secret)\s*[:=]\s*)['"]?[^'"\s()]{12,}(?=$|[\s'",;}\]])/gi,
      "$1[REDACTED_SECRET]",
    ],
  ];
}

export function codePatternsFor(codePatternSet: CodePatternSet | undefined): typeof JS_PATTERN_SET {
  return codePatternSet === "python" ? PYTHON_PATTERN_SET : JS_PATTERN_SET;
}
