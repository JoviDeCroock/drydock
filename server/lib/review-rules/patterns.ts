import type { CodePatternSet } from "../review";

export const CONSUMER_INSTALL_LIFECYCLE_SCRIPTS = ["preinstall", "install", "postinstall"];

const JS_PROCESS_EXECUTION_PATTERNS = [
  /\bchild_process\b/,
  /\bexecSync\b/,
  /\bexecFileSync\b/,
  /\bspawn\(/,
  /\bspawnSync\(/,
  /\bcurl\s/,
  /\bwget\s/,
  /\bnc\s/,
  /\bbash\s+-c/,
  /\bpowershell\s/,
];
const PYTHON_PROCESS_EXECUTION_PATTERNS = [
  /\bsubprocess\b/,
  /\bos\.system\s*\(/,
  /\bos\.popen\s*\(/,
  /\bPopen\s*\(/,
  /\bpty\.spawn\s*\(/,
  /\bcommands\.getoutput\s*\(/,
];
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
const RUBY_PROCESS_EXECUTION_PATTERNS = [
  /\bOpen3\b/,
  /\bIO\.popen\s*\(/,
  /\bKernel\.(?:system|exec|spawn)\b/,
  /(?<![\w.:])system\s*\(/,
  /(?<![\w.:])exec\s*\(/,
  /(?<![\w.:])spawn\s*\(/,
  /%x[({[<]/,
  /\bPTY\.spawn\s*\(/,
];
const RUBY_NETWORK_ACCESS_PATTERNS = [
  /\bNet::HTTP\b/,
  /\brequire\s+["']open-uri["']/,
  /\bOpenURI\b/,
  /\bURI\.open\s*\(/,
  /\bTCPSocket\b/,
  /\bUDPSocket\b/,
  /\bSocket\.new\s*\(/,
  /\bNet::FTP\b/,
  /\bNet::SMTP\b/,
];
const RUBY_DYNAMIC_EVALUATION_PATTERNS = [
  /(?<![\w.:])eval\s*\(/,
  /\binstance_eval\b/,
  /\bclass_eval\b/,
  /\bmodule_eval\b/,
  /\bRubyVM::InstructionSequence\b/,
  /\bMarshal\.load\b/,
  /\bBase64\.(?:decode64|strict_decode64|urlsafe_decode64)\s*\(/,
  /\bunpack1?\s*\(\s*["']m/,
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
const RUBY_CREDENTIAL_ACCESS_PATTERNS = [
  /\bENV\[/,
  /\bENV\.fetch\s*\(/,
  /\bGITHUB_TOKEN\b/,
  /\bGEM_HOST_API_KEY\b/,
  /\.gem\/credentials/,
  /\.aws\/credentials/,
  /\.ssh\/id_/,
  /\.netrc/,
];

export const JS_PATTERN_SET = {
  processExecution: JS_PROCESS_EXECUTION_PATTERNS,
  networkAccess: JS_NETWORK_ACCESS_PATTERNS,
  dynamicEvaluation: JS_DYNAMIC_EVALUATION_PATTERNS,
  credentialAccess: JS_CREDENTIAL_ACCESS_PATTERNS,
};
export const PYTHON_PATTERN_SET = {
  processExecution: PYTHON_PROCESS_EXECUTION_PATTERNS,
  networkAccess: PYTHON_NETWORK_ACCESS_PATTERNS,
  dynamicEvaluation: PYTHON_DYNAMIC_EVALUATION_PATTERNS,
  credentialAccess: PYTHON_CREDENTIAL_ACCESS_PATTERNS,
};
export const RUBY_PATTERN_SET = {
  processExecution: RUBY_PROCESS_EXECUTION_PATTERNS,
  networkAccess: RUBY_NETWORK_ACCESS_PATTERNS,
  dynamicEvaluation: RUBY_DYNAMIC_EVALUATION_PATTERNS,
  credentialAccess: RUBY_CREDENTIAL_ACCESS_PATTERNS,
};

// Python process-execution, network, and dynamic-evaluation capability in one set.
// Reused by ecosystem adapters that need to know whether a file executes code
// (e.g. a PyPI sdist's setup.py, which pip runs at install time).
export const PYTHON_EXECUTION_CAPABILITY_PATTERNS = [
  ...PYTHON_PROCESS_EXECUTION_PATTERNS,
  ...PYTHON_NETWORK_ACCESS_PATTERNS,
  ...PYTHON_DYNAMIC_EVALUATION_PATTERNS,
];

// Ruby process-execution, network, and dynamic-evaluation capability in one
// set. Reused by ecosystem adapters that need to know whether a file executes
// code (e.g. a gem's extconf.rb, which RubyGems runs at install time).
export const RUBY_EXECUTION_CAPABILITY_PATTERNS = [
  ...RUBY_PROCESS_EXECUTION_PATTERNS,
  ...RUBY_NETWORK_ACCESS_PATTERNS,
  ...RUBY_DYNAMIC_EVALUATION_PATTERNS,
];

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
  [/\b(?:[A-Za-z]+:\/\/)[^\s/@:]+:[^\s/@]+@[^\s'"\\]+/g, "[REDACTED_URL_WITH_CREDENTIALS]"],
  [
    /-----BEGIN (?:RSA |OPENSSH |EC |DSA |PGP |ENCRYPTED )?PRIVATE KEY(?: BLOCK)?-----[\s\S]*?-----END (?:RSA |OPENSSH |EC |DSA |PGP |ENCRYPTED )?PRIVATE KEY(?: BLOCK)?-----/g,
    "[REDACTED_PRIVATE_KEY]",
  ],
  [/(authorization\s*[:=]\s*)['"]?Bearer\s+[A-Za-z0-9._\-+/=]{16,}/gi, "$1[REDACTED_BEARER]"],
  ...genericSecretPatterns(),
];

export const HIGH_CONFIDENCE_SECRET_PATTERNS: Array<[RegExp, string]> = SECRET_PATTERNS.slice(
  0,
  -1,
);

function genericSecretPatterns(): Array<[RegExp, string]> {
  return [
    [
      /(?<![A-Za-z0-9])((?:secret|token|password|passwd|pwd|api[_-]?key|access[_-]?key|client[_-]?secret)\s*[:=]\s*)['"]?[^'"\s()]{12,}(?=$|[\s'",;}\]])/gi,
      "$1[REDACTED_SECRET]",
    ],
  ];
}

export function codePatternsFor(codePatternSet: CodePatternSet | undefined): typeof JS_PATTERN_SET {
  if (codePatternSet === "python") return PYTHON_PATTERN_SET;
  if (codePatternSet === "ruby") return RUBY_PATTERN_SET;
  return JS_PATTERN_SET;
}
