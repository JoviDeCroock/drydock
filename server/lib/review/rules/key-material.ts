import type { Finding } from "../types";
import { jsTokenText, tokenizeJsWithinBudget, type JsToken } from "../../platform/js-lexer";
import {
  changedPrefix,
  changedStagedLines,
  isUnreachableTestFile,
  type RuleContext,
} from "./context";
import { isDocumentationPath, isJsonDataPath, isTypeDeclarationPath } from "./file-types";
import { tag, testScope } from "./helpers";
import { normalizeCodeForScanning } from "./normalize";

// Crypto key material → network egress, traced through one file.
//
// The capability rules see "reads a secret" and "uses the network" as two
// regex hits, and only for secrets read from the environment or a credential
// file. Wallet key theft reads the key from an argument or an object the host
// application built (`keypair.secretKey`, a hooked `Wallet` constructor's
// `privateKey`), so it raised nothing but network access. File-level
// co-occurrence cannot close that gap: every wallet SDK bundle holds key
// material and an RPC client side by side. This module instead follows the
// value: a bounded, flow-insensitive taint pass over the lexed tokens from a
// key-material read to the arguments of a network call, where signing,
// hashing, public-key derivation and similar primitives end the flow.
//
// It is a lexer-level approximation, not a parser: scopes are brace ranges,
// shadowing is ignored (over-approximates), and flows through callbacks,
// object methods other than plain data accessors, or other files are not
// followed (under-approximates).

const JS_CODE_PATH = /\.(?:[cm]?js|jsx|[cm]?ts|tsx)$/i;
const MAX_SOURCE_CHARS = 4 * 1024 * 1024;
const MAX_FIXPOINT_PASSES = 8;
const MAX_CHAIN_STEPS = 8;
const MAX_TEMPLATE_DEPTH = 4;
// Token indices retained along a flow, used only to attribute the finding to a
// release-changed line. Deep enough to hold every hop of a realistic
// assignment chain, so a release that edits an intermediate hop (not the source
// read or the sink) is still attributed to a changed line rather than reported
// as unchanged. Longer chains keep the hops nearest the sink.
const MAX_VIA = 64;
// Interprocedural flow (arguments into parameters, return values out) only
// follows a name defined at most this many times: minified bundles reuse
// one-letter names across thousands of scopes, and joining them would taint
// unrelated parameters.
const MAX_DEFINITIONS_PER_NAME = 2;
// Bounds on per-name lookups, so a minified bundle that declares `e` in ten
// thousand scopes stays linear: past them a name resolves to the file scope or
// is not followed across calls.
const MAX_SCOPE_SCAN = 512;
const MAX_SCOPED_DEFINITIONS = 16;
// Member chains are compared at most this many components deep.
const MAX_MEMBER_PATH = 8;

// A single name never holds more taint entries than this. Minified bundles
// reuse one-letter names across thousands of scopes; without a cap the
// membership scans in `addWhole`/`addField` would grow with the file.
const MAX_ENTRIES_PER_NAME = 64;

// Every source contains one of these words (a key-material name, a wallet or
// keypair constructor, a key factory, a wallet file), so a file without one,
// or without anything sink-shaped, is never folded or lexed.
const KEY_MATERIAL_WORD =
  /priv(?:ate)?[_$-]*keys?|prv[_$-]*key|mnemonic|seed[_$-]*(?:phrase|words)|(?:recovery|secret|backup|wallet)[_$-]*phrase|xprv|xpriv|tprv|private[_$-]*extended|extended[_$-]*key|wif[_$-]*key|secret[_$-]*key|from[_$-]*(?:seed|phrase|wif)|wallet|key[_$-]*pair|solana|keystore|exodus|nkbihfbeogaeaoehlefnkodbefgpgknn|bfnaelmomeimhlpmgjnjophhpkkoljpa/i;
const SINK_WORD =
  /fetch|beacon|request|axios|got|needle|superagent|\bky\b|socket|xmlhttp|eventsource|dns|connect|ajax|http/i;
// The literal decoders `normalizeCodeForScanning` folds.
const DECODER_WORD = /atob|Buffer|fromC(?:harCode|odePoint)|decodeURI|unescape/;

// Names compared lowercased with `_`, `$` and `-` removed, so `privateKey`,
// `PRIVATE_KEY` and `private_key` are one name. A bounded set of qualifiers
// keeps `deployerPrivateKey` and `mnemonicPhrase` in while names *about* key
// material (`privateKeyPath`, `isPrivateKey`, `generateMnemonic`) stay out.
const KEY_MATERIAL_NAME = new RegExp(
  "^(?:get|export|raw|encoded|decrypted|decoded|my|user|wallet|account|signer|owner|payer|" +
    "deployer|admin|master|root|hd|child|main|default|current|eth|evm|sol|btc|hex|base58|bs58|base64)*" +
    "(?:privatekeys?|privkeys?|prvkeys?|secretrecoveryphrase|recoveryphrase|seedphrase|seedwords|" +
    "mnemonics?|mnemonicphrase|mnemonicwords|backupphrase|secretphrase|walletphrase|xprv|xpriv|tprv|" +
    "extendedprivatekey|privateextendedkey|wifkey)" +
    "(?:hex|bytes|buffer|buf|str|string|b58|base58|bs58|base64|b64|raw|wif|array|uint8array|u8a|" +
    "words|phrase|text|value|data)?$",
);
// `secretKey` is a key only on a keypair-shaped receiver: API SDKs (Clerk,
// Paystack) legitimately send `this.secretKey` / `options.secretKey` as a
// bearer token.
const KEYPAIR_SECRET_NAME =
  /^(?:get|export)?secretkey(?:bytes|hex|str|string|b58|base58|bs58|base64|b64|raw|array|uint8array)?$/;
// `secretKey` counts as key material only on a holder that is genuinely a
// keypair. Generic names such as `account`, `admin`, `sender` or `payer` are
// just as often an API SDK's client object, whose `secretKey` is an API
// credential sent as a bearer token, so they are not keypair-shaped here.
const KEYPAIR_RECEIVER = /(?:keypair|keypairs|kp|wallet|signer)$/;
// Wallet key files and browser-wallet extension stores: the Solana CLI keypair,
// geth keystores, Bitcoin Core's wallet.dat, Exodus, and the MetaMask and
// Phantom extension IDs whose LevelDB vaults stealers copy.
const WALLET_FILE =
  /(?:^|[\\/])solana[\\/]id\.json$|(?:^|[\\/])\.ethereum[\\/]keystore|(?:^|[\\/])keystore[\\/]UTC--|(?:^|[\\/])wallet\.dat$|exodus\.wallet|nkbihfbeogaeaoehlefnkodbefgpgknn|bfnaelmomeimhlpmgjnjophhpkkoljpa/i;
// Functions whose first parameter is key material by contract.
const KEY_FACTORY =
  /^(?:from(?:secretkey|privatekey|mnemonic|seed|seedphrase|phrase|wif|extendedkey|xprv)|import(?:privatekey|secretkey|mnemonic|wallet))$/;
const WALLET_CLASS = /(?:wallet|keypair)$/;
// A key factory or wallet constructor's first parameter is key material by
// contract — unless its name is shaped like a connection target or a config
// bag (`baseUrl`, `apiBase`, `rpcEndpoint`, `providerOptions`). Matched
// word-by-word so compound names resolve too.
const NON_KEY_PARAMETER_WORDS = new Set([
  "provider",
  "config",
  "configuration",
  "options",
  "opts",
  "settings",
  "transport",
  "client",
  "params",
  "param",
  "args",
  "arg",
  "props",
  "prop",
  "connection",
  "network",
  "url",
  "uri",
  "endpoint",
  "rpc",
  "chain",
  "base",
  "host",
  "hostname",
  "server",
  "gateway",
]);
function isNonKeyParameterName(name: string): boolean {
  return nameWords(name).some((word) => NON_KEY_PARAMETER_WORDS.has(word));
}
// Members of a key-holding value that are not the key.
const NON_SECRET_MEMBER =
  /public|pubkey|address|provider|connection|network|chainid|rpc|url|endpoint|^(?:length|bytelength|id|name|type|version|nonce|balance)$/;
// Methods that end a key's flow: the value they return is a signature, digest,
// ciphertext, key-derivation output, secret-share, or a scalar measurement, not
// the key. Everything else is treated as a reshaping of the same bytes and
// keeps the taint (a denylist, not an allowlist: an unknown method such as
// `.normalize()` or a custom codec no longer silently drops the flow). The
// sanitizer *words* below are also matched inside method names, so
// `.signTransaction()` and `.encryptToKeystore()` end the flow too.
const FLOW_ENDING_METHODS = new Set([
  "update",
  "final",
  "dump",
  "tov3",
  "derive",
  "derivekey",
  "pbkdf2",
  "scrypt",
  "hkdf",
  "secretbox",
  "box",
  "share",
  "length",
  "bytelength",
]);
// Callee words whose result is not the key itself: signatures, digests,
// ciphertexts, public keys and addresses, and boolean predicates.
const SANITIZER_WORDS = new Set([
  "sign",
  "signed",
  "signature",
  "signatures",
  "hmac",
  "hash",
  "hashed",
  "digest",
  "keccak",
  "sha",
  "ripemd",
  "blake",
  "encrypt",
  "encrypted",
  "encipher",
  "seal",
  "verify",
  "verified",
  "jwt",
  "jws",
  "public",
  "pub",
  "pubkey",
  "address",
  "neutered",
  "boolean",
  // Key-derivation, keystore and secret-sharing primitives: their output is a
  // wrapped or derived artifact, never the key itself.
  "derive",
  "pbkdf2",
  "scrypt",
  "hkdf",
  "secretbox",
  "box",
  "share",
  "dump",
  "cipher",
  "decipher",
]);
const PREDICATE_FIRST_WORDS = new Set([
  "is",
  "has",
  "can",
  "should",
  "validate",
  "check",
  "assert",
]);
// Calls that act with a key-holding value and return a receipt, a handle or
// nothing (`sendAndConfirmTransaction(conn, tx, [payer])`, `createAppAuth`,
// `new https.Agent({ key })`). The key's own flow into a network call is
// still judged at that call.
const OPAQUE_FIRST_WORDS = new Set([
  "send",
  "submit",
  "broadcast",
  "confirm",
  "deploy",
  "execute",
  "transfer",
  "simulate",
  "estimate",
  "airdrop",
  "approve",
  "subscribe",
  "connect",
  "wait",
  "request",
  "post",
  "put",
  "fetch",
  "call",
  "invoke",
  "emit",
  "dispatch",
  "log",
  "warn",
  "info",
  "debug",
  "print",
  "write",
  "append",
  "save",
  "store",
  "set",
]);
const OPAQUE_LAST_WORDS = new Set([
  "agent",
  "dispatcher",
  "client",
  "connection",
  "provider",
  "server",
  "context",
  "auth",
  "transport",
]);

const KEYWORDS = new Set([
  "break",
  "case",
  "catch",
  "class",
  "const",
  "continue",
  "debugger",
  "default",
  "delete",
  "do",
  "else",
  "export",
  "extends",
  "false",
  "finally",
  "for",
  "function",
  "if",
  "import",
  "in",
  "instanceof",
  "let",
  "new",
  "null",
  "return",
  "super",
  "switch",
  "this",
  "throw",
  "true",
  "try",
  "typeof",
  "var",
  "void",
  "while",
  "with",
  "yield",
  "await",
  "of",
]);
// Identifiers after which a newline cannot end the expression.
const OPERATOR_KEYWORDS = new Set([
  "typeof",
  "new",
  "void",
  "delete",
  "in",
  "of",
  "instanceof",
  "await",
  "yield",
  "return",
  "throw",
  "case",
  "else",
  "do",
  "extends",
]);
const CONTINUATION_KEYWORDS = new Set(["instanceof", "in", "of", "as", "satisfies"]);
const BOOLEAN_CONTEXT = new Set([
  "typeof",
  "!",
  "void",
  "delete",
  "===",
  "!==",
  "==",
  "!=",
  "<",
  ">",
  "<=",
  ">=",
  "instanceof",
  "in",
]);
const ASSIGNMENT_OPERATORS = new Set(["=", "+=", "||=", "??=", "&&="]);
const CLOSERS: Record<string, string> = { "(": ")", "[": "]", "{": "}" };

// --- Sinks -----------------------------------------------------------------

const GLOBAL_RECEIVERS = new Set(["globalThis", "window", "self", "global"]);
const BARE_CLIENTS = new Set(["axios", "got", "ky", "needle", "superagent"]);
const CALLABLE_CLIENT_MODULES = new Set([
  "axios",
  "got",
  "ky",
  "needle",
  "superagent",
  "request",
  "postman-request",
  "node-fetch",
  "cross-fetch",
  "isomorphic-fetch",
  "isomorphic-unfetch",
  "make-fetch-happen",
  "phin",
]);
// Module → egress methods. Matched against a resolved module, never a bare
// method name, so an express router's `.post(…)` is not a sink.
const MODULE_METHODS: Record<string, RegExp> = {
  http: /^(?:request|get)$/,
  https: /^(?:request|get)$/,
  http2: /^connect$/,
  axios: /^(?:request|get|post|put|patch|delete|head|options|postForm|putForm|patchForm)$/,
  got: /^(?:get|post|put|patch|delete|head|stream|paginate)$/,
  ky: /^(?:get|post|put|patch|delete|head)$/,
  needle: /^(?:get|post|put|patch|delete|head|request)$/,
  superagent: /^(?:get|post|put|patch|del|delete|head)$/,
  request: /^(?:get|post|put|patch|del|head)$/,
  "postman-request": /^(?:get|post|put|patch|del|head)$/,
  undici: /^(?:request|fetch|stream|pipeline)$/,
  dns: /^(?:resolve\w*|lookup\w*|reverse)$/,
  net: /^(?:connect|createConnection)$/,
  tls: /^(?:connect|createConnection)$/,
  jquery: /^(?:ajax|post|get|getJSON)$/,
};
const GLOBAL_MODULE_NAMES: Record<string, string> = {
  http: "http",
  https: "https",
  http2: "http2",
  axios: "axios",
  got: "got",
  ky: "ky",
  needle: "needle",
  superagent: "superagent",
  undici: "undici",
  dns: "dns",
  net: "net",
  tls: "tls",
  $: "jquery",
  jQuery: "jquery",
};
const INSTANCE_FACTORIES = /^(?:create|extend|agent)$/;
const NEW_SINKS = new Set(["WebSocket", "EventSource"]);
// A child process counts as egress only when its command names a network tool.
const SHELL_METHODS = /^(?:exec|execSync|spawn|spawnSync|execFile|execFileSync)$/;
const NETWORK_TOOL = /(?:^|[\s'"`;&|(])(?:curl|wget|nc|ncat|socat)(?=[\s'"`]|$)/;
const HANDLE_CONSTRUCTORS = new Set(["XMLHttpRequest", "WebSocket"]);
const HANDLE_METHODS = new Set(["send", "write", "end", "open", "request"]);
// Modules whose options object carries TLS client credentials: a key passed as
// `key`/`cert`/`pfx` there authenticates the connection and is never sent.
const TLS_OPTION_MODULES = new Set([
  "ws",
  "http",
  "https",
  "http2",
  "tls",
  "net",
  "got",
  "request",
  "postman-request",
]);
const TLS_OPTION_KEYS = new Set([
  "key",
  "cert",
  "pfx",
  "ca",
  "passphrase",
  "certificate",
  "crl",
  "secureContext",
]);
const TLS_CONTAINER_KEYS = new Set(["https", "tls", "agentOptions", "ssl"]);

interface Tok {
  kind: "ident" | "punct" | "string" | "literal";
  text: string;
  start: number;
  end: number;
  value?: string;
}

type Range = [number, number];

interface ModuleRef {
  module: string;
  member?: string;
}

interface Sink {
  label: string;
  module: string | null;
  tlsOptions: boolean;
}

// An existing entry makes a new one redundant when it covers the scope and is
// at least as strong: an argument-derived entry never hides an intrinsic one.
function covers(entry: TaintEntry, scope: Range, fromParam: boolean): boolean {
  return (
    entry.scope[0] <= scope[0] && scope[1] <= entry.scope[1] && (fromParam || !entry.fromParam)
  );
}

// Member calls on these receivers are platform APIs, never a method defined in
// the file, so they are not resolved to a same-named method's parameters.
const BUILTIN_RECEIVERS = new Set([
  "JSON",
  "Object",
  "Array",
  "Buffer",
  "Math",
  "Promise",
  "Reflect",
  "Number",
  "String",
  "console",
  "crypto",
  "process",
  "window",
  "document",
  "navigator",
  "globalThis",
]);

function sink(label: string, module: string | null): Sink {
  return { label, module, tlsOptions: module !== null && TLS_OPTION_MODULES.has(module) };
}

// Calls whose result is a request or socket that later `.write`/`.end` sends on.
const HANDLE_MODULES = new Set(["http", "https", "http2", "net", "tls"]);

interface PatternEntry {
  local: string;
  key: string | null;
}

interface Param {
  name?: string;
  pattern?: PatternEntry[];
}

interface FunctionDef {
  name: string | null;
  method: boolean;
  nameScope: Range;
  params: Param[];
  scope: Range;
  bodyOpen: number;
  conciseBody: Range | null;
  origin: number;
}

interface TaintEntry {
  scope: Range;
  via: number[];
  // Derived from a caller's argument rather than read inside the function.
  fromParam: boolean;
}

// `path` is the member chain from the binding, one component per member
// (`this.config.privateKey = k` taints `["config", "privateKey"]` on `this`);
// "*" stands for a computed member.
interface FieldTaint extends TaintEntry {
  path: string[];
}

// A read of member chain `read` carries the key when it reaches into the
// tainted value or takes an object that contains it, but not when it leaves
// the tainted path for a sibling: `config.host` beside `config.privateKey`.
function pathsOverlap(tainted: string[], read: string[]): boolean {
  const shared = Math.min(tainted.length, read.length);
  for (let i = 0; i < shared; i += 1) {
    if (tainted[i] !== "*" && read[i] !== "*" && tainted[i] !== read[i]) return false;
  }
  return true;
}

interface Binding {
  target:
    | { kind: "name"; name: string }
    | { kind: "field"; name: string; path: string[] }
    | { kind: "pattern"; entries: PatternEntry[] };
  scope: Range;
  rhs: Range;
  origin: number;
}

interface KeyMaterialFlow {
  /** Token-derived lines along the flow, sink first. */
  lines: number[];
  sink: string;
}

export function keyMaterialFindings(ctx: RuleContext): Finding[] {
  if (ctx.codePatternSet === "python") return [];
  const findings: Finding[] = [];
  for (const file of ctx.files) {
    if (!file.textSample || file.flags.includes("binary") || !isScannablePath(file.path)) continue;
    // Untouched files are scanned too, like credential access: the finding is
    // artifact evidence, and release attribution keeps a longstanding flow out
    // of the release delta.
    const flow = analyzeFileForFlow(file.textSample);
    if (!flow) continue;
    findings.push(
      testScope(
        isUnreachableTestFile(ctx, file.path),
        false,
        tag("codeKeyMaterialExfiltration", {
          severity: "high",
          file: file.path,
          line: reportedLine(ctx, file.path, file.textSample, flow),
          evidence: `${changedPrefix(ctx, file.path)}crypto key material flows into a network call (${flow.sink})`,
          reason:
            "a private key, mnemonic or wallet secret key is read and sent over the network in the same file: the wallet key-theft shape",
        }),
      ),
    );
  }
  return findings;
}

function isScannablePath(path: string): boolean {
  if (isDocumentationPath(path) || isTypeDeclarationPath(path) || isJsonDataPath(path)) {
    return false;
  }
  const base = path.slice(path.lastIndexOf("/") + 1);
  return JS_CODE_PATH.test(path) || !base.includes(".");
}

// Release attribution reads the finding's line. A payload that only edits the
// source read or an intermediate assignment leaves the sink line untouched, so
// the reported line is the first point of the flow this release changed.
function reportedLine(
  ctx: RuleContext,
  path: string,
  staged: string,
  flow: KeyMaterialFlow,
): number {
  const previous = ctx.previousByPath.get(path)?.textSample;
  if (ctx.diffByPath.get(path)?.status !== "modified" || !previous) return flow.lines[0];
  const changed = changedStagedLines(previous, staged);
  return flow.lines.find((line) => changed.has(line)) ?? flow.lines[0];
}

// The folded text when the file may name both key material and a sink,
// otherwise null. Checked before constant folding, so it also tries a copy with
// adjacent string literals joined and escapes decoded: a name assembled from
// pieces (`kp['sec' + 'retKey']`, `['fe', 'tch'].join('')`) still reaches the
// folded analysis. A file that calls a decoder is folded and checked again,
// since the names may only exist in what it decodes.
function foldedIfKeyMaterial(text: string): string | null {
  const collapsed = collapseLiterals(text);
  if (namesKeyMaterialAndSink(text) || namesKeyMaterialAndSink(collapsed)) {
    return normalizeCodeForScanning(text);
  }
  if (!DECODER_WORD.test(collapsed)) return null;
  const folded = normalizeCodeForScanning(text);
  return folded !== text && namesKeyMaterialAndSink(folded) ? folded : null;
}

function namesKeyMaterialAndSink(text: string): boolean {
  return KEY_MATERIAL_WORD.test(text) && SINK_WORD.test(text);
}

function collapseLiterals(text: string): string {
  return text
    .replace(/(['"`])\s*[+,]\s*\1/g, "")
    .replace(
      /\\x([0-9a-f]{2})|\\u\{?([0-9a-f]{4,6})\}?/gi,
      (_match, hex?: string, code?: string) => {
        const point = parseInt(hex ?? code ?? "", 16);
        return point <= 0x10ffff ? String.fromCodePoint(point) : "";
      },
    );
}

// The analysis runs over hostile package bytes. A throw here aborts every
// deterministic rule for the package (no caller catches), so as a last line of
// defence a failure degrades to "no key-material finding for this file" rather
// than propagating. All interior recursion is depth-bounded and the taint pass
// runs under a work budget; this catch covers anything those bounds miss.
function analyzeFileForFlow(text: string): KeyMaterialFlow | null {
  try {
    const folded = foldedIfKeyMaterial(text);
    if (folded === null) return null;
    return findKeyMaterialFlow(folded);
  } catch {
    return null;
  }
}

function findKeyMaterialFlow(source: string): KeyMaterialFlow | null {
  if (!source || source.length > MAX_SOURCE_CHARS) return null;
  if (!KEY_MATERIAL_WORD.test(source) || !SINK_WORD.test(source)) return null;
  const raw = tokenizeJsWithinBudget(source, { rejectJsx: true });
  if (!raw) return null;
  const tokens: Tok[] = [];
  const budget = { left: Math.max(64 * 1024, 2 * source.length) };
  for (const token of raw) appendToken(source, token, tokens, 0, budget);
  return new FlowAnalysis(source, tokens).run();
}

function appendToken(
  source: string,
  token: JsToken,
  out: Tok[],
  depth: number,
  budget: { left: number },
): void {
  const text = jsTokenText(source, token);
  switch (token.type) {
    case "ws":
    case "comment":
      return;
    case "ident":
    case "punct":
      out.push({ kind: token.type, text, start: token.start, end: token.end });
      return;
    case "string":
      out.push({ kind: "string", text, start: token.start, end: token.end, value: token.value });
      return;
    case "template":
      appendTemplate(source, token, out, depth, budget);
      return;
    default:
      out.push({ kind: "literal", text, start: token.start, end: token.end });
  }
}

// The lexer returns a template literal with its substitutions as one token.
// Substitutions are data flowing into the string, so they are re-lexed and
// emitted with the text chunks as a parenthesized sequence: `` `u?k=${key}` ``
// reads as `("u?k=", key)`, and a tagged template reads as the call it is.
function appendTemplate(
  source: string,
  token: JsToken,
  out: Tok[],
  depth: number,
  budget: { left: number },
): void {
  const close =
    token.end - 1 > token.start && source[token.end - 1] === "`" ? token.end - 1 : token.end;
  const parts: Tok[][] = [];
  let chunkStart = token.start + 1;
  let i = token.start + 1;
  while (i < close && depth < MAX_TEMPLATE_DEPTH) {
    if (source[i] === "\\") {
      i += 2;
      continue;
    }
    if (source[i] !== "$" || source[i + 1] !== "{") {
      i += 1;
      continue;
    }
    const exprStart = i + 2;
    const chunk = source.slice(chunkStart, i);
    if (chunk)
      parts.push([{ kind: "string", text: chunk, start: chunkStart, end: i, value: chunk }]);
    budget.left -= close - exprStart;
    if (budget.left < 0) break;
    const inner = tokenizeJsWithinBudget(source.slice(exprStart, close), { rejectJsx: true });
    if (!inner) break;
    const part: Tok[] = [];
    let level = 0;
    let exprEnd = -1;
    for (const innerToken of inner) {
      const shifted = {
        ...innerToken,
        start: innerToken.start + exprStart,
        end: innerToken.end + exprStart,
      };
      if (shifted.type === "punct") {
        const punct = jsTokenText(source, shifted);
        if (punct === "}" && level === 0) {
          exprEnd = shifted.start;
          break;
        }
        if (punct === "{") level += 1;
        if (punct === "}") level -= 1;
      }
      appendToken(source, shifted, part, depth + 1, budget);
    }
    if (exprEnd < 0) break;
    parts.push(part);
    i = exprEnd + 1;
    chunkStart = i;
  }
  const text = source.slice(token.start, token.end);
  if (!parts.length) {
    out.push({
      kind: "string",
      text,
      start: token.start,
      end: token.end,
      value: text.slice(1, -1),
    });
    return;
  }
  const tail = source.slice(chunkStart, close);
  if (tail)
    parts.push([{ kind: "string", text: tail, start: chunkStart, end: close, value: tail }]);
  out.push({ kind: "punct", text: "(", start: token.start, end: token.start });
  parts.forEach((part, index) => {
    if (index) out.push({ kind: "punct", text: ",", start: token.start, end: token.start });
    out.push(...part);
  });
  out.push({ kind: "punct", text: ")", start: close, end: close });
}

function normalizeName(name: string): string {
  return name.toLowerCase().replace(/[_$-]/g, "");
}

function isKeyMaterialName(name: string): boolean {
  return name.length <= 64 && KEY_MATERIAL_NAME.test(normalizeName(name));
}

function nameWords(name: string): string[] {
  return name
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .replace(/([A-Za-z])([0-9])/g, "$1 $2")
    .toLowerCase()
    .split(/[\s_$\d-]+/)
    .filter(Boolean);
}

function normalizeModule(specifier: string | undefined): string | null {
  if (!specifier) return null;
  const name = specifier.replace(/^node:/, "");
  return name;
}

class FlowAnalysis {
  private readonly n: number;
  private readonly close: Int32Array;
  private readonly open: Int32Array;
  private readonly parent: Int32Array;
  private readonly lineStarts: number[] = [0];
  private readonly file: Range;

  private readonly modules = new Map<string, ModuleRef>();
  private readonly handles = new Set<string>();
  private readonly declared = new Map<string, { ranges: Range[]; sorted: boolean }>();
  private readonly bindings: Binding[] = [];
  private readonly consumedAssignments = new Set<number>();
  private readonly functions: FunctionDef[] = [];
  private readonly functionByBody = new Map<number, FunctionDef>();
  private readonly bareDefs = new Map<string, FunctionDef[]>();
  private readonly methodDefs = new Map<string, FunctionDef[]>();
  private readonly calls: Array<{ def: FunctionDef; args: Range[] }> = [];
  private readonly returns: Array<{ def: FunctionDef; expr: Range }> = [];
  private readonly returnsByDef = new Map<FunctionDef, Range[]>();
  // Guards `functionSanitizesArg` against mutual recursion through a cycle of
  // same-file helpers.
  private readonly sanitizeInProgress = new Set<FunctionDef>();

  private readonly whole = new Map<string, TaintEntry[]>();
  private readonly fields = new Map<string, FieldTaint[]>();
  private readonly taintedFunctions = new Map<string, TaintEntry[]>();
  private readonly taintedMethods = new Map<string, number[]>();
  private intrinsicOnly = false;
  // A single work budget shared by every variable-length scan (expression
  // bounds, the taint reads, the sink search). It is linear in the token count,
  // so an adversarial file whose per-token work is itself O(n) — a
  // `a=a=…=1` chain, a minified bundle of near-identical taint units — stays
  // linear overall instead of quadratic. When it runs out each scanner returns
  // its best result so far and the analysis reports whatever it has found
  // rather than looping on.
  private fuel = 0;

  constructor(
    private readonly source: string,
    private readonly t: Tok[],
  ) {
    this.n = t.length;
    this.file = [0, this.n];
    this.close = new Int32Array(this.n).fill(-1);
    this.open = new Int32Array(this.n).fill(-1);
    this.parent = new Int32Array(this.n).fill(-1);
    for (let i = 0; i < source.length; i += 1) {
      if (source.charCodeAt(i) === 10) this.lineStarts.push(i + 1);
    }
    this.matchBrackets();
  }

  run(): KeyMaterialFlow | null {
    // Linear in the token count with a small floor, so neither one large file
    // nor many small adversarial files in one package can buy unbounded work.
    this.fuel = 200_000 + 40 * this.n;
    this.collectModules();
    this.collectDeclarations();
    this.collectFunctions();
    this.collectAssignments();
    this.collectHandles();
    this.collectCallsAndReturns();
    this.seedParameterSources();
    for (let pass = 0; pass < MAX_FIXPOINT_PASSES; pass += 1) {
      if (!this.propagate()) break;
    }
    return this.findSinkFlow();
  }

  // --- Token helpers -------------------------------------------------------

  private text(i: number): string {
    return i >= 0 && i < this.n ? this.t[i].text : "";
  }

  private isIdent(i: number): boolean {
    return i >= 0 && i < this.n && this.t[i].kind === "ident" && !KEYWORDS.has(this.t[i].text);
  }

  private isMemberName(i: number): boolean {
    const prev = this.text(i - 1);
    return prev === "." || prev === "?.";
  }

  private isObjectKey(i: number): boolean {
    const prev = this.text(i - 1);
    return this.text(i + 1) === ":" && (prev === "{" || prev === ",");
  }

  private lineOf(i: number): number {
    const offset = this.t[Math.min(i, this.n - 1)].start;
    let lo = 0;
    let hi = this.lineStarts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (this.lineStarts[mid] <= offset) lo = mid;
      else hi = mid - 1;
    }
    return lo + 1;
  }

  private matchBrackets(): void {
    const stack: number[] = [];
    for (let i = 0; i < this.n; i += 1) {
      this.parent[i] = stack.length ? stack[stack.length - 1] : -1;
      const token = this.t[i];
      if (token.kind !== "punct") continue;
      if (CLOSERS[token.text]) {
        stack.push(i);
        this.close[i] = this.n;
        continue;
      }
      const top = stack[stack.length - 1];
      if (top !== undefined && CLOSERS[this.t[top].text] === token.text) {
        stack.pop();
        this.close[top] = i;
        this.open[i] = top;
        this.parent[i] = this.parent[top];
      }
    }
  }

  private isFunctionBody(brace: number): boolean {
    if (this.text(brace) !== "{") return false;
    const prev = this.text(brace - 1);
    if (prev === "=>") return true;
    if (prev !== ")" || this.open[brace - 1] < 0) return false;
    const head = this.text(this.open[brace - 1] - 1);
    return !["if", "for", "while", "switch", "catch", "with"].includes(head);
  }

  private blockScopeOf(i: number, functionScoped: boolean): Range {
    for (let p = this.parent[i]; p >= 0; p = this.parent[p]) {
      if (this.text(p) !== "{") continue;
      if (!functionScoped || this.isFunctionBody(p)) return [p, this.close[p] + 1];
    }
    return this.file;
  }

  // Scopes are bracket ranges, so they nest or are disjoint: of the ranges
  // containing `at`, the one starting last is the innermost. Sorted by start
  // (outer first on ties), it is the first containing range walking back from
  // the last start at or before `at`.
  private resolveScope(name: string, at: number): Range {
    const declared = this.declared.get(name);
    if (!declared) return this.file;
    const { ranges } = declared;
    if (!declared.sorted) {
      ranges.sort((a, b) => a[0] - b[0] || b[1] - a[1]);
      declared.sorted = true;
    }
    let lo = 0;
    let hi = ranges.length - 1;
    let last = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (ranges[mid][0] <= at) {
        last = mid;
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }
    for (let i = last, steps = 0; i >= 0 && steps < MAX_SCOPE_SCAN; i -= 1, steps += 1) {
      if (at < ranges[i][1]) return ranges[i];
    }
    return this.file;
  }

  private declare(name: string, scope: Range): void {
    const declared = this.declared.get(name);
    if (declared) {
      declared.ranges.push(scope);
      declared.sorted = false;
    } else {
      this.declared.set(name, { ranges: [scope], sorted: true });
    }
  }

  private isValueEnd(i: number): boolean {
    const token = this.t[i];
    if (!token) return false;
    if (token.kind === "string" || token.kind === "literal") return true;
    if (token.kind === "ident") return !OPERATOR_KEYWORDS.has(token.text);
    return [")", "]", "}", "++", "--"].includes(token.text);
  }

  // A newline between a complete operand and an identifier ends the statement
  // (automatic semicolon insertion); every other newline continues it.
  private statementBreak(k: number): boolean {
    const token = this.t[k];
    if (token.kind !== "ident" || CONTINUATION_KEYWORDS.has(token.text)) return false;
    if (!this.isValueEnd(k - 1)) return false;
    return this.source.slice(this.t[k - 1].end, token.start).includes("\n");
  }

  // End (exclusive) of the expression starting at `s`: the first `,`, `;` or
  // enclosing closer at the same depth, or a statement break.
  private exprEnd(s: number): number {
    let k = s;
    while (k < this.n) {
      if (--this.fuel <= 0) return k;
      const token = this.t[k];
      if (token.kind === "punct") {
        if (token.text === "," || token.text === ";") return k;
        if (token.text === ")" || token.text === "]" || token.text === "}") return k;
        if (this.close[k] >= 0) {
          k = this.close[k] + 1;
          continue;
        }
      }
      if (k > s && this.statementBreak(k)) return k;
      k += 1;
    }
    return this.n;
  }

  // End of the comma-separated element starting at `j` inside an opener whose
  // closer is `limit`.
  private elementEnd(j: number, limit: number): number {
    let k = j;
    while (k < limit) {
      if (this.text(k) === ",") return k;
      k = this.close[k] >= 0 ? this.close[k] + 1 : k + 1;
    }
    return limit;
  }

  private elements(openIndex: number): Range[] {
    const limit = Math.min(this.close[openIndex], this.n);
    const out: Range[] = [];
    let j = openIndex + 1;
    while (j < limit) {
      const end = this.elementEnd(j, limit);
      if (end > j) out.push([j, end]);
      j = end + 1;
    }
    return out;
  }

  // --- Collection ----------------------------------------------------------

  private collectModules(): void {
    for (let i = 0; i < this.n; i += 1) {
      const word = this.text(i);
      if (word === "require" && !this.isMemberName(i) && this.text(i + 1) === "(") {
        const specifier = this.t[i + 2];
        if (specifier?.kind !== "string" || this.text(i + 3) !== ")") continue;
        const module = normalizeModule(specifier.value);
        if (!module) continue;
        const member =
          this.text(i + 4) === "." && this.isIdentLike(i + 5) ? this.text(i + 5) : undefined;
        const assign = i - 1;
        if (this.text(assign) !== "=") continue;
        if (this.isIdent(assign - 1) && !this.isMemberName(assign - 1)) {
          this.modules.set(this.text(assign - 1), {
            module,
            member: member === "default" ? undefined : member,
          });
        } else if (this.text(assign - 1) === "}" && this.open[assign - 1] >= 0) {
          for (const entry of this.patternEntries(this.open[assign - 1])) {
            if (entry.key) this.modules.set(entry.local, { module, member: entry.key });
          }
        }
      } else if (word === "import" && !this.isMemberName(i) && this.text(i + 1) !== "(") {
        this.collectImport(i);
      }
    }
    // Client instances: `const api = axios.create(…)`.
    for (let i = 0; i + 4 < this.n; i += 1) {
      if (this.text(i + 1) !== "=" || !this.isIdent(i) || this.isMemberName(i)) continue;
      const ref = this.moduleOf(i + 2);
      if (
        ref &&
        CALLABLE_CLIENT_MODULES.has(ref) &&
        this.text(i + 3) === "." &&
        INSTANCE_FACTORIES.test(this.text(i + 4)) &&
        this.text(i + 5) === "("
      ) {
        this.modules.set(this.text(i), { module: ref });
      }
    }
  }

  private isIdentLike(i: number): boolean {
    return i >= 0 && i < this.n && this.t[i].kind === "ident";
  }

  private collectImport(i: number): void {
    let from = -1;
    for (let j = i + 1; j < Math.min(this.n, i + 64); j += 1) {
      if (this.text(j) === ";") return;
      if (this.text(j) === "from" && this.t[j + 1]?.kind === "string") {
        from = j;
        break;
      }
    }
    if (from < 0) return;
    const module = normalizeModule(this.t[from + 1].value);
    if (!module) return;
    for (let j = i + 1; j < from; j += 1) {
      if (this.text(j) === "*" && this.text(j + 1) === "as" && this.isIdent(j + 2)) {
        this.modules.set(this.text(j + 2), { module });
        j += 2;
      } else if (this.text(j) === "{") {
        const end = Math.min(this.close[j], from);
        for (const [start, stop] of this.elements(j)) {
          if (stop > end) break;
          const imported = this.text(start);
          const local = this.text(start + 1) === "as" ? this.text(start + 2) : imported;
          if (local && imported !== "type") {
            this.modules.set(local, {
              module,
              member: imported === "default" ? undefined : imported,
            });
          }
        }
        j = end;
      } else if (this.isIdent(j) && this.text(j) !== "type") {
        this.modules.set(this.text(j), { module });
      }
    }
  }

  // Module behind the receiver token `r`, if it names one. Iterative and
  // depth-bounded: a hostile `dns.promises.promises…resolve(key)` chain would
  // otherwise recurse once per `.promises` and overflow the stack.
  private moduleOf(r: number): string | null {
    let j = r;
    for (let steps = 0; steps < MAX_CHAIN_STEPS; steps += 1) {
      const token = this.t[j];
      if (!token) return null;
      if (token.kind === "ident") {
        if (this.isMemberName(j)) {
          // `dns.promises.resolve(…)`: peel the `.promises` hop and continue.
          if (token.text !== "promises") return null;
          j -= 2;
          continue;
        }
        const ref = this.modules.get(token.text);
        if (ref) return ref.member === undefined ? ref.module : null;
        return GLOBAL_MODULE_NAMES[token.text] ?? null;
      }
      if (token.text === ")" && this.open[j] > 0) {
        const o = this.open[j];
        if (this.text(o - 1) === "require" && this.t[o + 1]?.kind === "string" && o + 2 === j) {
          return normalizeModule(this.t[o + 1].value);
        }
      }
      return null;
    }
    return null;
  }

  private collectDeclarations(): void {
    for (let i = 0; i < this.n; i += 1) {
      const word = this.text(i);
      if (word === "catch" && this.text(i + 1) === "(" && this.close[i + 1] < this.n) {
        const body = this.close[i + 1] + 1;
        const end = this.text(body) === "{" ? Math.min(this.close[body], this.n - 1) + 1 : body;
        const scope: Range = [i + 1, end];
        if (this.isIdent(i + 2)) this.declare(this.text(i + 2), scope);
        else if (this.text(i + 2) === "{" || this.text(i + 2) === "[") {
          for (const entry of this.patternEntries(i + 2)) this.declare(entry.local, scope);
        }
        continue;
      }
      if ((word !== "const" && word !== "let" && word !== "var") || this.isMemberName(i)) continue;
      const functionScoped = word === "var";
      let j = i + 1;
      while (j < this.n) {
        let targetEnd: number;
        let target: Binding["target"];
        if (this.isIdent(j)) {
          target = { kind: "name", name: this.text(j) };
          targetEnd = j + 1;
        } else if ((this.text(j) === "{" || this.text(j) === "[") && this.close[j] < this.n) {
          target = { kind: "pattern", entries: this.patternEntries(j) };
          targetEnd = this.close[j] + 1;
        } else {
          break;
        }
        const scope = this.blockScopeOf(i, functionScoped);
        const names = target.kind === "name" ? [target.name] : target.entries.map((e) => e.local);
        for (const name of names) this.declare(name, scope);
        let next = targetEnd;
        // TypeScript annotation: skip to the initializer or the next declarator.
        if (this.text(next) === ":") next = this.skipAnnotation(next + 1);
        if (this.text(next) === "=" || this.text(next) === "of") {
          const rhsStart = next + 1;
          const rhsEnd = this.text(next) === "of" ? this.ofEnd(rhsStart) : this.exprEnd(rhsStart);
          this.consumedAssignments.add(next);
          this.bindings.push({ target, scope, rhs: [rhsStart, rhsEnd], origin: j });
          next = rhsEnd;
        }
        if (this.text(next) !== ",") break;
        j = next + 1;
      }
    }
  }

  private skipAnnotation(j: number): number {
    let k = j;
    while (k < this.n && ![",", ";", "=", ")"].includes(this.text(k))) {
      k = this.close[k] >= 0 ? this.close[k] + 1 : k + 1;
    }
    return k;
  }

  // `for (const x of EXPR)`: EXPR runs to the head's closing paren.
  private ofEnd(s: number): number {
    const p = this.parent[s];
    return p >= 0 && this.text(p) === "(" ? Math.min(this.close[p], this.n) : this.exprEnd(s);
  }

  // Bound names of a destructuring pattern, with the property each is read
  // from (`null` for array elements and rest elements).
  private patternEntries(o: number, outerKey: string | null = null, depth = 0): PatternEntry[] {
    const entries: PatternEntry[] = [];
    const object = this.text(o) === "{";
    for (const [start, end] of this.elements(o)) {
      if (this.text(start) === "...") {
        if (this.isIdent(start + 1)) entries.push({ local: this.text(start + 1), key: outerKey });
        continue;
      }
      let valueAt = start;
      let key = outerKey;
      if (object) {
        const keyToken = this.t[start];
        if (keyToken.kind === "string") key = keyToken.value ?? null;
        else if (keyToken.kind === "ident") key = keyToken.text;
        else key = null;
        if (this.text(start + 1) === ":") valueAt = start + 2;
      }
      if (valueAt >= end) continue;
      const opener = this.text(valueAt);
      if ((opener === "{" || opener === "[") && depth < 4 && this.close[valueAt] < end) {
        entries.push(...this.patternEntries(valueAt, key, depth + 1));
      } else if (this.isIdent(valueAt)) {
        entries.push({ local: this.text(valueAt), key: object ? key : outerKey });
      }
    }
    return entries;
  }

  private collectFunctions(): void {
    for (let i = 0; i < this.n; i += 1) {
      if (this.text(i) === "{" && this.text(i - 1) === ")" && this.isFunctionBody(i)) {
        const paramsOpen = this.open[i - 1];
        this.addFunction(paramsOpen, i, null, paramsOpen - 1);
      } else if (this.text(i) === "=>") {
        const before = i - 1;
        let paramsStart: number;
        if (this.text(before) === ")" && this.open[before] >= 0) paramsStart = this.open[before];
        else if (this.isIdent(before)) paramsStart = before;
        else continue;
        const bodyStart = i + 1;
        const concise = this.text(bodyStart) !== "{";
        const bodyEnd = concise
          ? this.exprEnd(bodyStart)
          : Math.min(this.close[bodyStart], this.n - 1) + 1;
        let head = paramsStart - 1;
        if (this.text(head) === "async") head -= 1;
        this.addFunction(
          paramsStart,
          concise ? -1 : bodyStart,
          concise ? [bodyStart, bodyEnd] : null,
          head,
          bodyEnd,
        );
      }
    }
  }

  // `head` is the token before the parameter list (or before `async`).
  private addFunction(
    paramsStart: number,
    bodyOpen: number,
    conciseBody: Range | null,
    head: number,
    arrowEnd?: number,
  ): void {
    const end =
      bodyOpen >= 0 ? Math.min(this.close[bodyOpen], this.n - 1) + 1 : (arrowEnd ?? this.n);
    const scope: Range = [paramsStart, end];
    let name: string | null = null;
    let method = false;
    let nameScope: Range = this.file;
    const headText = this.text(head);
    const arrow = conciseBody !== null || this.text(bodyOpen - 1) === "=>";
    if (!arrow && this.isIdent(head) && !this.isMemberName(head)) {
      const beforeHead = this.text(head - 1) === "*" ? head - 2 : head - 1;
      name = headText;
      if (this.text(beforeHead) === "function") {
        nameScope = this.blockScopeOf(beforeHead, true);
      } else {
        method = true;
      }
    } else {
      // `NAME = function (…)`, `NAME = (…) =>`, `NAME: function (…)`.
      let assign = head;
      if (!arrow && headText === "function") assign = head - 1;
      else if (!arrow) assign = -1;
      if (this.text(assign) === "async") assign -= 1;
      const target = assign - 1;
      if (this.text(assign) === "=" && this.isIdent(target) && !this.isMemberName(target)) {
        name = this.text(target);
        nameScope = this.resolveScope(name, target);
      } else if (this.text(assign) === ":" && this.isIdentLike(target)) {
        name = this.text(target);
        method = true;
      } else if (
        this.text(assign) === "=" &&
        this.isIdentLike(target) &&
        this.isMemberName(target)
      ) {
        // `exports.send = function (…)`, `Client.prototype.send = …`.
        name = this.text(target);
        method = true;
      }
    }
    const params = this.parseParams(paramsStart);
    for (const param of params) {
      if (param.name) this.declare(param.name, scope);
      for (const entry of param.pattern ?? []) this.declare(entry.local, scope);
    }
    const def: FunctionDef = {
      name,
      method,
      nameScope,
      params,
      scope,
      bodyOpen,
      conciseBody,
      origin: paramsStart,
    };
    this.functions.push(def);
    if (bodyOpen >= 0) this.functionByBody.set(bodyOpen, def);
    if (name) {
      const registry = method ? this.methodDefs : this.bareDefs;
      const defs = registry.get(name);
      if (defs) defs.push(def);
      else registry.set(name, [def]);
    }
  }

  private parseParams(paramsStart: number): Param[] {
    if (this.text(paramsStart) !== "(") {
      return this.isIdent(paramsStart) ? [{ name: this.text(paramsStart) }] : [];
    }
    return this.elements(paramsStart).map(([start]) => {
      const at = this.text(start) === "..." ? start + 1 : start;
      if (this.isIdent(at)) return { name: this.text(at) };
      if ((this.text(at) === "{" || this.text(at) === "[") && this.close[at] < this.n) {
        return { pattern: this.patternEntries(at) };
      }
      return {};
    });
  }

  private collectAssignments(): void {
    for (let q = 1; q < this.n; q += 1) {
      if (!ASSIGNMENT_OPERATORS.has(this.text(q)) || this.consumedAssignments.has(q)) continue;
      if (this.t[q].kind !== "punct") continue;
      const rhs: Range = [q + 1, this.exprEnd(q + 1)];
      const lhs = q - 1;
      if (this.isIdent(lhs) && !this.isMemberName(lhs)) {
        const name = this.text(lhs);
        this.bindings.push({
          target: { kind: "name", name },
          scope: this.resolveScope(name, lhs),
          rhs,
          origin: lhs,
        });
        continue;
      }
      // `data.key = …` / `data[k] = …` taints the field on `data`.
      let root = -1;
      let path = ["*"];
      if (this.isIdentLike(lhs) && this.isMemberName(lhs)) {
        let j = lhs;
        path = [];
        while (this.isMemberName(j) && this.isIdentLike(j - 2) && path.length < MAX_MEMBER_PATH) {
          path.unshift(this.text(j));
          j -= 2;
        }
        root = j;
      } else if (this.text(lhs) === "]" && this.open[lhs] > 0) {
        root = this.open[lhs] - 1;
        const key = this.t[this.open[lhs] + 1];
        if (key?.kind === "string" && this.open[lhs] + 2 === lhs) path = [key.value ?? "*"];
      }
      if (root >= 0 && this.isIdentLike(root) && !this.isMemberName(root)) {
        const name = this.text(root);
        // `this.<field> = …` inside a method: the field belongs to the
        // instance, so it is visible across the sibling methods of the class.
        if (name === "this") {
          this.bindings.push({
            target: { kind: "field", name: "this", path },
            scope: this.thisScope(root),
            rhs,
            origin: lhs,
          });
        } else if (this.isIdent(root)) {
          this.bindings.push({
            target: { kind: "field", name, path },
            scope: this.resolveScope(name, root),
            rhs,
            origin: lhs,
          });
        }
      }
    }
  }

  // The range `this` refers to at token `i`: the body of the enclosing class
  // when the reference is inside a method (so `this.x` set in one method is
  // seen in another), otherwise the enclosing function body.
  private thisScope(i: number): Range {
    const body = this.enclosingFunctionBody(i);
    if (body < 0) return this.file;
    const outer = this.parent[body];
    if (outer >= 0 && this.text(outer) === "{" && this.close[outer] < this.n) {
      return [outer, this.close[outer] + 1];
    }
    return [body, Math.min(this.close[body], this.n - 1) + 1];
  }

  private collectHandles(): void {
    for (const binding of this.bindings) {
      if (binding.target.kind !== "name") continue;
      const [s] = binding.rhs;
      if (this.text(s) === "new" && HANDLE_CONSTRUCTORS.has(this.text(s + 1))) {
        this.handles.add(binding.target.name);
        continue;
      }
      let callee = s;
      while (this.text(callee + 1) === "." && this.isIdentLike(callee + 2)) callee += 2;
      const module =
        this.isIdentLike(callee) && this.text(callee + 1) === "(" ? this.sinkModule(callee) : null;
      if (module && HANDLE_MODULES.has(module)) this.handles.add(binding.target.name);
    }
  }

  private collectCallsAndReturns(): void {
    for (let c = 0; c < this.n; c += 1) {
      if (!this.isIdentLike(c) || this.text(c + 1) !== "(") continue;
      const paren = c + 1;
      const after = Math.min(this.close[paren], this.n - 1) + 1;
      // Definition shapes, not calls.
      if (this.text(c - 1) === "function" || this.text(after) === "=>") continue;
      if (this.text(after) === "{" && this.isFunctionBody(after)) continue;
      const def = this.resolveCall(c);
      if (def.length) {
        const args = this.elements(paren);
        for (const target of def) this.calls.push({ def: target, args });
      }
    }
    for (let r = 0; r < this.n; r += 1) {
      if (this.text(r) !== "return") continue;
      const body = this.enclosingFunctionBody(r);
      const def = body >= 0 ? this.functionByBody.get(body) : undefined;
      const end = this.exprEnd(r + 1);
      if (def?.name && end > r + 1) this.recordReturn(def, [r + 1, end]);
    }
    for (const def of this.functions) {
      if (def.name && def.conciseBody) this.recordReturn(def, def.conciseBody);
    }
  }

  private recordReturn(def: FunctionDef, expr: Range): void {
    this.returns.push({ def, expr });
    const existing = this.returnsByDef.get(def);
    if (existing) existing.push(expr);
    else this.returnsByDef.set(def, [expr]);
  }

  // Whether calling `def` yields a value that does not carry its argument's
  // key material: every one of its return expressions is free of a tainted
  // read (a signature, a ciphertext, a derived or public artifact), or it
  // returns nothing at all. Judged against the current taint state, so a
  // caller that passes key material has already seeded the relevant parameter.
  private functionSanitizesArg(def: FunctionDef): boolean {
    const returns = this.returnsByDef.get(def);
    if (!returns || !returns.length) return true;
    if (this.sanitizeInProgress.has(def)) return false;
    this.sanitizeInProgress.add(def);
    try {
      return returns.every(([s, e]) => this.taintedReadIn(s, e) < 0);
    } finally {
      this.sanitizeInProgress.delete(def);
    }
  }

  // The same-file function definitions a bare callee at `c` resolves to, or
  // null when it resolves to none (or too many to follow).
  private sameFileDefs(c: number): FunctionDef[] | null {
    const defs = this.resolveCall(c);
    return defs.length ? defs : null;
  }

  private enclosingFunctionBody(i: number): number {
    for (let p = this.parent[i]; p >= 0; p = this.parent[p]) {
      if (this.isFunctionBody(p)) return p;
    }
    return -1;
  }

  private resolveCall(c: number): FunctionDef[] {
    const name = this.text(c);
    if (this.isMemberName(c)) {
      if (BUILTIN_RECEIVERS.has(this.text(c - 2))) return [];
      const defs = this.methodDefs.get(name) ?? [];
      return defs.length <= MAX_DEFINITIONS_PER_NAME ? defs : [];
    }
    const all = this.bareDefs.get(name) ?? [];
    if (all.length > MAX_SCOPED_DEFINITIONS) return [];
    const defs = all.filter((def) => def.nameScope[0] <= c && c < def.nameScope[1]);
    if (!defs.length || defs.length > MAX_DEFINITIONS_PER_NAME) return [];
    return [
      defs.reduce((a, b) =>
        b.nameScope[1] - b.nameScope[0] < a.nameScope[1] - a.nameScope[0] ? b : a,
      ),
    ];
  }

  // A destructured parameter that pulls key material off its argument
  // (`function f({ privateKey: pk })`) binds key material whatever the caller,
  // and so does the first parameter of a key factory or wallet constructor
  // (`Keypair.fromSecretKey = function (bytes)`, a hooked `class Wallet`).
  private seedParameterSources(): void {
    for (const def of this.functions) {
      const first = def.params[0];
      if (first && this.isKeyConstructor(def)) {
        if (first.name && !isNonKeyParameterName(first.name)) {
          this.addWhole(first.name, def.scope, [def.origin], false);
        }
        for (const entry of first.pattern ?? []) {
          if (entry.key && NON_SECRET_MEMBER.test(normalizeName(entry.key))) continue;
          this.addWhole(entry.local, def.scope, [def.origin], false);
        }
      }
      for (const param of def.params) {
        for (const entry of param.pattern ?? []) {
          if (entry.key && isKeyMaterialName(entry.key)) {
            this.addWhole(entry.local, def.scope, [def.origin], false);
          }
        }
      }
    }
  }

  private isKeyConstructor(def: FunctionDef): boolean {
    if (!def.name) return false;
    if (KEY_FACTORY.test(normalizeName(def.name))) return true;
    const name = def.name === "constructor" && def.method ? this.className(def.origin) : def.name;
    return Boolean(name && /^[A-Z]/.test(name) && WALLET_CLASS.test(normalizeName(name)));
  }

  // Name of the class whose body holds the method at `paramsStart`:
  // `class Wallet extends Base {` or `Wallet = class extends Base {`.
  private className(paramsStart: number): string | null {
    const body = this.parent[paramsStart];
    if (this.text(body) !== "{") return null;
    for (let j = body - 1; j >= Math.max(0, body - 12); j -= 1) {
      if (this.text(j) !== "class") continue;
      if (this.isIdent(j + 1)) return this.text(j + 1);
      return this.text(j - 1) === "=" && this.isIdentLike(j - 2) ? this.text(j - 2) : null;
    }
    return null;
  }

  // --- Taint state ---------------------------------------------------------

  private addWhole(name: string, scope: Range, via: number[], fromParam: boolean): boolean {
    const entries = this.whole.get(name);
    if (entries?.some((e) => covers(e, scope, fromParam))) return false;
    if (entries && entries.length >= MAX_ENTRIES_PER_NAME) return false;
    const entry = { scope, via: via.slice(0, MAX_VIA), fromParam };
    if (entries) entries.push(entry);
    else this.whole.set(name, [entry]);
    return true;
  }

  private addField(
    name: string,
    path: string[],
    scope: Range,
    via: number[],
    fromParam: boolean,
  ): boolean {
    const entries = this.fields.get(name);
    const key = path.join("\0");
    if (entries?.some((e) => e.path.join("\0") === key && covers(e, scope, fromParam))) {
      return false;
    }
    if (entries && entries.length >= MAX_ENTRIES_PER_NAME) return false;
    const entry = { scope, path, via: via.slice(0, MAX_VIA), fromParam };
    if (entries) entries.push(entry);
    else this.fields.set(name, [entry]);
    return true;
  }

  private wholeAt(name: string, at: number): TaintEntry | undefined {
    return this.whole.get(name)?.find((e) => this.visible(e, at));
  }

  private fieldsAt(name: string, at: number): FieldTaint[] {
    return (this.fields.get(name) ?? []).filter((e) => this.visible(e, at));
  }

  private visible(entry: TaintEntry, at: number): boolean {
    return entry.scope[0] <= at && at < entry.scope[1] && !(this.intrinsicOnly && entry.fromParam);
  }

  // Whether the read at `k` carries taint that a caller's argument supplied.
  private fromParamRead(k: number): boolean {
    const token = this.t[k];
    if (token.kind !== "ident" || this.isMemberName(k)) return false;
    const entry = this.wholeAt(token.text, k) ?? this.fieldsAt(token.text, k)[0];
    return entry?.fromParam ?? false;
  }

  private propagate(): boolean {
    let changed = false;
    for (const binding of this.bindings) {
      changed = this.applyBinding(binding) || changed;
    }
    for (const { def, args } of this.calls) {
      for (let index = 0; index < args.length && index < def.params.length; index += 1) {
        const arg = args[index];
        // Positions after a spread argument are unknown.
        if (this.text(arg[0]) === "...") break;
        const param = def.params[index];
        if (!param.name && !param.pattern) continue;
        const read = this.taintedReadIn(arg[0], arg[1]);
        if (read < 0) continue;
        const via = [arg[0], read, ...this.viaOf(read)];
        if (param.name) changed = this.addWhole(param.name, def.scope, via, true) || changed;
        for (const entry of param.pattern ?? []) {
          if (entry.key && NON_SECRET_MEMBER.test(normalizeName(entry.key))) continue;
          changed = this.addWhole(entry.local, def.scope, via, true) || changed;
        }
      }
    }
    for (const { def, expr } of this.returns) {
      if (!def.name) continue;
      const registry = def.method ? this.methodDefs : this.bareDefs;
      if ((registry.get(def.name)?.length ?? 0) > MAX_DEFINITIONS_PER_NAME) continue;
      // Only key material the function reads itself makes every call's result
      // tainted. Taint a caller passed in already flows through the call
      // expression at that call site; counting it here would taint every
      // other call of a shared helper (`bufToB64Url(publicKey)`).
      this.intrinsicOnly = true;
      const read = this.taintedReadIn(expr[0], expr[1]);
      this.intrinsicOnly = false;
      if (read < 0) continue;
      const via = [expr[0], read, ...this.viaOf(read)];
      if (def.method) {
        if (!this.taintedMethods.has(def.name)) {
          this.taintedMethods.set(def.name, via.slice(0, MAX_VIA));
          changed = true;
        }
      } else {
        const entries = this.taintedFunctions.get(def.name) ?? [];
        if (!entries.some((e) => e.scope === def.nameScope)) {
          entries.push({ scope: def.nameScope, via: via.slice(0, MAX_VIA), fromParam: false });
          this.taintedFunctions.set(def.name, entries);
          changed = true;
        }
      }
    }
    return changed;
  }

  private applyBinding(binding: Binding): boolean {
    const { target, scope, rhs } = binding;
    if (target.kind === "pattern") {
      let changed = false;
      const read = this.taintedReadIn(rhs[0], rhs[1]);
      const single = rhs[1] - rhs[0] === 1 && this.isIdent(rhs[0]) ? this.text(rhs[0]) : null;
      const fieldOnly =
        single && !this.wholeAt(single, rhs[0]) ? this.fieldsAt(single, rhs[0]) : [];
      for (const entry of target.entries) {
        const key = entry.key;
        let via: number[] | null = null;
        let fromParam = false;
        if (key && isKeyMaterialName(key)) via = [binding.origin, rhs[0]];
        else if (
          key &&
          KEYPAIR_SECRET_NAME.test(normalizeName(key)) &&
          this.keypairReceiver(rhs[1] - 1)
        ) {
          via = [binding.origin, rhs[0]];
        } else if (fieldOnly.length) {
          const hit = fieldOnly.find((e) => pathsOverlap(e.path, [key ?? "*"]));
          if (hit) {
            via = [binding.origin, rhs[0], ...hit.via];
            fromParam = hit.fromParam;
          }
        } else if (read >= 0 && !(key && NON_SECRET_MEMBER.test(normalizeName(key)))) {
          via = [binding.origin, read, ...this.viaOf(read)];
          fromParam = this.fromParamRead(read);
        }
        if (via) changed = this.addWhole(entry.local, scope, via, fromParam) || changed;
      }
      return changed;
    }
    // An object literal taints only the fields that carry key material, so
    // `config.timeout` stays clean while `config` passed whole, or
    // `JSON.stringify(config)`, still carries the key.
    if (target.kind === "name" && this.text(rhs[0]) === "{" && this.close[rhs[0]] === rhs[1] - 1) {
      const decomposed = this.applyObjectLiteralBinding(target.name, scope, rhs[0], binding.origin);
      if (decomposed !== "whole") return decomposed;
    }
    const read = this.taintedReadIn(rhs[0], rhs[1]);
    if (read < 0) return false;
    const via = [binding.origin, read, ...this.viaOf(read)];
    const fromParam = this.fromParamRead(read);
    return target.kind === "name"
      ? this.addWhole(target.name, scope, via, fromParam)
      : this.addField(target.name, target.path, scope, via, fromParam);
  }

  // Taints each key-material field of an object literal bound to `name`.
  // Returns "whole" when a field cannot be attributed (a spread or a computed
  // key carrying key material), so the caller falls back to tainting the whole
  // binding.
  private applyObjectLiteralBinding(
    name: string,
    scope: Range,
    open: number,
    origin: number,
  ): boolean | "whole" {
    let changed = false;
    for (const [start, end] of this.elements(open)) {
      if (this.text(start) === "...") {
        if (this.taintedReadIn(start + 1, end) >= 0) return "whole";
        continue;
      }
      if (this.text(start) === "[") {
        if (this.taintedReadIn(start, end) >= 0) return "whole";
        continue;
      }
      const keyToken = this.t[start];
      const key =
        keyToken.kind === "string"
          ? (keyToken.value ?? null)
          : keyToken.kind === "ident" || keyToken.kind === "literal"
            ? keyToken.text
            : null;
      const valueStart = this.text(start + 1) === ":" ? start + 2 : start;
      const read = this.taintedReadIn(valueStart, end);
      if (read < 0) continue;
      if (key && NON_SECRET_MEMBER.test(normalizeName(key))) continue;
      const via = [origin, read, ...this.viaOf(read)];
      changed = this.addField(name, [key ?? "*"], scope, via, this.fromParamRead(read)) || changed;
    }
    return changed;
  }

  // Token indices along the flow that produced the value read at `k`.
  private viaOf(k: number): number[] {
    const token = this.t[k];
    if (token.kind !== "ident" || this.isMemberName(k)) return [];
    return this.wholeAt(token.text, k)?.via ?? this.fieldsAt(token.text, k)[0]?.via ?? [];
  }

  // --- Reads ---------------------------------------------------------------

  // Index of the first read in [start, end) that carries key material into
  // the expression's value, or -1. Function bodies are code, not data, and
  // `skip` ranges are option values that are never transmitted.
  private taintedReadIn(start: number, end: number, skip: Range[] = []): number {
    for (let k = start; k < end; k += 1) {
      if (--this.fuel <= 0) return -1;
      const skipped = skip.find((range) => range[0] === k);
      if (skipped) {
        k = skipped[1] - 1;
        continue;
      }
      const after = this.functionExtent(k);
      if (after > k) {
        k = after - 1;
        continue;
      }
      if (this.isTaintedRead(k) && !this.isNeutralized(k, start)) return k;
    }
    return -1;
  }

  // Index just past the function or class expression starting at `k`, or `k`.
  private functionExtent(k: number): number {
    const word = this.text(k);
    if (this.t[k].kind === "ident" && word === "function") {
      let j = k + 1;
      if (this.text(j) === "*") j += 1;
      if (this.isIdentLike(j)) j += 1;
      if (this.text(j) !== "(") return k;
      const body = Math.min(this.close[j], this.n - 1) + 1;
      return this.text(body) === "{" ? Math.min(this.close[body], this.n - 1) + 1 : k;
    }
    if (this.t[k].kind === "ident" && word === "class") {
      for (let j = k + 1; j < Math.min(this.n, k + 32); j += 1) {
        if (this.text(j) === "{") return Math.min(this.close[j], this.n - 1) + 1;
        if (this.close[j] >= 0) j = this.close[j];
      }
      return k;
    }
    if (word === "(" && this.close[k] >= 0 && this.text(this.close[k] + 1) === "=>") {
      return this.arrowEnd(this.close[k] + 1);
    }
    // Inside an expression, a parameter list followed by a block can only be
    // a method body, whatever its key: `{ "src/mod.ts"() { … } }`, `[k]() {}`.
    if (
      word === "(" &&
      this.close[k] >= 0 &&
      this.close[k] < this.n &&
      this.text(this.close[k] + 1) === "{"
    ) {
      return Math.min(this.close[this.close[k] + 1], this.n - 1) + 1;
    }
    if (this.isIdent(k) && this.text(k + 1) === "=>") return this.arrowEnd(k + 1);
    // Method shorthand in an object literal: `{ get(key) { … } }`.
    if (
      this.isIdentLike(k) &&
      !this.isMemberName(k) &&
      this.text(k + 1) === "(" &&
      ["{", ",", "}", ";", "async", "get", "set", "static", "*"].includes(this.text(k - 1))
    ) {
      const body = Math.min(this.close[k + 1], this.n - 1) + 1;
      if (this.text(body) === "{") return Math.min(this.close[body], this.n - 1) + 1;
    }
    return k;
  }

  private arrowEnd(arrow: number): number {
    const body = arrow + 1;
    if (this.text(body) === "{") return Math.min(this.close[body], this.n - 1) + 1;
    return this.exprEnd(body);
  }

  private isTaintedRead(k: number): boolean {
    const token = this.t[k];
    if (token.kind === "string") {
      const value = token.value ?? "";
      if (WALLET_FILE.test(value) || this.joinedPathIsWalletFile(k)) return true;
      // Computed member with a literal key: `process.env['PRIVATE_KEY']`.
      if (this.text(k - 1) !== "[" || this.text(k + 1) !== "]" || !this.isValueEnd(k - 2))
        return false;
      return this.isSourceMember(value, k - 2);
    }
    // `this.<field>` reads a field tainted by a `this.<field> = …` assignment.
    if (token.kind === "ident" && token.text === "this" && !this.isMemberName(k)) {
      const read = this.memberPath(k);
      return read.length > 0 && this.fieldsAt("this", k).some((e) => pathsOverlap(e.path, read));
    }
    if (token.kind !== "ident" || KEYWORDS.has(token.text)) return false;
    const name = token.text;
    if (this.isMemberName(k)) {
      if (this.isSourceMember(name, k - 2)) return true;
      return (
        this.text(k + 1) === "(" &&
        this.taintedMethods.has(name) &&
        !BUILTIN_RECEIVERS.has(this.text(k - 2))
      );
    }
    // An object-literal key is a name, not a read; a shorthand property is a read.
    if (this.isObjectKey(k)) return false;
    if (isKeyMaterialName(name)) return true;
    if (
      this.text(k + 1) === "(" &&
      this.taintedFunctions.get(name)?.some((e) => e.scope[0] <= k && k < e.scope[1])
    ) {
      return true;
    }
    if (this.wholeAt(name, k)) return true;
    const fields = this.fieldsAt(name, k);
    if (!fields.length) return false;
    // An empty path is the whole object used: passed, spread or serialized.
    const read = this.memberPath(k);
    return fields.some((e) => pathsOverlap(e.path, read));
  }

  // The member chain read after the root at `k`: `a.b?.c` gives ["b", "c"],
  // a computed member `a[x]` gives "*" (its literal key when it has one).
  private memberPath(k: number): string[] {
    const path: string[] = [];
    let j = k + 1;
    while (path.length < MAX_MEMBER_PATH) {
      const next = this.text(j);
      if ((next === "." || next === "?.") && this.isIdentLike(j + 1)) {
        path.push(this.text(j + 1));
        j += 2;
      } else if (next === "[" && this.close[j] > j && this.close[j] < this.n) {
        const key = this.t[j + 1];
        path.push(key?.kind === "string" && this.close[j] === j + 2 ? (key.value ?? "*") : "*");
        j = this.close[j] + 1;
      } else {
        break;
      }
    }
    return path;
  }

  // `path.join(home, '.config', 'solana', 'id.json')`: the literal segments of
  // a path-joining call, read together.
  private joinedPathIsWalletFile(k: number): boolean {
    const paren = this.parent[k];
    if (this.text(paren) !== "(" || !["join", "resolve"].includes(this.text(paren - 1)))
      return false;
    const segments: string[] = [];
    for (const [start, end] of this.elements(paren)) {
      if (end === start + 1 && this.t[start].kind === "string")
        segments.push(this.t[start].value ?? "");
    }
    return segments.length > 1 && WALLET_FILE.test(segments.join("/"));
  }

  private isSourceMember(name: string, receiver: number): boolean {
    if (isKeyMaterialName(name)) return true;
    return KEYPAIR_SECRET_NAME.test(normalizeName(name)) && this.keypairReceiver(receiver);
  }

  // Whether the member chain ending at `r` names a keypair-shaped holder,
  // looking through calls (`Keypair.generate().secretKey`).
  private keypairReceiver(r: number): boolean {
    let j = r;
    for (let steps = 0; steps < 3 && j >= 0; steps += 1) {
      if (this.text(j) === ")" && this.open[j] > 0) {
        j = this.open[j] - 1;
        continue;
      }
      if (this.t[j]?.kind !== "ident") return false;
      if (KEYPAIR_RECEIVER.test(normalizeName(this.t[j].text))) return true;
      if (!this.isMemberName(j)) return false;
      j -= 2;
    }
    return false;
  }

  // Whether the value read at `k` is consumed as something other than the key
  // before it reaches the end of the expression that starts at `start`.
  private isNeutralized(k: number, start: number): boolean {
    const next = this.text(k + 1);
    if ((next === "." || next === "?.") && this.isIdentLike(k + 2)) {
      const member = this.text(k + 2);
      const normalized = normalizeName(member);
      if (NON_SECRET_MEMBER.test(normalized)) return true;
      if (this.text(k + 3) === "(" && this.isFlowEndingMethod(member)) return true;
    }
    // A scalar measurement anywhere along the postfix chain
    // (`mnemonic.split(' ').length`) is a count, not the key.
    const terminal = this.terminalMember(k);
    if (terminal && /^(?:length|bytelength)$/.test(normalizeName(terminal))) return true;
    if (BOOLEAN_CONTEXT.has(next) && next !== "!" && next !== "typeof") return true;
    if (BOOLEAN_CONTEXT.has(this.text(this.chainStart(k) - 1))) return true;
    for (let p = this.parent[k]; p >= start; p = this.parent[p]) {
      if (this.text(p) === "(" && this.isTransformingCall(p)) return true;
    }
    return false;
  }

  // Whether a method call on a key-holding receiver ends the flow: a named
  // sanitizer word (`signTransaction`, `encryptToV3`), or one of the
  // derivation/keystore/measurement methods whose output is not the key.
  private isFlowEndingMethod(member: string): boolean {
    const normalized = normalizeName(member);
    if (FLOW_ENDING_METHODS.has(normalized)) return true;
    return nameWords(member).some((word) => SANITIZER_WORDS.has(word));
  }

  // The last property name of the postfix chain that starts at `k`, looking
  // through `.m(…)` calls and `.m` accesses, or null if the value is used as
  // is. Bounded by the chain-step budget.
  private terminalMember(k: number): string | null {
    let j = k;
    let last: string | null = null;
    for (let steps = 0; steps < MAX_CHAIN_STEPS; steps += 1) {
      const dot = this.text(j + 1);
      if ((dot !== "." && dot !== "?.") || !this.isIdentLike(j + 2)) break;
      last = this.text(j + 2);
      j += 2;
      if (this.text(j + 1) === "(" && this.close[j + 1] >= 0) j = this.close[j + 1];
    }
    return last;
  }

  private chainStart(k: number): number {
    let j = k;
    for (let steps = 0; steps < MAX_CHAIN_STEPS && this.isMemberName(j); steps += 1) {
      j -= 2;
      while (
        (this.text(j) === ")" || this.text(j) === "]") &&
        this.open[j] > 0 &&
        steps < MAX_CHAIN_STEPS
      ) {
        j = this.open[j] - 1;
        steps += 1;
      }
    }
    return j;
  }

  // Whether the call whose argument list opens at `p` returns something other
  // than its key-material argument.
  private isTransformingCall(p: number): boolean {
    const callee = p - 1;
    if (
      !this.isIdentLike(callee) ||
      (KEYWORDS.has(this.text(callee)) && this.text(callee) !== "super")
    ) {
      return false;
    }
    // A callee defined in this file is judged by what it returns, never by its
    // name: an identity helper named `hash` does not sanitize, and an
    // unsuggestively named helper (`generateToken`, `makeAssertion`) that
    // returns a signature does. Its own argument's flow into any sink inside it
    // is still judged where that sink is.
    if (!this.isMemberName(callee)) {
      const defs = this.sameFileDefs(callee);
      if (defs) return defs.every((def) => this.functionSanitizesArg(def));
    }
    const words = nameWords(this.text(callee));
    if (!words.length) return false;
    if (PREDICATE_FIRST_WORDS.has(words[0]) || OPAQUE_FIRST_WORDS.has(words[0])) return true;
    if (OPAQUE_LAST_WORDS.has(words[words.length - 1])) return true;
    // Sanitizer words anywhere on the callee chain: `nacl.sign.detached(…)`,
    // `createHash('sha256').update(key)`.
    let j = callee;
    for (let steps = 0; steps < 3 && j >= 0; steps += 1) {
      if (this.isIdentLike(j)) {
        // `cipher.update(key)`, `secrets.share(key)`, `nacl.sign.detached(…)`.
        if (this.isFlowEndingMethod(this.text(j))) return true;
        if (!this.isMemberName(j)) return false;
        j -= 2;
      } else if (this.text(j) === ")" && this.open[j] > 0) {
        j = this.open[j] - 1;
      } else {
        return false;
      }
    }
    return false;
  }

  // --- Sinks ---------------------------------------------------------------

  private sinkModule(c: number, depth = 0): string | null {
    return this.sinkAt(c, depth)?.module ?? null;
  }

  private sinkAt(c: number, depth = 0): Sink | null {
    // Handle chains (`a().b().…end(body)`) recurse one hop per call; bound the
    // depth so a long hostile chain cannot overflow the stack.
    if (depth > MAX_CHAIN_STEPS) return null;
    const name = this.text(c);
    if (!this.isIdentLike(c)) return null;
    if (!this.isMemberName(c)) {
      if (KEYWORDS.has(name)) return null;
      if (this.text(c - 1) === "new") {
        // `ws` takes TLS options on its constructor.
        return NEW_SINKS.has(name) ? sink(`new ${name}`, name === "WebSocket" ? "ws" : null) : null;
      }
      if (name === "fetch") return sink("fetch", null);
      const ref = this.modules.get(name);
      if (ref) {
        if (ref.member === undefined) {
          return CALLABLE_CLIENT_MODULES.has(ref.module) ? sink(name, ref.module) : null;
        }
        if (ref.module === "child_process" && SHELL_METHODS.test(ref.member)) {
          return sink(`child_process.${ref.member}`, ref.module);
        }
        return MODULE_METHODS[ref.module]?.test(ref.member)
          ? sink(`${ref.module}.${ref.member}`, ref.module)
          : null;
      }
      return BARE_CLIENTS.has(name) ? sink(name, name) : null;
    }
    if (name === "sendBeacon") return sink("sendBeacon", null);
    const r = c - 2;
    if (this.t[r]?.kind === "ident") {
      const receiver = this.text(r);
      if (name === "fetch" && GLOBAL_RECEIVERS.has(receiver) && !this.isMemberName(r)) {
        return sink(`${receiver}.fetch`, null);
      }
      const module = this.moduleOf(r);
      if (module && MODULE_METHODS[module]?.test(name)) return sink(`${module}.${name}`, module);
      if (module === "child_process" && SHELL_METHODS.test(name))
        return sink(`${module}.${name}`, module);
      if (!this.isMemberName(r) && this.handles.has(receiver) && HANDLE_METHODS.has(name)) {
        return sink(`${receiver}.${name}`, null);
      }
      return null;
    }
    if (this.text(r) === ")" && this.open[r] > 0) {
      const module = this.moduleOf(r);
      if (module && MODULE_METHODS[module]?.test(name)) return sink(`${module}.${name}`, module);
      if (module === "child_process" && SHELL_METHODS.test(name))
        return sink(`${module}.${name}`, module);
      // `https.request(opts).end(body)`.
      const inner = this.open[r] - 1;
      const innerModule =
        HANDLE_METHODS.has(name) && this.isIdentLike(inner)
          ? this.sinkModule(inner, depth + 1)
          : null;
      if (innerModule && HANDLE_MODULES.has(innerModule)) {
        return sink(`${this.text(inner)}(…).${name}`, null);
      }
    }
    return null;
  }

  // Value ranges of TLS credential options in the call's object-literal
  // arguments, including an options object passed by identifier
  // (`const opts = { key }; https.request(opts)`), whose whole argument is
  // excluded when its only key material sits in TLS credential fields.
  private tlsOptionRanges(paren: number): Range[] {
    const ranges: Range[] = [];
    for (const [start, end] of this.elements(paren)) {
      if (this.text(start) === "{" && this.close[start] === end - 1) {
        ranges.push(...this.tlsKeyRangesOf(start));
      } else if (end === start + 1 && this.isIdent(start)) {
        const object = this.objectLiteralBindingOf(this.text(start), start);
        const objectEnd = object >= 0 ? Math.min(this.close[object], this.n - 1) + 1 : -1;
        if (object >= 0 && this.taintedReadIn(object, objectEnd, this.tlsKeyRangesOf(object)) < 0) {
          ranges.push([start, end]);
        }
      }
    }
    return ranges;
  }

  // Value ranges of TLS credential keys (`key`, `cert`, `pfx`, …) inside a
  // single object literal that opens at `object`.
  private tlsKeyRangesOf(object: number): Range[] {
    const ranges: Range[] = [];
    const visit = (obj: number, depth: number) => {
      for (const [start, end] of this.elements(obj)) {
        const key = this.t[start].kind === "string" ? this.t[start].value : this.text(start);
        if (!key) continue;
        if (this.text(start + 1) !== ":") {
          if (TLS_OPTION_KEYS.has(key) && end === start + 1) ranges.push([start, end]);
          continue;
        }
        if (TLS_OPTION_KEYS.has(key)) ranges.push([start + 2, end]);
        else if (depth === 0 && TLS_CONTAINER_KEYS.has(key) && this.text(start + 2) === "{") {
          visit(start + 2, 1);
        }
      }
    };
    visit(object, 0);
    return ranges;
  }

  // The open index of the object literal most recently bound to `name` and
  // visible at `at`, or -1. Fuel-bounded so it cannot turn an adversarial file
  // with many bindings and many sinks quadratic.
  private objectLiteralBindingOf(name: string, at: number): number {
    let best = -1;
    let bestStart = -1;
    for (const binding of this.bindings) {
      if (--this.fuel <= 0) break;
      if (binding.target.kind !== "name" || binding.target.name !== name) continue;
      if (binding.scope[0] > at || at >= binding.scope[1]) continue;
      const open = binding.rhs[0];
      if (this.text(open) !== "{" || this.close[open] !== binding.rhs[1] - 1) continue;
      if (binding.scope[0] >= bestStart) {
        best = open;
        bestStart = binding.scope[0];
      }
    }
    return best;
  }

  private namesNetworkTool(start: number, end: number): boolean {
    for (let k = start; k < end; k += 1) {
      if (this.t[k].kind === "string" && NETWORK_TOOL.test(this.t[k].value ?? "")) return true;
    }
    return false;
  }

  private findSinkFlow(): KeyMaterialFlow | null {
    for (let c = 0; c < this.n; c += 1) {
      if (this.text(c + 1) !== "(" || !this.isIdentLike(c)) continue;
      const sink = this.sinkAt(c);
      if (!sink) continue;
      const paren = c + 1;
      const end = Math.min(this.close[paren], this.n);
      if (sink.module === "child_process" && !this.namesNetworkTool(paren + 1, end)) continue;
      const skip = sink.tlsOptions ? this.tlsOptionRanges(paren) : [];
      const read = this.taintedReadIn(paren + 1, end, skip);
      if (read < 0) continue;
      const lines = [c, read, ...this.viaOf(read)].map((i) => this.lineOf(i));
      return { lines: [...new Set(lines)], sink: sink.label };
    }
    return null;
  }
}
