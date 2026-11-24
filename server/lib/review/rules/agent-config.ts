import type { Finding } from "../types";
import { tag, testScope } from "./helpers";
import { changedPrefix, isUnreachableTestFile, type RuleContext } from "./context";

// Coding-agent configuration shipped in a release. Approving a command with
// "don't ask again" stores the exact command line in the agent's settings, so
// `PGPASSWORD=… psql` or `curl -u user:pass` lands in a plain JSON file next to
// the package source and ships with it; MCP configs hold server tokens the same
// way.
//
// Tiers grade what the file is for, not whether it is malicious: credential
// stores and local settings are personal by design (Claude Code keeps
// `settings.local.json` out of git), so shipping one is a packaging mistake;
// shared config is meant for repositories and scaffolding templates ship it on
// purpose, so on its own it is disclosure only; a plugin `mcp.json` is a name
// too generic to report without a credential in it. A literal credential lifts
// any tier.
//
// Severity encodes release scope, and `agentConfigReleaseDelta` in
// diff-annotation.ts reads it back: critical and medium are credentials (or a
// personal file) this release adds, high is a credential the previous release
// already shipped. The rule decides that itself, from raw bytes, because the
// annotator only sees redacted text where a rotated credential and its
// predecessor read the same.
type AgentConfigTier = "personal" | "shared" | "plugin";

const AGENT_CONFIG_FILES: ReadonlyArray<{ pattern: RegExp; tier: AgentConfigTier; label: string }> =
  [
    {
      pattern: /(^|\/)\.claude\/\.credentials\.json$/i,
      tier: "personal",
      label: "Claude Code credential store",
    },
    { pattern: /(^|\/)\.codex\/auth\.json$/i, tier: "personal", label: "Codex auth file" },
    {
      pattern: /(^|\/)\.gemini\/oauth_creds\.json$/i,
      tier: "personal",
      label: "Gemini CLI OAuth credentials",
    },
    {
      pattern: /(^|\/)\.claude\/settings\.local\.json$/i,
      tier: "personal",
      label: "Claude Code local settings",
    },
    { pattern: /(^|\/)\.claude\.json$/i, tier: "personal", label: "Claude Code user state" },
    { pattern: /(^|\/)CLAUDE\.local\.md$/i, tier: "personal", label: "Claude Code local memory" },
    {
      pattern: /(^|\/)\.codeium\/windsurf\/mcp_config\.json$/i,
      tier: "personal",
      label: "Windsurf MCP server config",
    },
    {
      pattern: /(^|\/)\.claude\/settings\.json$/i,
      tier: "shared",
      label: "Claude Code project settings",
    },
    { pattern: /(^|\/)\.mcp\.json$/i, tier: "shared", label: "MCP server config" },
    {
      pattern: /(^|\/)\.(?:cursor|vscode|roo)\/mcp\.json$/i,
      tier: "shared",
      label: "editor MCP server config",
    },
    { pattern: /(^|\/)\.kiro\/settings\/mcp\.json$/i, tier: "shared", label: "Kiro MCP config" },
    { pattern: /(^|\/)\.gemini\/settings\.json$/i, tier: "shared", label: "Gemini CLI settings" },
    { pattern: /(^|\/)\.codex\/config\.toml$/i, tier: "shared", label: "Codex config" },
    { pattern: /(^|\/)mcp\.json$/i, tier: "plugin", label: "plugin MCP config" },
  ];

function agentConfigFor(path: string) {
  return AGENT_CONFIG_FILES.find(({ pattern }) => pattern.test(path));
}

// Every pattern starts at an anchored token (lookbehind or a literal command
// name) and spans bounded runs, so a hostile multi-megabyte config scans in
// linear time. Key and flag names are matched on their own and the value read
// with a sticky pattern only for a credential name, so a non-credential value
// (a hook's `"command": "env PGPASSWORD=… psql"`) is never consumed whole.
//
// A value is single-quoted (shell-literal, so `$` is kept), double-quoted (a
// JSON or TOML string, spaces allowed; escaped `\"` inside a JSON file is shell
// quoting), or a bare run. A quote that opens or closes on whitespace or spans
// a pipe is the edge of a neighbouring argument, as in
// `grep 'PASSWORD=' . | grep -v 'x'`. A bare run may not start with regex
// syntax or a redaction marker (`[`), so `PASSWORD=[A-Za-z]{16}` is a search.
const LIMIT = 4096;
const SINGLE_QUOTED = String.raw`\\?'(?![\s|])[^'\n\\|]{4,${LIMIT}}(?<!\s)'`;
const DOUBLE_QUOTED = String.raw`\\?"(?![\s|])[^"\n\\|]{4,${LIMIT}}(?<!\s)\\?"`;
const BARE = String.raw`(?![[\]])[^\s"'\\$<>{}()*,;%\x60]{4,${LIMIT}}`;
const VALUE = String.raw`(${SINGLE_QUOTED}|${DOUBLE_QUOTED}|(?:\\?["'])?${BARE})`;
const VALUE_AT = new RegExp(VALUE, "dy");
const UNDASHED_VALUE_AT = new RegExp(String.raw`(?!\\?["']?-)${VALUE}`, "dy");

// The name a key/value pattern captured must end in a credential word, so
// `MAX_OUTPUT_TOKENS`, `TOKEN_FILE`, `tokenizer` and `--password-stdin` stay
// quiet while `PGPASSWORD`, `X-API-Key`, `accessToken`, `_authToken` match.
const CREDENTIAL_NAME =
  /(?:password|passwd|(?:^|[-_])pass|(?:^|[-_])pwd|token|secret|(?:secret|api|access|auth|private|role|service)[-_]?key|apikey|[-_]pat|credentials?)$/i;
const NON_CREDENTIAL_NAME = /(?:page|next|continuation|sync|cursor)[-_]?token$/i;

// `PGPASSWORD=…`, `"API_KEY": "…"`, `api_key = "…"` (TOML), `X-API-Key: …`
const KEY_NAME = /(?<![A-Za-z0-9_-])([A-Za-z_][A-Za-z0-9_-]{0,63})\\?["']?\s{0,16}[:=]\s{0,16}/g;
// `--password=…`, `--db-token …`, and JSON arrays: `"--api-key", "…"`. A value
// after a space or array separator that starts with `-` is the next flag; after
// `=` it is bound to this one (`--db-password=-6tF…`).
const FLAG_NAME =
  /(?<![A-Za-z0-9-])--([A-Za-z][A-Za-z0-9-]{0,40})(=|\s{1,4}|\\?["']\s{0,4},\s{0,16})/g;
// `Authorization: Bearer …` in a curl header, a JSON `headers` object or a
// TOML `http_headers` table.
const AUTHORIZATION = new RegExp(
  String.raw`(?<![A-Za-z0-9-])Authorization\\?["']?\s{0,16}[:=]\s{0,16}\\?["']?(Bearer|Basic|token)\s{1,4}(${BARE})`,
  "dgi",
);

// A command's own arguments: quoted arguments are read whole (they may hold
// `)` or `&`); otherwise the span stops at the end of a permission entry
// (`)`), a chain or background (`;`, `&`, `|`) or the line, so the next
// command's `-p 3000:3000` is not this one's password. An `&` touching `>` is a
// redirection (`2>&1`, `&>log`), not a background. In a JSON file a bare `"`
// ends the string the command lives in. Every item is one character or one
// quoted run, so the lazy span has a single parse per position.
function commandPatterns(json: boolean): RegExp[] {
  const redirect = String.raw`(?<=>)&|&(?=>)`;
  const quoted = json
    ? String.raw`\\"[^"\n\\]{0,256}\\"|'[^'\n]{0,256}'|[^\n;&|)'"\\]|\\(?!")|${redirect}`
    : String.raw`"[^"\n]{0,256}"|'[^'\n]{0,256}'|[^\n;&|)'"]|${redirect}`;
  const span = String.raw`(?:${quoted}){0,512}?`;
  return [
    // `curl -u user:pass`; scoped to curl because `-u` means a uid elsewhere.
    String.raw`\bcurl\b${span}\s(?:-u|--user)(?:\s{1,4}|=)(?:\\?["'])?[^\s:"'\\]{1,128}:([^\s@"'\\$<>{}()*]{3,256})`,
    // `mysql -pS3cret`, `mysql -p'S3cret'`: the password is glued to the flag.
    String.raw`\b(?:mysql|mysqldump|mysqladmin|mariadb)\b${span}\s-p${VALUE}`,
    String.raw`\bsshpass\s{1,4}-p\s{0,4}${VALUE}`,
    // `docker login -u me -p …`, `twine upload -u __token__ -p …`
    String.raw`\b(?:(?:docker|podman)\s{1,4}login|twine\s{1,4}upload)\b${span}\s-p\s{1,4}${VALUE}`,
    String.raw`\bredis-cli\b${span}\s-a\s{1,4}${VALUE}`,
  ].map((source) => new RegExp(source, "dg"));
}
const JSON_COMMANDS = commandPatterns(true);
const TEXT_COMMANDS = commandPatterns(false);

// Template and documentation values: whole-word stand-ins, fill-in markers
// anywhere in the value (`API_KEY_HERE`, `ghp_your_token_here`, `sk_test_xxxx`,
// `sk-proj-...`), redaction markers, and prose in a config string
// (`"GitHub personal access token"`).
const PLACEHOLDER_VALUE =
  /^(?:redacted|test|todo|secret|password|passwd|pass|token|null|undefined|true|false|none|postgres|root|admin|guest|include|omit|same-origin|\[REDACTED_[A-Z_]+\])$/i;
const PLACEHOLDER_PART =
  /x{4,}|\.{3,}|\*{3,}|12345678|abcdef|example|placeholder|change[-_]?me|replace|dummy|fake|sample|your|(?:^|[^a-z])(?:my|insert|enter|here)(?:[^a-z]|$)/i;
const PROSE = /^[A-Za-z][A-Za-z'-]*(?: [A-Za-z'-]+){2,}[.!?]?$/;
// A regex character class with a range or negation (`gh[pousr]_[A-Za-z0-9]+`)
// makes the value a search pattern; a bracketed literal (`Rain7![part2]`) does
// not.
const REGEX_CLASS = /\[\^|\[[^\]]{0,64}[A-Za-z0-9]-[A-Za-z0-9][^\]]{0,64}\]/;
// References resolved elsewhere: `%VAR%`, `<token>`, `env:NAME`, `op://…`, a
// nested `key=value` option (`--secret id=npmrc`), and values whose whole shape
// is a path, dotfile, flag or port. A generated password may start with `/`,
// `-`, `.` or `~`, so only the whole shape counts.
const REFERENCE_VALUE =
  /^(?:%|<|(?:env|input|vault|secret):|op:\/\/|process\.env\b|os\.environ\b|[a-z][a-z0-9_-]*=[^=]|(?:~|\.{1,2})?\/[\w./-]*$|\.[\w.-]+$|-{1,2}[a-z][a-z0-9-]*$|[\d:.]+$)/i;

// A variable's own name stands in for its value: `GITHUB_TOKEN`,
// `OPENROUTER_API_KEY_2` (letter-led segments or a numeric suffix, unlike a
// generated `P9V0_5N7J_K4Q2` or `KMR4_7A9X_B2Q8`) or
// a snake- or camel-case identifier ending in a credential word
// (`McpServer_AUTH_TOKEN`, `apiKey`), as in Codex's `env_http_headers`.
function isVariableName(value: string): boolean {
  if (/^[A-Z][A-Z0-9]*(?:_(?:[A-Z][A-Z0-9]*|\d+))+$/.test(value) && /[A-Z]{3,}/.test(value)) {
    return true;
  }
  return (
    /^[A-Za-z_][A-Za-z0-9_]*$/.test(value) &&
    /_|[a-z][A-Z]/.test(value) &&
    CREDENTIAL_NAME.test(value)
  );
}

type FileKind = "json" | "toml" | "text";

function fileKind(path: string): FileKind {
  if (/\.json$/i.test(path)) return "json";
  return /\.toml$/i.test(path) ? "toml" : "text";
}

function credentialValue(raw: string, kind: FileKind): string | null {
  const quote = /^\\?["']/.exec(raw)?.[0] ?? "";
  // Shell quoting: single quotes keep `$` literal, double quotes expand it. A
  // bare `"` in JSON or TOML is a config string instead; an escaped `\"` in a
  // JSON file is shell quoting inside a stored command.
  const shellSingle = quote.endsWith("'");
  const shellDouble = quote === '\\"' || (quote === '"' && kind === "text");
  const configString = quote === '"' && kind !== "text";
  const value = raw.slice(quote.length).replace(/\\?["']$/, "");
  if (value.length < 3) return null;
  if (PLACEHOLDER_VALUE.test(value) || PLACEHOLDER_PART.test(value)) return null;
  if (configString && PROSE.test(value)) return null;
  if (value.includes("${")) return null;
  if (!shellSingle && value.startsWith("$")) return null;
  if (shellDouble && /\$[A-Za-z_(]/.test(value)) return null;
  if (isVariableName(value) || REFERENCE_VALUE.test(value) || REGEX_CLASS.test(value)) return null;
  return value;
}

// Basic auth is base64 of `user:pass`; judge the password, or the user when the
// password is empty (`sk_live_…:`), so a scaffolded `admin:admin` stays a dev
// default rather than a strong-looking base64 run.
function decodedBasicCredential(value: string): string | null {
  try {
    const decoded = atob(value);
    const colon = decoded.indexOf(":");
    if (colon === -1) return null;
    return decoded.slice(colon + 1) || decoded.slice(0, colon);
  } catch {
    return null;
  }
}

function strongValue(value: string): boolean {
  const classes = [/[a-z]/, /[A-Z]/, /\d/, /[^A-Za-z0-9]/].filter((cls) => cls.test(value)).length;
  return value.length >= 12 && (classes >= 3 || (value.length >= 24 && classes >= 2));
}

interface InlineCredential {
  /** Identifies the credential across releases. */
  value: string;
  strong: boolean;
  line: number;
}

interface CredentialScan {
  /** First occurrence of each distinct credential, in text order. */
  credentials: InlineCredential[];
  /** Every occurrence's offsets, quotes excluded, for redaction. */
  spans: Array<[number, number]>;
}

// Bound the memory a match-dense hostile file can cost: distinct credentials
// for grading, occurrences for redaction. Repeats of one value never crowd out
// a new one. Past either cap a file is still reported; later credentials miss
// grading or masking only.
const MAX_DISTINCT = 256;
const MAX_SPANS = 16_384;

function scanCredentials(text: string, path: string): CredentialScan {
  const kind = fileKind(path);
  const firstByValue = new Map<string, { start: number; strong: boolean }>();
  const spans: Array<[number, number]> = [];
  const taken = new Set<number>();
  const record = (raw: string, offset: number, judged: string | null, identity?: string) => {
    if (spans.length >= MAX_SPANS) return;
    const value = judged === null ? null : credentialValue(judged, kind);
    if (value === null) return;
    const lead = /^\\?["']/.exec(raw)?.[0].length ?? 0;
    const trail = /\\?["']$/.exec(raw)?.[0].length ?? 0;
    const start = offset + lead;
    if (taken.has(start)) return;
    taken.add(start);
    spans.push([start, offset + raw.length - trail]);
    const key = identity ?? value;
    if (!firstByValue.has(key) && firstByValue.size < MAX_DISTINCT) {
      firstByValue.set(key, { start, strong: strongValue(value) });
    }
  };
  // After a credential name, the scan resumes past the value it read, so a
  // value made of name-shaped runs (`DBTOKEN=DBTOKEN=…`) is read once rather
  // than once per run. A non-credential name never consumes its value: a hook's
  // `"command": "env PGPASSWORD=… psql"` is still scanned inside.
  const named = (nameRegex: RegExp, dashed: (separator: string) => boolean) => {
    nameRegex.lastIndex = 0;
    for (let match = nameRegex.exec(text); match; match = nameRegex.exec(text)) {
      const name = match[1] ?? "";
      if (!CREDENTIAL_NAME.test(name) || NON_CREDENTIAL_NAME.test(name)) continue;
      const valueAt = dashed(match[2] ?? "") ? VALUE_AT : UNDASHED_VALUE_AT;
      valueAt.lastIndex = match.index + match[0].length;
      const value = valueAt.exec(text);
      if (value?.[1] === undefined) continue;
      record(value[1], value.index, value[1]);
      nameRegex.lastIndex = Math.max(nameRegex.lastIndex, value.index + value[0].length);
    }
  };
  named(KEY_NAME, () => true);
  named(FLAG_NAME, (separator) => separator === "=");
  AUTHORIZATION.lastIndex = 0;
  for (const match of text.matchAll(AUTHORIZATION)) {
    const raw = match[2] ?? "";
    const basic = /^basic$/i.test(match[1] ?? "");
    const offset = match.indices?.[2]?.[0];
    if (offset === undefined) continue;
    record(raw, offset, basic ? decodedBasicCredential(raw) : raw, basic ? raw : undefined);
  }
  for (const regex of kind === "json" ? JSON_COMMANDS : TEXT_COMMANDS) {
    regex.lastIndex = 0;
    for (const match of text.matchAll(regex)) {
      const offset = match.indices?.[1]?.[0];
      if (offset !== undefined) record(match[1] ?? "", offset, match[1] ?? "");
    }
  }

  const ordered = [...firstByValue.entries()].sort((a, b) => a[1].start - b[1].start);
  // Each newline is visited once across all credentials, so line numbers cost
  // O(text) however the matches are laid out.
  let line = 1;
  let lineEnd = text.indexOf("\n");
  const credentials = ordered.map(([value, { start, strong }]) => {
    while (lineEnd !== -1 && lineEnd < start) {
      line += 1;
      lineEnd = text.indexOf("\n", lineEnd + 1);
    }
    return { value, strong, line };
  });
  return { credentials, spans };
}

const REDACTION_MARKER = /\[REDACTED_[A-Z_]+\]/g;

// Masks the credentials this rule finds before a sample is stored, shown in a
// public diff or handed to AI review. Scans the raw text, so a generic marker
// cannot cut a value short and leave its tail visible. Each value goes through
// the generic redactor first: one it recognises keeps that specific marker (so
// a rotation to a differently shaped secret stays a visible change for other
// rules' release attribution) and every other piece of the value is masked.
// The caller still runs the generic redactor over the whole result. Returns
// the same string when nothing matched, so clean files keep sharing the text.
export function redactAgentConfigCredentials(
  path: string,
  text: string,
  redactGeneric: (value: string) => string = (value) => value,
): string {
  if (!agentConfigFor(path)) return text;
  const spans = scanCredentials(text, path).spans.sort((a, b) => a[0] - b[0]);
  if (spans.length === 0) return text;
  const mask = (value: string) => {
    const generic = redactGeneric(value);
    if (generic === value) return "[REDACTED_CREDENTIAL]";
    let out = "";
    let cursor = 0;
    for (const marker of generic.matchAll(REDACTION_MARKER)) {
      if (marker.index > cursor) out += "[REDACTED_CREDENTIAL]";
      out += marker[0];
      cursor = marker.index + marker[0].length;
    }
    return cursor < generic.length ? `${out}[REDACTED_CREDENTIAL]` : out;
  };
  let out = "";
  let cursor = 0;
  for (const [start, end] of spans) {
    if (start < cursor) continue;
    out += text.slice(cursor, start) + mask(text.slice(start, end));
    cursor = end;
  }
  return out + text.slice(cursor);
}

type Grade = { severity: Finding["severity"]; line: number; credential: "new" | "old" | null };

export function agentConfigFindings(ctx: RuleContext): Finding[] {
  const findings: Finding[] = [];
  // Every credential the previous release shipped in any agent config, so a
  // moved or renamed file does not make an old credential read as new. A
  // baseline file without a sample contributes nothing: fail open.
  let baselineValues: Set<string> | null = null;
  const previousValues = () => {
    baselineValues ??= new Set(
      [...ctx.previousByPath.values()]
        .filter((file) => agentConfigFor(file.path) && file.textSample)
        .flatMap((file) =>
          scanCredentials(file.textSample!, file.path).credentials.map(({ value }) => value),
        ),
    );
    return baselineValues;
  };

  for (const file of ctx.files) {
    const config = agentConfigFor(file.path);
    if (!config) continue;
    const changed = ctx.diffByPath.get(file.path)?.status;
    if (changed === "removed") continue;
    const fresh = changed === "added" || changed === "modified";
    const { credentials } = scanCredentials(file.textSample || "", file.path);
    const isNew = (credential: InlineCredential) =>
      fresh && !previousValues().has(credential.value);
    // Shared config is what templates ship, filled with stand-ins
    // (`password123`, `mysecret`): a weak value there is reported, never
    // enough to hold a release.
    const counts = (credential: InlineCredential) =>
      config.tier === "personal" || credential.strong;
    const strongNew = credentials.filter((c) => counts(c) && isNew(c));
    const weakNew = credentials.filter((c) => !counts(c) && isNew(c));
    const strongOld = credentials.filter((c) => counts(c) && !isNew(c));

    // A new credential and an old one are separate findings, so release risk
    // follows what this release added and package risk what the package holds.
    const grades: Grade[] = [];
    if (strongNew.length > 0) {
      grades.push({ severity: "critical", line: strongNew[0]!.line, credential: "new" });
    } else if (weakNew.length > 0) {
      grades.push({ severity: "medium", line: weakNew[0]!.line, credential: "new" });
    }
    if (strongNew.length === 0 && strongOld.length > 0) {
      grades.push({ severity: "high", line: strongOld[0]!.line, credential: "old" });
    }
    if (grades.length === 0) {
      if (credentials.length > 0) {
        grades.push({ severity: "low", line: credentials[0]!.line, credential: "old" });
      } else if (config.tier !== "plugin") {
        grades.push({
          severity: config.tier === "personal" && fresh ? "medium" : "low",
          line: 1,
          credential: null,
        });
      }
    }

    for (const grade of grades) {
      findings.push(
        // A shipped credential is a leak wherever it sits, and its severity
        // encodes release scope, so only the credential-free tier grade
        // demotes in an unreachable test file.
        testScope(
          isUnreachableTestFile(ctx, file.path) && grade.credential === null,
          false,
          tag("fileAgentConfig", {
            severity: grade.severity,
            file: file.path,
            line: grade.line,
            evidence: `${changedPrefix(ctx, file.path)}${config.label}${
              grade.credential === "new"
                ? " with an inline credential added in this release"
                : grade.credential === "old"
                  ? " with an inline credential"
                  : ""
            }`,
            reason: grade.credential
              ? "coding-agent config stores approved commands and server settings verbatim; this one carries a credential that ships to everyone who installs the package"
              : config.tier === "personal"
                ? "coding-agent credential stores and local settings are personal by design and can record approved commands with secrets in them; exclude them from the published files"
                : "coding-agent config is meant for the source repository; published copies disclose approved commands and tool servers",
          }),
        ),
      );
    }
  }
  return findings;
}
