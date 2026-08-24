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
//
// These patterns are deliberately evaluated through the bounded-window helpers
// in `platform/text-utils.ts`. That keeps hostile minified lines from turning
// their greedy spans into parent-Worker CPU exhaustion without imposing a
// padding limit that an attacker can use to evade the rule.
const SHELL_DOWNLOAD_EXECUTE_PATTERNS = [
  // The interpreter may sit behind any number of intermediate pipe stages
  // (`| base64 -d | bash`, `| gunzip | sh` — the standard obfuscated forms), an
  // absolute path (`| /bin/bash`), and a privilege/environment prefix
  // (`| sudo -E bash`, `| env bash`). The trailing `\b` is what keeps
  // `| sha256sum` and `| shasum` out.
  /\b(?:curl|wget)\b[^\n;&]*\|\s*(?:(?:sudo|env|command|exec|xargs)(?:\s+-{1,2}\w+)*\s+)*(?:\/+)?(?:[^\s/]+\/+)*(?:ba|z|k|da)?sh\b/i,
  /\b(?:curl|wget)\b[^\n;&]*\|\s*(?:(?:sudo|env|command|exec|xargs)(?:\s+-{1,2}\w+)*\s+)*(?:\/+)?(?:[^\s/]+\/+)*(?:python[\d.]*|perl|ruby|node)\b/i,
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
  // A large inline payload can put `Buffer.from(` and its encoding argument in
  // different scan windows. Match a base64-shaped tail independently so the
  // bounded matcher still sees packed payloads without handing a regex the
  // whole hostile file body.
  /(?:[A-Za-z0-9+/_=-]\r?\n?){256}["'`]\s*,\s*["']base64["']\s*\)/,
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

export const JS_PATTERN_SET = {
  processExecution: JS_PROCESS_EXECUTION_PATTERNS,
  remoteShell: SHELL_REMOTE_PATTERNS,
  networkAccess: JS_NETWORK_ACCESS_PATTERNS,
  dynamicEvaluation: JS_DYNAMIC_EVALUATION_PATTERNS,
  credentialAccess: JS_CREDENTIAL_ACCESS_PATTERNS,
};
export const PYTHON_PATTERN_SET = {
  processExecution: PYTHON_PROCESS_EXECUTION_PATTERNS,
  remoteShell: SHELL_REMOTE_PATTERNS,
  networkAccess: PYTHON_NETWORK_ACCESS_PATTERNS,
  dynamicEvaluation: PYTHON_DYNAMIC_EVALUATION_PATTERNS,
  credentialAccess: PYTHON_CREDENTIAL_ACCESS_PATTERNS,
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
const PRIVATE_KEY_REDACTION_PATTERN =
  /-----BEGIN (?:RSA |OPENSSH |EC |DSA |PGP |ENCRYPTED )?PRIVATE KEY(?: BLOCK)?-----(?:(?!-----BEGIN (?:RSA |OPENSSH |EC |DSA |PGP |ENCRYPTED )?PRIVATE KEY(?: BLOCK)?-----)[\s\S])*?-----END (?:RSA |OPENSSH |EC |DSA |PGP |ENCRYPTED )?PRIVATE KEY(?: BLOCK)?-----/g;
const PRIVATE_KEY_BEGIN_PATTERN =
  /-----BEGIN (?:RSA |OPENSSH |EC |DSA |PGP |ENCRYPTED )?PRIVATE KEY(?: BLOCK)?-----/g;
const PRIVATE_KEY_END_PATTERN =
  /-----END (?:RSA |OPENSSH |EC |DSA |PGP |ENCRYPTED )?PRIVATE KEY(?: BLOCK)?-----/g;
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
    // The body is a tempered span, not `[\s\S]*?`. The lazy form rescans the
    // whole remainder of the input from every `-----BEGIN` marker, so a file
    // carrying many BEGIN markers and no END is quadratic — and this pattern
    // runs over every retained file body through `redactText`, including on the
    // anonymous /diff path. The tempered body cannot cross a second complete
    // private-key BEGIN marker, so repeated openers partition the work instead
    // of each rescanning the whole remaining file. It still permits arbitrary
    // dashes in PGP armor headers and has no fail-open key-size limit.
    PRIVATE_KEY_REDACTION_PATTERN,
    "[REDACTED_PRIVATE_KEY]",
  ],
  [/(authorization\s*[:=]\s*)['"]?Bearer\s+[A-Za-z0-9._\-+/=]{16,}/gi, "$1[REDACTED_BEARER]"],
  ...genericSecretPatterns(),
];

// Detection-side view of SECRET_PATTERNS: URL credentials require a
// non-placeholder password, while private keys use the ordered marker scan below
// so a delimiter constant alone stays quiet. Redaction stays on the broad set.
export const FINDING_SECRET_PATTERNS: Array<[RegExp, string]> = SECRET_PATTERNS.flatMap(
  ([pattern, label]): Array<[RegExp, string]> =>
    pattern === URL_CREDENTIALS_REDACTION_PATTERN
      ? [[URL_CREDENTIALS_FINDING_PATTERN, label]]
      : pattern === PRIVATE_KEY_REDACTION_PATTERN
        ? []
        : [[pattern, label]],
);

export const HIGH_CONFIDENCE_SECRET_PATTERNS: Array<[RegExp, string]> =
  FINDING_SECRET_PATTERNS.slice(0, -1);

// Detection requires a complete armored block, not merely a delimiter string a
// PEM parser or serializer legitimately embeds. The two marker scans remain
// linear for arbitrarily large keys and mirror the redactor's rule that a
// malformed opener cannot consume a later complete block.
export function firstPrivateKeyBlockIndex(text: string): number | undefined {
  PRIVATE_KEY_BEGIN_PATTERN.lastIndex = 0;
  PRIVATE_KEY_END_PATTERN.lastIndex = 0;
  let begin = PRIVATE_KEY_BEGIN_PATTERN.exec(text);
  let end = PRIVATE_KEY_END_PATTERN.exec(text);
  while (begin) {
    while (end && end.index < begin.index + begin[0].length) {
      end = PRIVATE_KEY_END_PATTERN.exec(text);
    }
    const nextBegin = PRIVATE_KEY_BEGIN_PATTERN.exec(text);
    if (end && (!nextBegin || end.index < nextBegin.index)) return begin.index;
    begin = nextBegin;
  }
  return undefined;
}

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
