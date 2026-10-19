import type { CodePatternSet } from "../types";

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
// A download names something to fetch: a flag, a quoted or variable operand, a
// number, or a host/URL with a dot, slash or colon. A bare word after the tool
// name is prose ("curl is required", "retry with `vercel curl <url>`") or a
// syntax highlighter's keyword table ("cp cpp curl cvpa …").
const SHELL_TOOL_OPERAND = String.raw`(?=[-"'\x60$\\({[]|\d|[\w%@-]*[./:][\w%/.-])`;
const SHELL_NETWORK_TOOL_PATTERNS = [
  new RegExp(String.raw`\bcurl\s+${SHELL_TOOL_OPERAND}`),
  new RegExp(String.raw`\bwget\s+${SHELL_TOOL_OPERAND}`),
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
  // `| sha256sum` and `| shasum` out. A tool name directly followed by `|` or
  // `)` downloads nothing: that is an alternation keyword list
  // (`(?:…|curl|cut|…|zsh)` in a shell grammar), not a pipeline.
  /\b(?:curl|wget)\b(?!\s*[|)])[^\n;&]*\|\s*(?:(?:sudo|env|command|exec|xargs)(?:\s+-{1,2}\w+)*\s+)*(?:\S*\/)?(?:ba|z|k|da)?sh\b/i,
  /\b(?:curl|wget)\b(?!\s*[|)])[^\n;&]*\|\s*(?:(?:sudo|env|command|exec|xargs)(?:\s+-{1,2}\w+)*\s+)*(?:\S*\/)?(?:python[\d.]*|perl|ruby|node)\b/i,
  // Substitution captures data; only an execution consumer makes it remote
  // code execution. Bare $(curl ... | jq), <(curl ...), and backticks also
  // appear in generated docs and JavaScript template strings. Allow escaped
  // delimiters because commands can be nested inside source string literals.
  /(?:\beval(?:\s+--)?|\b(?:ba|z|k|da)?sh\s+(?:--?[a-z-]+\s+)*-[a-z]*c[a-z]*)\s+(?:\\*["'])*\\*(?:\$\(\s*|`\s*)(?:curl|wget)\b/i,
  // These options still read a script path. Options such as -c, -s and -m
  // instead consume a command, stdin or a module; a /dev/fd path is then data.
  /(?:\b(?:source|python[\d.]*|perl|ruby|node)|(?<![\w.])\.|\b(?:ba|z|k|da)?sh(?:\s+-[efuvxE]+)*)\s+(?:--\s+)?<\(\s*(?:curl|wget)\b/,
  // An unquoted substitution in command position runs its output, unlike
  // assignment. Source-string boundaries need a known shell execution API;
  // matching arbitrary quotes here would mistake documentation data for code.
  /(?:^|[\n;|&])\s*\$\(\s*(?:curl|wget)\b/i,
  /\b(?:exec(?:Sync)?|os\.(?:system|popen))\s*\(\s*["'`]\s*(?:\$\(\s*|\\*`\s*)(?:curl|wget)\b/,
  /\bnc\s[^\n]*\s-e\s/,
  /(?:\bInvoke-WebRequest\b|\.DownloadString\s*\(|\biwr\b)[^\n]*\|\s*(?:iex|Invoke-Expression)\b/i,
  /\bpowershell\b[^\n]*\s-(?:enc|EncodedCommand)\b/i,
];
const SHELL_REMOTE_PATTERNS = [...SHELL_NETWORK_TOOL_PATTERNS, ...SHELL_DOWNLOAD_EXECUTE_PATTERNS];

// Exported for the risk layer: a shell network tool is an egress sink for the
// credential collect-and-exfiltrate chain exactly like `fetch()` is.
export const SHELL_NETWORK_TOOL_PATTERN_SET = SHELL_NETWORK_TOOL_PATTERNS;
export const SHELL_DOWNLOAD_EXECUTE_PATTERN_SET = SHELL_DOWNLOAD_EXECUTE_PATTERNS;
// Egress modules: Node's sockets and HTTP stacks plus the two userland clients
// (`undici`, `ws`) that bundles import by name, by `require`, `import … from`
// or a literal dynamic `import()`.
const NETWORK_MODULE = String.raw`(["'])(?:node:)?(?:https?|http2|net|dns|dgram|tls|undici|ws)\1`;
const JS_NETWORK_ACCESS_PATTERNS = [
  new RegExp(String.raw`\brequire\s*\(\s*${NETWORK_MODULE}\s*\)`),
  new RegExp(String.raw`\bfrom\s*${NETWORK_MODULE}`),
  new RegExp(String.raw`\bimport\s*\(\s*${NETWORK_MODULE}\s*[,)]`),
  /\bnew\s+(?:WebSocket|EventSource)\s*\(/,
  /\bsendBeacon\s*\(/,
  /\b(?:global|globalThis|self|window)\.fetch\s*\(/,
  // `fetch(input, init) {` on one line is a method definition, never a call;
  // a parenthesis in between (`if (!fetch(u)) {`) means it is a call.
  /(?<![\w$.])fetch\s*\((?![^()\n;]*\)[ \t]*\{)/,
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
// Primitives that run a string as code. A method named `eval` on some other
// object is not one: Redis clients expose `client.eval(luaScript)`. Global
// receivers and optional calls keep a member-shaped eval.
// A Function body that is exactly `return import(<name or literal>)` is the
// CommonJS dynamic-import shim (`new Function('specifier', 'return
// import(specifier)')`, playwright's `new Function('return import("vite")')`).
// It runs no caller code, so it is not eval; the computed import it performs
// stays a decoded-payload sink, which is why string-blind scanning erases it
// (`omitDynamicImportShims`) instead of the sink patterns ignoring it.
const DYNAMIC_IMPORT_SHIM_ARGUMENTS = String.raw`\s*(?:(["'\x60])[\w$]+\1\s*,\s*)?(["'\x60])return import\((?:[\w$]+|"[^"\\\n]*"|'[^'\\\n]*')\);?\2\s*\)`;
const DYNAMIC_IMPORT_SHIM = new RegExp(
  String.raw`\bnew\s+Function\s*\(${DYNAMIC_IMPORT_SHIM_ARGUMENTS}`,
  "g",
);

export function omitDynamicImportShims(source: string): string {
  return source.replace(DYNAMIC_IMPORT_SHIM, (shim) => shim.replace(/[^\n]+/g, ""));
}

// A same-line `eval(params) {` is a method definition (less's `eval(context)
// { return this; }`), never a call; `if (eval(x)) {` keeps its inner `)`.
const NOT_METHOD_DEFINITION = String.raw`(?![^()\n;]*\)[ \t]*\{)`;
// Call-shaped primitives. Scanned with string literal bodies blanked (see
// `codeViewsForScanning`): a code generator's `"WebAssembly.compile(bytes)"`
// is output, and code inside a string only runs through a call or a staging
// sink outside it.
const JS_DYNAMIC_CALL_PATTERNS = [
  new RegExp(String.raw`(?<![\w$.])eval\s*(?:\?\.\s*)?\(${NOT_METHOD_DEFINITION}`),
  /\b(?:globalThis|window|global|self|top|parent|frames)\s*\??\.\s*eval\s*(?:\?\.\s*)?\(/,
  // The dynamic-import shim is not eval; see `DYNAMIC_IMPORT_SHIM_ARGUMENTS`.
  new RegExp(String.raw`\bnew\s+Function\s*\((?!${DYNAMIC_IMPORT_SHIM_ARGUMENTS})`),
  // The whole compile/instantiate family: instantiate(Streaming) — not bare
  // compile — is the loader idiom packed wasm payloads actually use (typically
  // `WebAssembly.instantiateStreaming(fetch(...))`).
  /\bWebAssembly\.(?:compile|compileStreaming|instantiate|instantiateStreaming)\s*\(/,
];
// Shapes whose evidence is itself a string argument; scanned with only
// comments blanked.
const JS_DYNAMIC_STRING_ARGUMENT_PATTERNS = [
  // `node -e` is an interpreter-backed eval even when launched through the
  // child-process API instead of JavaScript's in-process eval primitives.
  /\bspawn(?:Sync)?\s*\(\s*["'`]node(?:js)?["'`]\s*,\s*\[\s*["'`](?:-e|--eval)["'`]/,
];
const JS_DYNAMIC_EXECUTION_PATTERNS = [
  ...JS_DYNAMIC_CALL_PATTERNS,
  ...JS_DYNAMIC_STRING_ARGUMENT_PATTERNS,
];
// Ways a decoded string reaches execution that are too common in benign code to
// be findings on their own: regenerator's `Function("r", …)`, core-js task
// queues, jsdom's and vite-node's `vm` contexts, require hooks' `_compile`,
// `(0, eval)('this')`. They only decide whether a decode in the same file
// counts. File writes (`installWrite`) join them in the pattern set below: a
// decoded payload written to disk is staged for a later load.
const JS_DECODED_PAYLOAD_SINK_PATTERNS = [
  /[(,]\s*eval\s*\)\s*\(/,
  /(?<![\w$.])Function\s*\(/,
  // Aliases: `const run = eval;`, `= globalThis.eval`, `{ eval: run } = globalThis`.
  /[=:,([]\s*(?:(?:globalThis|window|global|self)\s*\.\s*)?(?:eval|Function)\s*(?=[;,)\]\n}]|$)/,
  /[{,]\s*eval\s*:\s*[A-Za-z_$]/,
  /\b(?:eval|Function)\s*\.\s*(?:call|apply|bind)\s*\(/,
  /\bthis\s*\.\s*eval\s*\(/,
  /\bReflect\s*\.\s*(?:construct|apply)\s*\(\s*(?:Function|eval)\b/,
  // Any function's constructor is Function: `(() => {}).constructor(code)`,
  // `Object.constructor(code)`, and the AsyncFunction prototype trick.
  /\.constructor\s*\(/,
  /\bgetPrototypeOf\s*\(\s*async\b/,
  /\brunIn(?:This|New)?Context\s*\(/,
  /\b(?:compileFunction|_compile)\s*\(/,
  /\bnew\s+(?:vm\s*\.\s*)?Script\s*\(/,
  /\bWebAssembly\s*\.\s*(?:Module|Instance)\s*\(/,
  /\bdocument\s*\.\s*write(?:ln)?\s*\(/,
  /\bset(?:Timeout|Interval)\s*\(\s*(?:["'`]|atob\s*\(|Buffer\.from\s*\()/,
  /\beval\s*:\s*(?:true|!0)\b/,
  // A computed module specifier: `import(dataUrl)`, `require(writtenPath)`.
  /\b(?:require|import)\s*\(\s*(?!["'`)\s])/,
  /\bimport\s*\(\s*["'`]data:/,
];
// Bundlers resolve the global object with `new Function("return this")()`
// (webpack's `__webpack_require__.g`, lodash's `Function('return this')()`).
// That exact literal runs no caller data. A shim whose result is dereferenced
// on the spot, even through closing parens or `?.` (`(…()).eval(x)`), is kept,
// except a terminal read of `Promise` or `Symbol` (es6-promise's
// `promiseImpl = new Function("return this;")().Promise`).
const GLOBAL_OBJECT_SHIM =
  /(?<![\w$.])(?:new\s+)?Function\s*\(\s*(["'`])return this;?\1\s*\)(?!\s*\(\s*\)(?:\s*\))*\s*(?:\?\.|\.|\[)(?!\s*(?:Promise|Symbol)\b(?!\s*(?:\?\.|\.|\[|\())))/g;

// Erases the shim but keeps its newlines, so later findings keep their lines.
export function omitGlobalObjectShims(source: string): string {
  return source.replace(GLOBAL_OBJECT_SHIM, (shim) => shim.replace(/[^\n]+/g, ""));
}

// Decoding hides a payload or an endpoint but does not run it, and byte codecs,
// error-code tables and binary protocols decode base64 constantly. The scanner
// counts these only in a file that can also run, send or stage what it decodes.
// require.resolve( was evaluated as a candidate here and rejected: it only
// resolves a path (never executes code) and is the standard jest/babel/webpack
// preset idiom, so it flagged the legit-require-resolve benign hard-negative.
const JS_PAYLOAD_DECODING_PATTERNS = [
  /\batob\s*\(/,
  // The first argument stays on its line: `[^,]+` used to run from an encode
  // (`Buffer.from(v).toString('base64')`) to a later line's decode.
  /\bBuffer\.from\s*\(\s*[^,\n]+,\s*["']base64["']\s*\)/,
];
const JS_DYNAMIC_EVALUATION_PATTERNS = [
  ...JS_DYNAMIC_EXECUTION_PATTERNS,
  ...JS_PAYLOAD_DECODING_PATTERNS,
];
// Python decoding stays ungated: there is no normalizer, and droppers reach
// execution through pickle, marshal, `types.FunctionType` and
// `getattr(builtins, …)` shapes this set cannot enumerate. The Python
// `dynamicExecution` view is therefore the whole set.
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
// Credential access is reading a secret, not reading the environment. A named
// read of a configuration variable (`PORT`, `HOME`,
// `NAPI_RS_NATIVE_LIBRARY_PATH`, `npm_config_https_proxy`) is not one. Every
// other use of the env object counts: a secret-shaped name, a key chosen at
// runtime, and the object itself used as a value (bound, passed, spread,
// copied, wrapped, serialized or enumerated), because once the whole
// environment is a value no line regex can follow which variables leave with
// it. `scripts.ts` exempts only uses that read nothing (presence tests and
// guards), destructuring of named non-secret variables, and the `env` option of
// a child-process call, which the child inherits anyway. Known secret names
// anywhere and credential files on disk count too.
//
// Secret-shaped names: substrings that only occur in secrets, plus whole
// `_`-delimited segments for words that are also substrings of ordinary names
// (`KEY` not `KEYBOARD`, `AUTH` not `AUTHOR`, `PASS`/`PWD` only after a prefix
// so the shell's `PWD` stays a path). `AWS_` is the one prefix that is all
// credentials or credential selectors. `PRIVATE` alone is not used: every
// private-key variable also says `KEY`, and Next.js' `NEXT_PRIVATE_*` flags
// are configuration. Neither are CI descriptors such as `GITHUB_ACTIONS` or
// `GITHUB_REF`; every GitHub credential name carries `TOKEN`, `PAT` or `KEY`.
// `JWT` (GitLab's `CI_JOB_JWT`) is a credential; `KUBECONFIG`, `DOCKER_CONFIG`,
// npm's `USERCONFIG` and `NETRC` name the file that holds one.
// A handful of public names that bundles carry everywhere are carved out:
// React's `__SECRET_INTERNALS_…`, Babel's `ALIAS_KEYS`/`VISITOR_KEYS`/
// `BUILDER_KEYS` tables, and terminal ids (`WT_SESSION`, `TERM_SESSION_ID`).
const SECRET_NAME_MARKER = String.raw`(?:TOKEN(?!IZ)|SECRET(?!_INTERNALS)|PASSW(?:OR)?D|PASSPHRASE|CREDENTIAL|COOKIE|AUTHORIZATION|API_?KEY|ACCESS_?KEY|PRIVATE_?KEY|(?<![A-Za-z0-9])(?:KEY|(?<!(?:ALIAS|VISITOR|BUILDER)_)KEYS|PAT|(?<!(?:WT|TERM)_)SESSION|DSN|WEBHOOK|O?AUTH|JWT|KUBECONFIG|DOCKER_CONFIG|USERCONFIG|NETRC)(?![A-Za-z0-9])|_(?:PASS|PWD)(?![A-Za-z0-9])|(?<![A-Za-z0-9])AWS_|(?<![A-Za-z0-9])(?:DATABASE|DB|MONGO(?:DB)?|REDIS|POSTGRES(?:QL)?|MYSQL)_UR[LI](?![A-Za-z0-9]))`;
// `process?.env` and `globalThis.process.env` included; `process['env']` is
// member-folded by the normalizer.
const ENV_OBJECT = String.raw`(?:\bprocess\s*\??\.\s*env|\bimport\s*\.\s*meta\s*\.\s*env|\bBun\s*\.\s*env)\b`;
// The env object used as a value: not followed by a member read.
const ENV_OBJECT_VALUE = String.raw`${ENV_OBJECT}(?!\s*(?:\?\.|\.)\s*[\w$]|\s*(?:\?\.\s*)?\[)`;
const JS_CREDENTIAL_ACCESS_PATTERNS = [
  // The env object as a value. Destructuring is a value use too; `scripts.ts`
  // exempts it when every name it pulls out is a plain non-secret one.
  new RegExp(ENV_OBJECT_VALUE),
  // Named reads of a secret-shaped variable: dot, bracket literal and Deno's
  // getter.
  new RegExp(String.raw`${ENV_OBJECT}\s*\??\.\s*[\w$]*?${SECRET_NAME_MARKER}`, "i"),
  new RegExp(
    String.raw`${ENV_OBJECT}\s*(?:\?\.\s*)?\[\s*(["'\x60])[^"'\x60\n]*?${SECRET_NAME_MARKER}[^"'\x60\n]*\1\s*\]`,
    "i",
  ),
  new RegExp(
    String.raw`\bDeno\s*\.\s*env\s*\.\s*get\s*\(\s*(["'\x60])[^"'\x60\n]*?${SECRET_NAME_MARKER}`,
    "i",
  ),
  // A key chosen at runtime: anything but one plain literal. Which secret it
  // reads is invisible to review, which is how a stealer hides its target.
  // Assembled literals fold first (`["NPM_" + "TOKEN"]` reads as `.NPM_TOKEN`);
  // a computed member of `process` itself (`globalThis.process[e]`) can reach
  // `env` the same way.
  new RegExp(
    String.raw`${ENV_OBJECT}\s*(?:\?\.\s*)?\[(?!\s*(["'])[^"'\n\\]*\1\s*\])(?!\s*\x60[^\x60$\n\\]*\x60\s*\])`,
  ),
  /(?<![\w$.])(?:(?:globalThis|global|window|self)\s*\??\.\s*)?process\s*(?:\?\.\s*)?\[(?!\s*(["'])[^"'\n\\]*\1\s*\])(?!\s*`[^`$\n\\]*`\s*\])/,
  /\bDeno\s*\.\s*env\s*\.\s*(?:get\s*\(\s*(?!["'`])|toObject\s*\()/,
  /\bnpm_config_[\w\-./:@]*?(?:_auth|token|_password)/i,
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
// Global, for the exemption pass in `scripts.ts`.
export const ENV_OBJECT_VALUE_USE = new RegExp(ENV_OBJECT_VALUE, "g");
export const SECRET_NAME = new RegExp(SECRET_NAME_MARKER, "i");
export const ENV_OBJECT_PATTERN = new RegExp(ENV_OBJECT);
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
  dynamicExecution: JS_DYNAMIC_EXECUTION_PATTERNS,
  dynamicCall: JS_DYNAMIC_CALL_PATTERNS,
  dynamicStringArgument: JS_DYNAMIC_STRING_ARGUMENT_PATTERNS,
  payloadDecoding: JS_PAYLOAD_DECODING_PATTERNS,
  decodedPayloadSink: [...JS_DECODED_PAYLOAD_SINK_PATTERNS, ...JS_INSTALL_WRITE_PATTERNS],
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
  dynamicExecution: PYTHON_DYNAMIC_EVALUATION_PATTERNS,
  dynamicCall: PYTHON_DYNAMIC_EVALUATION_PATTERNS,
  dynamicStringArgument: [] as RegExp[],
  payloadDecoding: [] as RegExp[],
  decodedPayloadSink: [] as RegExp[],
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

// A Markdown soft line break is whitespace to both renderers and LLMs. Replace
// each newline code unit with a space so phrase patterns can span wrapped text
// without changing offsets used to recover the original line number.
export function softenPromptInjectionLineBreaks(text: string): string {
  return text.replace(/[\r\n]/g, " ");
}

// Instruction content aimed at any LLM/agent that reads package bytes — an AI
// reviewer, a coding assistant resolving docs, an MCP tool ingesting a README.
// A bare "agent"/"assistant" is somebody's product (a Datadog agent, an
// OpenAI Assistants thread); only AI-qualified forms or Drydock itself read as
// an LLM audience.
const AI_ACTOR_SEGMENT = String.raw`(?:language\s+model|(?:(?:AI|LLM)(?:[\s-]+(?:coding|automated))?|coding|automated)[\s-]+(?:agent|assistant|reviewer|scanner|tool))`;
const AI_AUDIENCE_SEGMENT = String.raw`(?:AI|LLM|artificial\s+intelligence|Drydock(?:[\s-]+reviewer)?|${AI_ACTOR_SEGMENT})`;
const REVIEWED_RELEASE_SEGMENT = String.raw`(?:package|release|update|version|publish)`;
const POSITIVE_CLEAN_REVIEW_VERDICT_SEGMENT = String.raw`(?:safe|benign|trusted|clean|harmless|verified|legitimate)`;
const CLEAN_REVIEW_VERDICT_SEGMENT = String.raw`(?:${POSITIVE_CLEAN_REVIEW_VERDICT_SEGMENT}|not\s+(?:malicious|suspicious))`;
const REVIEW_VERDICT_DIRECTIVE_SEGMENT = String.raw`(?:mark|report|approve|assess|rate|label)\s+(?:this|the)\s+(?:package|release|update|version|publish)\b[^\n.!?]{0,40}\b(?:as\s+)?(?:safe|benign|trusted|clean|harmless|verified|legitimate|not\s+(?:malicious|suspicious))\b(?!\s+(?:in|for|when|via|through|under)\b[^\n.!?]{0,40}\b(?:configuration|config|policy|allowlist|sandbox)\b)`;
const DIRECT_REVIEW_VERDICT_DIRECTIVE_SEGMENT = String.raw`(?:(?:approve)\s+(?:(?:this|the)\s+)?${REVIEWED_RELEASE_SEGMENT}|(?:mark|report|assess|rate|label|classify|declare|say)\s+(?:(?:this|the)\s+)?${REVIEWED_RELEASE_SEGMENT}\b(?![^\n.!?]{0,40}\bnot\s+${POSITIVE_CLEAN_REVIEW_VERDICT_SEGMENT}\b)[^\n.!?]{0,40}\b(?:(?:as|is)\s+)?${CLEAN_REVIEW_VERDICT_SEGMENT})\b`;

// Text that tries to steer the *automated security review itself* toward a
// clean verdict. These are verdict-coercion shapes, not generic LLM chatter:
// each pattern needs either a review-like verdict aimed at the release object
// ("mark this package as safe"), a suppression directive over review output
// ("do not report any findings"), or a literal token from Drydock's own review
// schema (`nothing_unusual`, `requiresManualReview`). Third-person prose stays
// out by construction — "npm marks the package as verified" has no imperative
// `mark`, and SECURITY.md's "do not report vulnerabilities publicly" names no
// findings/detections object.
const REVIEW_MANIPULATION_PATTERNS = [
  // A bare verdict verb is only imperative at a line/sentence boundary, after
  // direct-address punctuation, or in an assigned/quoted instruction string.
  // This keeps third-person API prose ("the endpoint will report ...") out of
  // the standing-danger tier without weakening actual packaged directives.
  new RegExp(
    String.raw`^[\t ]*(?:(?://|#|/\*+|\*|<!--|-|>)[\t ]*)?(?:please[\t ]+)?${REVIEW_VERDICT_DIRECTIVE_SEGMENT}`,
    "im",
  ),
  new RegExp(
    String.raw`[.!?;:,="'()\x60][\t ]*(?:please[\t ]+)?${REVIEW_VERDICT_DIRECTIVE_SEGMENT}`,
    "i",
  ),
  // An explicit clean-verdict command aimed at an AI-qualified or Drydock
  // audience does not need a determiner or one canonical verb. Requiring
  // "approve this" or "mark this as safe" leaves equivalent direct commands
  // below the standing-danger tier when the advisory reviewer cannot run.
  new RegExp(
    String.raw`\b${AI_AUDIENCE_SEGMENT}s?\b\s*[:,]\s*(?:you\s+)?${DIRECT_REVIEW_VERDICT_DIRECTIVE_SEGMENT}`,
    "i",
  ),
  // Once an AI/Drydock review audience is explicit, a command to hide review
  // output is verdict manipulation even when it adds an ordinary-language
  // destination or rationale after the finding noun.
  new RegExp(
    String.raw`\b${AI_AUDIENCE_SEGMENT}s?\b\s*[:,]\s*(?:you\s+)?(?:(?:(?:do\s+not|don'?t)\s+(?:report|flag|mention|raise|escalate|surface)|(?:ignore|disregard|hide|suppress))\s+(?:any|all|these|those|the)|(?:report|return)\s+no)\s+(?:findings?|detections?)\b`,
    "i",
  ),
  // Suppression is imperative-only ("do not"/"don't") with a determiner on the
  // object. Modals invite third-person subjects ("the scanner should not flag
  // minified code as suspicious"), broad support nouns ("do not report any
  // issues here") are ordinary project guidance. Qualified policy text ("do
  // not report any findings from generated files") is also ordinary in the
  // linter/scanner packages npm is full of, so only a sentence-ending command
  // or an explicitly review-scoped qualifier reaches the high tier.
  /\b(?:do\s+not|don'?t)\s+(?:report|flag|mention|raise|escalate|surface)\s+(?:any|these|those)\s+(?:findings?|detections?)\b(?=\s*(?:[.!?]|$)|\s+(?:in|for|from|about)\s+(?:this|the)\s+(?:(?:(?:automated|AI)\s+)?(?:security\s+)?(?:review|scan|audit)|package|release|update|version)\b)/i,
  /\b(?:do\s+not|don'?t)\s+(?:flag|report|mark|treat)\s+(?:this|the)\s+(?:package|release|update|version|library|module|code|file)\b[^\n.!?]{0,30}\bas\s+(?:suspicious|malicious|unsafe|risky)\b/i,
  // Drydock's schema tokens are ordinary source in an API client or integration.
  // They become verdict manipulation only when an explicit review audience is
  // told to produce them.
  new RegExp(
    String.raw`\b${AI_AUDIENCE_SEGMENT}s?\b\s*[:,]\s*(?:you\s+)?(?:report|return|reply(?:\s+with)?|respond(?:\s+with)?|output|submit|set|use)\b[^\n.!?]{0,50}\b(?:nothing[_-]unusual|requires_?manual_?review\b[^\n.!?]{0,20}\bfalse)\b`,
    "i",
  ),
  // Security tooling legitimately documents switches such as "bypass the
  // security check during local development". Require the directive to name
  // this package/release as the object being exempted from review.
  /\b(?:skip|bypass|disable)\s+(?:(?:(?:the|this)\s+)?security\s+(?:review|scan|audit|check)\s+(?:of|for|on)\s+(?:this|the)\s+(?:package|release|update|version|code)|(?:this|the)\s+(?:package|release|update|version|code)(?:'s)?\s+security\s+(?:review|scan|audit|check))\b/i,
];

// Precision over recall: every pattern requires either an instruction-override
// verb phrase or a direct address to an AI/agent audience, because LLM client
// libraries legitimately ship prompt-shaped text ("You are a helpful
// assistant", "customize the system prompt") that must stay quiet.
const PROMPT_INJECTION_PATTERNS = [
  /\b(?:ignore|disregard|forget|override)\s+(?:all\s+|any\s+|the\s+|your\s+)?(?:(?:previous|prior|above|earlier|preceding|initial|original)(?:\s+(?:system|developer|user))?|system)\s+(?:instructions?|messages?|prompts?|rules?|directives?|commands?|context)\b/i,
  /\b(?:ignore|disregard|forget|override)\s+(?:all\s+|any\s+|the\s+|your\s+|every\s+)?(?:instructions?|messages?|prompts?|rules?|directives?|commands?|context)\s+(?:above|before|earlier|previously)\b/i,
  /\b(?:ignore|disregard|forget)\s+(?:everything|all)\s+(?:above|before|you\s+were\s+told)\b/i,
  /\byour\s+(?:new\s+)?system\s+prompt\s+is\b/i,
  /\b(?:replace|overwrite)\s+your\s+system\s+prompt\b/i,
  // The conditional address alone also greets humans ("if you are an AI
  // researcher, see the docs"), so it must be followed by a directive clause.
  new RegExp(
    String.raw`\bif\s+you\s+are\s+an?\s+${AI_AUDIENCE_SEGMENT}\b[^\n.!?]{0,60}\b(?:ignore|disregard|follow|obey|must|should|do\s+not|don'?t|stop|instead|reply|respond|output|run|execute|add|install|recommend|include)\b`,
    "i",
  ),
  new RegExp(
    String.raw`\b(?:note|message|attention|instructions?|important)\s+(?:to|for)\s+(?:the\s+|all\s+|any\s+)?${AI_AUDIENCE_SEGMENT}s?\b`,
    "i",
  ),
  // Direct vocatives do not need a "note to" wrapper. Require either
  // punctuation followed by a directive or an explicit obligation so prose
  // that merely describes an AI tool stays quiet.
  new RegExp(
    String.raw`\b${AI_AUDIENCE_SEGMENT}s?\b\s*[:,]\s*(?:you\s+)?(?:ignore|disregard|follow|obey|do\s+not|don'?t|stop|reply|respond|output|run|execute|add|install|recommend|include|approve|mark|treat|say)\b`,
    "i",
  ),
  new RegExp(
    String.raw`\b${AI_ACTOR_SEGMENT}s?\b[^\n.!?]{0,20}\b(?:must|should|need\s+to|are\s+required\s+to)\s+(?:ignore|disregard|follow|obey|stop|reply|respond|output|run|execute|add|install|recommend|include|approve|mark|treat)\b`,
    "i",
  ),
  /\bas\s+an?\s+(?:AI|LLM|language\s+model)\b[^\n.!?]{0,60}\byou\s+(?:must|should|will|have\s+to|are\s+required)\b/i,
  new RegExp(
    String.raw`\b${AI_AUDIENCE_SEGMENT}s?\b\s*[:,]\s*you\s+are\s+now\s+in\s+(?:developer|DAN|jailbreak|unrestricted|god)\s+mode\b`,
    "i",
  ),
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
  "login",
  "guest",
  "johndoe",
].join("|");
const WEAK_WORD_PASSWORD_SEGMENT = [
  "(?:auth|db)?pass(?:word|wd)?",
  "p%40ss(?:word)?",
  "pwd",
  "psw",
  "secret",
  "token",
  "example",
  "admin",
  "guest",
  // The redis.conf / README example password.
  "foobared",
].join("|");
const STRUCTURAL_PLACEHOLDER_SEGMENT = [
  "changeme",
  "hunter2",
  "(?:your|my)[-_]?(?:password|token|secret|key)",
  "(?:random|dummy|fake|example|sample)[-_]?pass(?:word|wd)?",
  "x{3,}",
  "\\*{3,}",
  "<[^>@\\s]*>",
  "\\{[^}@\\s]*\\}",
  "\\$\\{[^}@\\s]*\\}",
  "\\$[A-Za-z_][A-Za-z0-9_]*",
  "%[^%@\\s]+%",
].join("|");
// Userinfo cannot contain quotes, brackets or braces, so the finding side
// stops at them: in minified code `https://example.com",keywords:[…]…@scope`
// would otherwise read a string boundary and a later `@` as credentials, and
// `http://[user:pwd]@host` is a bracketed doc placeholder.
const URL_USER_CHAR = String.raw`[^\s/@:'"\x60<>{}[\]\\,;()]`;
const URL_PASSWORD_CHAR = String.raw`[^\s/@'"\x60<>{}[\]\\,;()]`;
const URL_CREDENTIALS_FINDING_PATTERN = new RegExp(
  String.raw`\b(?:[A-Za-z]+:\/\/)(?!(?:${PLACEHOLDER_USERNAME_SEGMENT}):(?:${WEAK_WORD_PASSWORD_SEGMENT}|${STRUCTURAL_PLACEHOLDER_SEGMENT})@|[^\s/@:]+:(?:${STRUCTURAL_PLACEHOLDER_SEGMENT})@)${URL_USER_CHAR}+:${URL_PASSWORD_CHAR}+@[^\s'"\\]+`,
  "gi",
);

// The redaction value class admits `,` `:` `!` `=` `.` so it masks anything
// secret-shaped. In whitespace-free minified code that reads property tables as
// secrets: React's `password:!0,range:!0,…` and a lexer's `this.token=t,…` both
// run to the next space. A finding therefore needs a quoted literal, or one
// unquoted value free of code punctuation and operators (`=` only as trailing
// base64 padding) that runs to whitespace or end of text: `.env`/YAML
// `KEY=value`, including `P@ssw0rd!` style values, but not `x=n.token!==void 0`.
const GENERIC_SECRET_REDACTION_PATTERN =
  /(?<![A-Za-z0-9])((?:secret|token|password|passwd|pwd|api[_-]?key|access[_-]?key|client[_-]?secret)\s*[:=]\s*)['"]?[^'"\s()]{12,}(?=$|[\s'",;}\]])/gi;
//
// Code names its secrets far more often than it holds them. A real sweep of
// popular packages found the generic key/value shape matching, never a leak:
//   - identifier-shaped constants: `TOKEN = "__WEBPACK_MODULE_REFERENCE__"`,
//     `SECRET: "MF-Proxy-Shared-Secret"`, Monaco's `token: "delimiter.curly"`,
//     error codes like `'auth/invalid-api-key'`. A value made only of letter
//     words (each ≤16 letters, ≤4 trailing digits) joined by `-_.:/` is a name,
//     not key material, so neither branch accepts one. Monaco's `@brackets`
//     and `type.$0` tokenizer references are names of the same kind.
//   - unquoted expressions: `password: options.password`, `token = this.ctx`,
//     `exports.Token = exports.Location`. An unquoted value is a secret only in
//     `.env`/YAML-style files, where it is not a property path and, unlike an
//     identifier, carries a digit (`sk-abc123…`, `Tr0ub4dor&3`).
//   - placeholders: `"<client-secret>"`, `"${API_KEY}"`, `"{{token}}"`,
//     `xxxx`/`****` masks, and "example"/"placeholder"/"your-" values.
//   - minified string seams: `"…password: "),m=n.limit…"` reads the code
//     between two literals as a quoted value; a quoted value with code
//     punctuation `(){};,` is that seam, not a password.
// Spacing around the separator stays on one line so `token =\n  this.x`
// cannot reach the next statement. Every sub-pattern is bounded or anchored
// on disjoint character classes so a long run stays linear.
const SECRET_KEY_ASSIGNMENT = String.raw`(?<![A-Za-z0-9])((?:secret|token|password|passwd|pwd|api[_-]?key|access[_-]?key|client[_-]?secret)[ \t]*[:=][ \t]*)`;
const WORD_SEGMENT = String.raw`(?:[A-Za-z]{1,16}[0-9]{0,4}|\$?[0-9]{1,2})`;
// Quoted names may use `:` (`urn:…:token-type`); the unquoted variant leaves it
// out, as its value cannot contain one. Keeping `:` out also keeps the scan
// linear: a run of `token:token:…` would otherwise rescan to the end from
// every key.
const wordShapedValue = (separators: string) =>
  String.raw`[${separators}@]*${WORD_SEGMENT}(?:[${separators}]+${WORD_SEGMENT})*[${separators}]*`;
const QUOTED_WORD_SHAPED_VALUE = wordShapedValue("-_.:/");
const UNQUOTED_WORD_SHAPED_VALUE = wordShapedValue("-_./");
const PLACEHOLDER_VALUE_HINT = String.raw`x{4}|\*{3}|<|>|example|placeholder|changeme|redacted|your[-_]`;
const UNQUOTED_SECRET_CHAR = String.raw`[^'"\s,;:(){}[\]=]`;
const GENERIC_SECRET_FINDING_PATTERN = new RegExp(
  SECRET_KEY_ASSIGNMENT +
    "(?:" +
    // Quoted literal.
    String.raw`(['"])(?![{%[]|\$\{)(?!${QUOTED_WORD_SHAPED_VALUE}\2)(?![^'"\s]*?(?:${PLACEHOLDER_VALUE_HINT}))[^'"\s(){};,\x60]{12,}\2` +
    "|" +
    // Unquoted `.env`/YAML value running to whitespace or end of text.
    String.raw`(?![$<%]|[A-Za-z_$][\w$]*\.[A-Za-z_$])(?!${UNQUOTED_WORD_SHAPED_VALUE}={0,2}(?:\s|$))(?!${UNQUOTED_SECRET_CHAR}*?(?:${PLACEHOLDER_VALUE_HINT}))(?=${UNQUOTED_SECRET_CHAR}*?[0-9])${UNQUOTED_SECRET_CHAR}{12,}={0,2}(?=$|\s)` +
    ")",
  "gi",
);

// .npmrc auth (`//registry/:_authToken=…`, legacy `_auth=`/`_password=`).
// Redaction masks any literal value; `${NPM_TOKEN}` is a reference. A finding
// needs the shape of a real credential, a legacy UUID token or mixed-case
// base64, because npm's own docs and READMEs show `_authToken=MYTOKEN1`,
// `YOUR_NPM_TOKEN` and `<your-token>` placeholders.
const NPM_AUTH_REDACTION_PATTERN = /((?:^|:)_(?:authToken|auth|password)=)(?!\$\{)[^\s'"]{8,}/gm;
const NPM_AUTH_FINDING_PATTERN =
  /((?:^|:)_(?:authToken=[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b|(?:auth|password)=(?=[A-Za-z0-9+/]*[a-z])(?=[A-Za-z0-9+/]*[A-Z0-9])[A-Za-z0-9+/]{8,}={0,2}(?=\s|$)))/gim;

// `;`-delimited connection strings (`Server=db;User Id=sa;Password=…;`), which
// the generic pattern's whitespace terminator cannot end. A connection-string
// key earlier on the same line is required, segments are bounded so a long run
// of keys stays linear, and a template placeholder (`${pwd}`, `<password>`) or a
// property read (`host=e.host;password=e.password`) is not a value. The
// finding side also skips the structural placeholders (`Password=myPassword;`,
// `password=randompassword;` in a CLI's sample connection strings).
const CONNECTION_STRING_PASSWORD_PREFIX = String.raw`(\b(?:Server|Data Source|Host|Uid|User ID|Initial Catalog|Database)[ \t]*=[^;"'\n]{0,256};(?:[^;"'\n]{0,256};){0,8}?[ \t]*(?:Password|Pwd)[ \t]*=[ \t]*)(?![$<{%]|[A-Za-z_$][\w$]*\.[A-Za-z_$])`;
const CONNECTION_STRING_PASSWORD_PATTERN = new RegExp(
  String.raw`${CONNECTION_STRING_PASSWORD_PREFIX}[^;"'\s]{6,}`,
  "gi",
);
const CONNECTION_STRING_PASSWORD_FINDING_PATTERN = new RegExp(
  String.raw`${CONNECTION_STRING_PASSWORD_PREFIX}(?!(?:${STRUCTURAL_PLACEHOLDER_SEGMENT})(?:[;"'\s]|$))[^;"'\s]{6,}`,
  "gi",
);

// Self-identifying token shapes that still occur by chance inside long base64
// runs (a 20-char `AKIA…` window in an inlined WASM module): the finding side
// requires the token to stand alone rather than sit inside a longer base64 run.
const AWS_ACCESS_KEY_PATTERN = /AKIA[0-9A-Z]{16}/g;
const AWS_SESSION_KEY_PATTERN = /ASIA[0-9A-Z]{16}/g;
const AWS_ACCESS_KEY_FINDING_PATTERN = /(?<![A-Za-z0-9+/])AKIA[0-9A-Z]{16}(?![A-Za-z0-9+/])/g;
const AWS_SESSION_KEY_FINDING_PATTERN = /(?<![A-Za-z0-9+/])ASIA[0-9A-Z]{16}(?![A-Za-z0-9+/])/g;

// Slack webhook paths are `T<team>/B<bot>/<secret>`; docs and bundled samples
// use `xxx/xxx/xxx` or short made-up segments.
const SLACK_WEBHOOK_PATTERN = /https:\/\/hooks\.slack\.com\/services\/[A-Za-z0-9/]+/g;
const SLACK_WEBHOOK_FINDING_PATTERN =
  /https:\/\/hooks\.slack\.com\/services\/T[A-Z0-9]{6,}\/B[A-Z0-9]{6,}\/(?![xX]{8})[A-Za-z0-9]{16,}/g;

// A PEM/PGP private key body is base64 in 64-char lines. Documentation and
// armor code carry the header with a placeholder or code instead
// (`-----BEGIN PRIVATE KEY-----\nXXXX\n…`, `<KEY>`, `…'\n'); result.push(`),
// so the finding side needs a 40-char base64 run within the first 400
// characters after the header (room for `Proc-Type`/`Version:` headers). The
// window is bounded and stops at the next `-----`, keeping the scan linear.
const PRIVATE_KEY_LABEL = "(?:RSA |OPENSSH |EC |DSA |PGP |ENCRYPTED )?PRIVATE KEY(?: BLOCK)?";
const PRIVATE_KEY_PATTERN = new RegExp(
  String.raw`-----BEGIN ${PRIVATE_KEY_LABEL}-----[\s\S]*?-----END ${PRIVATE_KEY_LABEL}-----`,
  "g",
);
const PRIVATE_KEY_FINDING_PATTERN = new RegExp(
  String.raw`-----BEGIN ${PRIVATE_KEY_LABEL}-----(?:[^-]|-(?!----)){0,400}?[A-Za-z0-9+/]{40}[\s\S]*?-----END ${PRIVATE_KEY_LABEL}-----`,
  "g",
);

export const SECRET_PATTERNS: Array<[RegExp, string]> = [
  [/npm_[A-Za-z0-9]{20,}/g, "[REDACTED_NPM_TOKEN]"],
  [/gh[pousr]_[A-Za-z0-9_]{20,}/g, "[REDACTED_GITHUB_TOKEN]"],
  [/github_pat_[A-Za-z0-9_]{20,}/g, "[REDACTED_GITHUB_TOKEN]"],
  [AWS_ACCESS_KEY_PATTERN, "[REDACTED_AWS_ACCESS_KEY]"],
  [AWS_SESSION_KEY_PATTERN, "[REDACTED_AWS_SESSION_KEY]"],
  [/AIza[0-9A-Za-z\-_]{35}/g, "[REDACTED_GOOGLE_API_KEY]"],
  [/ya29\.[0-9A-Za-z\-_]{20,}/g, "[REDACTED_GOOGLE_OAUTH_TOKEN]"],
  [/sk_(?:live|test)_[0-9a-zA-Z]{16,}/g, "[REDACTED_STRIPE_KEY]"],
  [/rk_(?:live|test)_[0-9a-zA-Z]{16,}/g, "[REDACTED_STRIPE_KEY]"],
  [/xox[abprs]-[A-Za-z0-9-]{10,}/g, "[REDACTED_SLACK_TOKEN]"],
  [SLACK_WEBHOOK_PATTERN, "[REDACTED_SLACK_WEBHOOK]"],
  [/eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, "[REDACTED_JWT]"],
  [URL_CREDENTIALS_REDACTION_PATTERN, "[REDACTED_URL_WITH_CREDENTIALS]"],
  [PRIVATE_KEY_PATTERN, "[REDACTED_PRIVATE_KEY]"],
  [/(authorization\s*[:=]\s*)['"]?Bearer\s+[A-Za-z0-9._\-+/=]{16,}/gi, "$1[REDACTED_BEARER]"],
  [NPM_AUTH_REDACTION_PATTERN, "$1[REDACTED_NPM_AUTH]"],
  [CONNECTION_STRING_PASSWORD_PATTERN, "$1[REDACTED_SECRET]"],
  [GENERIC_SECRET_REDACTION_PATTERN, "$1[REDACTED_SECRET]"],
];

const FINDING_PATTERN_FOR_REDACTION = new Map<RegExp, RegExp>([
  [URL_CREDENTIALS_REDACTION_PATTERN, URL_CREDENTIALS_FINDING_PATTERN],
  [GENERIC_SECRET_REDACTION_PATTERN, GENERIC_SECRET_FINDING_PATTERN],
  [NPM_AUTH_REDACTION_PATTERN, NPM_AUTH_FINDING_PATTERN],
  [CONNECTION_STRING_PASSWORD_PATTERN, CONNECTION_STRING_PASSWORD_FINDING_PATTERN],
  [AWS_ACCESS_KEY_PATTERN, AWS_ACCESS_KEY_FINDING_PATTERN],
  [AWS_SESSION_KEY_PATTERN, AWS_SESSION_KEY_FINDING_PATTERN],
  [SLACK_WEBHOOK_PATTERN, SLACK_WEBHOOK_FINDING_PATTERN],
  [PRIVATE_KEY_PATTERN, PRIVATE_KEY_FINDING_PATTERN],
]);

// Detection-side view of SECRET_PATTERNS: identical except where a finding needs
// a stricter shape than redaction (see FINDING_PATTERN_FOR_REDACTION). Redaction
// stays on the broad set.
export const FINDING_SECRET_PATTERNS: Array<[RegExp, string]> = SECRET_PATTERNS.map(
  ([pattern, label]) => [FINDING_PATTERN_FOR_REDACTION.get(pattern) ?? pattern, label],
);

// Documentation shows key/value examples with placeholder values, so docs and
// packaging metadata use only the self-identifying token formats.
const KEY_VALUE_FINDING_PATTERNS = new Set([
  GENERIC_SECRET_FINDING_PATTERN,
  NPM_AUTH_FINDING_PATTERN,
  CONNECTION_STRING_PASSWORD_FINDING_PATTERN,
]);
export const HIGH_CONFIDENCE_SECRET_PATTERNS: Array<[RegExp, string]> =
  FINDING_SECRET_PATTERNS.filter(([pattern]) => !KEY_VALUE_FINDING_PATTERNS.has(pattern));

export function codePatternsFor(codePatternSet: CodePatternSet | undefined): typeof JS_PATTERN_SET {
  return codePatternSet === "python" ? PYTHON_PATTERN_SET : JS_PATTERN_SET;
}
