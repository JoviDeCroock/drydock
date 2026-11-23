import type { FileRecord, Finding } from "../types";
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
// purpose, so on its own it is disclosure only. A literal credential lifts any
// tier. Recognized token formats are `file.secret-content`'s job; this rule
// reads the command-line and config-key shapes that rule leaves alone.
type AgentConfigTier = "personal" | "shared";

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
  ];

// Every pattern starts at an anchored token (lookbehind or a literal command
// name) and spans bounded runs, so a hostile multi-megabyte config scans in
// linear time. Spans after a command name stop at `;`, `&` and `|` so a flag of
// the next command in a chain is not read as this one's. The one capture group
// in VALUE is the credential: a single-quoted literal (where `$` is literal
// shell text; a quote that opens or closes on whitespace or spans a pipe is the
// edge of a neighbouring argument, as in `grep 'PASSWORD=' . | grep -v 'x'`) or
// a bare or double-quoted run. The files are JSON, so quotes may
// be escaped (`\"`).
const VALUE = String.raw`(\\?'(?![\s|])[^'\n\\|]{4,256}(?<!\s)'|(?:\\?["'])?[^\s"'\\$<>{}()*,;%\x60]{4,256})`;
const SPAN = String.raw`[^\n;&|]{0,512}?`;
// The name a key/value pattern captured must end in a credential word, so
// `MAX_OUTPUT_TOKENS`, `TOKEN_FILE`, `tokenizer` and `--password-stdin` stay
// quiet while `PGPASSWORD`, `X-API-Key`, `accessToken`, `_authToken` match.
const CREDENTIAL_NAME =
  /(?:password|passwd|(?:^|[-_])pass|(?:^|[-_])pwd|token|secret|(?:secret|api|access|auth|private|role|service)[-_]?key|apikey|[-_]pat|credentials?)$/i;
const NON_CREDENTIAL_NAME = /(?:page|next|continuation|sync|cursor)[-_]?token$/i;
const NAMED_PATTERNS: RegExp[] = [
  // `PGPASSWORD=…`, `"API_KEY": "…"`, `api_key = "…"` (TOML), `X-API-Key: …`
  new RegExp(
    String.raw`(?<![A-Za-z0-9_-])([A-Za-z_][A-Za-z0-9_-]{0,63})\\?["']?\s{0,4}[:=]\s{0,4}${VALUE}`,
    "dg",
  ),
  // `--password=…`, `--db-token …`, and JSON arrays: `"--api-key", "…"`
  new RegExp(
    String.raw`(?<![A-Za-z0-9-])--([A-Za-z][A-Za-z0-9-]{0,40})(?:=|\s{1,4}|\\?["']\s{0,4},\s{0,16})${VALUE}`,
    "dg",
  ),
];
const UNNAMED_PATTERNS: RegExp[] = [
  // `Authorization: Bearer …` in a curl header or a JSON `headers` object
  new RegExp(
    String.raw`(?<![A-Za-z0-9-])Authorization\\?["']?\s{0,4}:\s{0,4}\\?["']?(?:Bearer|Basic|token)\s{1,4}${VALUE}`,
    "dgi",
  ),
  // `curl -u user:pass`; scoped to curl because `-u` means a uid elsewhere.
  new RegExp(
    String.raw`\bcurl\b${SPAN}\s(?:-u|--user)(?:\s{1,4}|=)(?:\\?["'])?[^\s:"'\\]{1,128}:([^\s@"'\\$<>{}()*]{3,256})`,
    "dg",
  ),
  // `mysql -pS3cret`, `mysql -p'S3cret'`: the password is glued to the flag.
  new RegExp(String.raw`\b(?:mysql|mysqldump|mysqladmin|mariadb)\b${SPAN}\s-p${VALUE}`, "dg"),
  // `sshpass -p …`
  new RegExp(String.raw`\bsshpass\s{1,4}-p\s{0,4}${VALUE}`, "dg"),
  // `docker login -u me -p …`, `twine upload -u __token__ -p …`
  new RegExp(
    String.raw`\b(?:(?:docker|podman)\s{1,4}login|twine\s{1,4}upload)\b${SPAN}\s-p\s{1,4}${VALUE}`,
    "dg",
  ),
  // `redis-cli -a …`
  new RegExp(String.raw`\bredis-cli\b${SPAN}\s-a\s{1,4}${VALUE}`, "dg"),
];

// Template and documentation values: whole-word stand-ins, and fill-in markers
// anywhere in the value (`API_KEY_HERE`, `ghp_your_token_here`, `sk_test_xxxx`,
// `sk-proj-...`).
const PLACEHOLDER_VALUE =
  /^(?:redacted|test|todo|secret|password|passwd|pass|token|null|undefined|true|false|none|postgres|root|admin|guest|include|omit|same-origin)$/i;
const PLACEHOLDER_PART =
  /x{4,}|\.{3,}|\*{3,}|12345678|abcdef|example|placeholder|change[-_]?me|replace|dummy|fake|sample|your|(?:^|[^a-z])(?:my|insert|enter|here)(?:[^a-z]|$)/i;
// References resolved elsewhere: `$VAR`, `${VAR}`, `%VAR%`, `<token>`,
// `env:NAME`, `op://…`, a nested `key=value` option (`--secret id=npmrc`),
// and values shaped like a path, dotfile, flag or port. Only the whole shape
// counts: a generated password may start with `/`, `-`, `.` or `~`.
const REFERENCE_VALUE =
  /^(?:\$|%|<|(?:env|input|vault|secret):|op:\/\/|process\.env\b|os\.environ\b|[a-z][a-z0-9_-]*=[^=]|(?:~|\.{1,2})?\/[\w./-]*$|\.[\w.-]+$|-{1,2}[a-z][a-z0-9-]*$|[\d:.]+$)|\$\{/i;

function credentialValue(raw: string): string | null {
  const value = raw.replace(/^\\?'|'$/g, "").replace(/^\\?["']/, "");
  if (value.length < 3 || PLACEHOLDER_VALUE.test(value) || PLACEHOLDER_PART.test(value)) {
    return null;
  }
  // Case-sensitive on purpose: `GITHUB_TOKEN` names a variable, while
  // `s3cret_pass_word` is a value.
  if (/^[A-Z][A-Z0-9]*_[A-Z0-9_]+$/.test(value) || REFERENCE_VALUE.test(value)) return null;
  return value;
}

// Credentials with their 1-based line. The captured value identifies a
// credential across releases, so an edit elsewhere in the file, or elsewhere on
// the same command line, does not make a longstanding credential look new.
function inlineCredentials(text: string): Array<{ line: number; text: string }> {
  const found: Array<{ index: number; text: string }> = [];
  const scan = (pattern: RegExp, named: boolean) => {
    pattern.lastIndex = 0;
    for (const match of text.matchAll(pattern)) {
      const group = named ? 2 : 1;
      if (named) {
        const name = match[1] ?? "";
        if (!CREDENTIAL_NAME.test(name) || NON_CREDENTIAL_NAME.test(name)) continue;
      }
      const value = credentialValue(match[group] ?? "");
      if (value === null) continue;
      found.push({ index: match.indices?.[group]?.[0] ?? match.index, text: value });
    }
  };
  for (const pattern of NAMED_PATTERNS) scan(pattern, true);
  for (const pattern of UNNAMED_PATTERNS) scan(pattern, false);
  if (found.length === 0) return [];
  const lineStarts = [0];
  for (let index = text.indexOf("\n"); index !== -1; index = text.indexOf("\n", index + 1)) {
    lineStarts.push(index + 1);
  }
  return found
    .sort((a, b) => a.index - b.index)
    .map(({ index, text: value }) => ({ line: lineNumberAt(lineStarts, index), text: value }));
}

function lineNumberAt(lineStarts: number[], index: number): number {
  let low = 0;
  let high = lineStarts.length - 1;
  while (low < high) {
    const mid = (low + high + 1) >> 1;
    if (lineStarts[mid]! <= index) low = mid;
    else high = mid - 1;
  }
  return low + 1;
}

export function agentConfigFindings(ctx: RuleContext): Finding[] {
  const findings: Finding[] = [];
  for (const file of ctx.files) {
    const config = AGENT_CONFIG_FILES.find(({ pattern }) => pattern.test(file.path));
    if (!config) continue;
    const changed = ctx.diffByPath.get(file.path)?.status;
    if (changed === "removed") continue;
    const fresh = changed === "added" || changed === "modified";
    const credentials = inlineCredentials(file.textSample || "");
    const freshCredentials = freshInlineCredentials(
      credentials,
      changed,
      ctx.previousByPath.get(file.path),
    );
    const credential = credentials.length > 0;
    // Shared config is what templates ship, filled with stand-ins
    // (`password123`, `mysecret`), so a weak value there grades like personal
    // config without one: still reported, never enough to hold a release.
    const strong = (list: typeof credentials) =>
      list.length > 0 && (config.tier === "personal" || list.some(({ text }) => strongValue(text)));
    let severity: Finding["severity"];
    if (strong(credentials)) severity = strong(freshCredentials) ? "critical" : "high";
    else if (credential) severity = freshCredentials.length > 0 ? "medium" : "low";
    else severity = config.tier === "personal" && fresh ? "medium" : "low";
    findings.push(
      // A credential entering a test tree is a fresh leak, so only a
      // longstanding one demotes; config without one always does.
      testScope(
        isUnreachableTestFile(ctx, file.path) && (!credential || freshCredentials.length === 0),
        false,
        tag("fileAgentConfig", {
          severity,
          file: file.path,
          line: (freshCredentials[0] ?? credentials[0])?.line ?? 1,
          evidence: `${changedPrefix(ctx, file.path)}${config.label}${
            credential ? " with an inline credential" : ""
          }`,
          reason: credential
            ? "coding-agent config stores approved commands and server settings verbatim; this one carries a credential that ships to everyone who installs the package"
            : config.tier === "personal"
              ? "coding-agent credential stores and local settings are personal by design and can record approved commands with secrets in them; exclude them from the published files"
              : "coding-agent config is meant for the source repository; published copies disclose approved commands and tool servers",
        }),
      ),
    );
  }
  return findings;
}

function strongValue(value: string): boolean {
  const classes = [/[a-z]/, /[A-Z]/, /\d/, /[^A-Za-z0-9]/].filter((cls) => cls.test(value)).length;
  return value.length >= 12 && (classes >= 3 || (value.length >= 24 && classes >= 2));
}

function freshInlineCredentials(
  credentials: Array<{ line: number; text: string }>,
  changed: string | undefined,
  previous: FileRecord | undefined,
): Array<{ line: number; text: string }> {
  if (changed === "added") return credentials;
  if (changed !== "modified") return [];
  // No baseline bytes to compare: fail open to release delta.
  if (!previous?.textSample) return credentials;
  const before = new Set(inlineCredentials(previous.textSample).map(({ text }) => text));
  return credentials.filter(({ text }) => !before.has(text));
}
