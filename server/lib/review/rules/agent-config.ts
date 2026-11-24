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
// linear time.
//
// VALUE's one capture group is the credential, in one of three forms: single-
// quoted (shell-literal, so `$` is kept), double-quoted (a JSON string, spaces
// allowed), or a bare run. A quote that opens or closes on whitespace or spans
// a pipe is the edge of a neighbouring argument, as in
// `grep 'PASSWORD=' . | grep -v 'x'`. Regex syntax (`[`, `]`) ends a bare run so
// a search pattern such as `PASSWORD=[A-Za-z]{16}` is not read as a value.
const SINGLE_QUOTED = String.raw`\\?'(?![\s|])[^'\n\\|]{4,1024}(?<!\s)'`;
const DOUBLE_QUOTED = String.raw`\\?"(?![\s|])[^"\n\\|]{4,1024}(?<!\s)\\?"`;
const BARE = String.raw`[^\s"'\\$<>{}()[\]*,;%\x60]{4,1024}`;
const VALUE = String.raw`(${SINGLE_QUOTED}|${DOUBLE_QUOTED}|(?:\\?["'])?${BARE})`;
// A command's own arguments: the span after a command name stops at the end of
// a permission entry (`)`), a chain (`;`, `&&`, `|`) or the line, so the next
// command's `-p 3000:3000` is not this one's password.
const SPAN = String.raw`(?:[^\n;&|)]|&(?!&)){0,512}?`;

// The name a key/value pattern captured must end in a credential word, so
// `MAX_OUTPUT_TOKENS`, `TOKEN_FILE`, `tokenizer` and `--password-stdin` stay
// quiet while `PGPASSWORD`, `X-API-Key`, `accessToken`, `_authToken` match.
const CREDENTIAL_NAME =
  /(?:password|passwd|(?:^|[-_])pass|(?:^|[-_])pwd|token|secret|(?:secret|api|access|auth|private|role|service)[-_]?key|apikey|[-_]pat|credentials?)$/i;
const NON_CREDENTIAL_NAME = /(?:page|next|continuation|sync|cursor)[-_]?token$/i;

type Pattern = { regex: RegExp; nameGroup?: number; valueGroup: number; basicGroup?: number };
const PATTERNS: Pattern[] = [
  // `PGPASSWORD=…`, `"API_KEY": "…"`, `api_key = "…"` (TOML), `X-API-Key: …`
  {
    regex: new RegExp(
      String.raw`(?<![A-Za-z0-9_-])([A-Za-z_][A-Za-z0-9_-]{0,63})\\?["']?\s{0,16}[:=]\s{0,16}${VALUE}`,
      "dg",
    ),
    nameGroup: 1,
    valueGroup: 2,
  },
  // `--password=…`, `--db-token …`, and JSON arrays: `"--api-key", "…"`. A
  // value starting with `-` is the next flag, left for its own match.
  {
    regex: new RegExp(
      String.raw`(?<![A-Za-z0-9-])--([A-Za-z][A-Za-z0-9-]{0,40})(?:=|\s{1,4}|\\?["']\s{0,4},\s{0,16})(?!\\?["']?-)${VALUE}`,
      "dg",
    ),
    nameGroup: 1,
    valueGroup: 2,
  },
  // `Authorization: Bearer …` in a curl header, a JSON `headers` object or a
  // TOML `http_headers` table
  {
    regex: new RegExp(
      String.raw`(?<![A-Za-z0-9-])Authorization\\?["']?\s{0,16}[:=]\s{0,16}\\?["']?(Bearer|Basic|token)\s{1,4}(${BARE})`,
      "dgi",
    ),
    basicGroup: 1,
    valueGroup: 2,
  },
  // `curl -u user:pass`; scoped to curl because `-u` means a uid elsewhere.
  {
    regex: new RegExp(
      String.raw`\bcurl\b${SPAN}\s(?:-u|--user)(?:\s{1,4}|=)(?:\\?["'])?[^\s:"'\\]{1,128}:([^\s@"'\\$<>{}()*]{3,256})`,
      "dg",
    ),
    valueGroup: 1,
  },
  // `mysql -pS3cret`, `mysql -p'S3cret'`: the password is glued to the flag.
  {
    regex: new RegExp(
      String.raw`\b(?:mysql|mysqldump|mysqladmin|mariadb)\b${SPAN}\s-p${VALUE}`,
      "dg",
    ),
    valueGroup: 1,
  },
  { regex: new RegExp(String.raw`\bsshpass\s{1,4}-p\s{0,4}${VALUE}`, "dg"), valueGroup: 1 },
  // `docker login -u me -p …`, `twine upload -u __token__ -p …`
  {
    regex: new RegExp(
      String.raw`\b(?:(?:docker|podman)\s{1,4}login|twine\s{1,4}upload)\b${SPAN}\s-p\s{1,4}${VALUE}`,
      "dg",
    ),
    valueGroup: 1,
  },
  { regex: new RegExp(String.raw`\bredis-cli\b${SPAN}\s-a\s{1,4}${VALUE}`, "dg"), valueGroup: 1 },
];

// Template and documentation values: whole-word stand-ins, fill-in markers
// anywhere in the value (`API_KEY_HERE`, `ghp_your_token_here`, `sk_test_xxxx`,
// `sk-proj-...`), and prose (`"GitHub personal access token"`).
const PLACEHOLDER_VALUE =
  /^(?:redacted|test|todo|secret|password|passwd|pass|token|null|undefined|true|false|none|postgres|root|admin|guest|include|omit|same-origin)$/i;
const PLACEHOLDER_PART =
  /x{4,}|\.{3,}|\*{3,}|12345678|abcdef|example|placeholder|change[-_]?me|replace|dummy|fake|sample|your|(?:^|[^a-z])(?:my|insert|enter|here)(?:[^a-z]|$)/i;
const PROSE = /^[A-Za-z][A-Za-z'-]*(?: [A-Za-z'-]+){2,}[.!?]?$/;
// References resolved elsewhere: `%VAR%`, `<token>`, `env:NAME`, `op://…`, a
// nested `key=value` option (`--secret id=npmrc`), and values whose whole shape
// is a path, dotfile, flag or port. A generated password may start with `/`,
// `-`, `.` or `~`, so only the whole shape counts.
const REFERENCE_VALUE =
  /^(?:%|<|(?:env|input|vault|secret):|op:\/\/|process\.env\b|os\.environ\b|[a-z][a-z0-9_-]*=[^=]|(?:~|\.{1,2})?\/[\w./-]*$|\.[\w.-]+$|-{1,2}[a-z][a-z0-9-]*$|[\d:.]+$)/i;

// A variable's own name stands in for its value: `GITHUB_TOKEN` (word-shaped
// segments, unlike a generated `P9V0_5N7J_K4Q2`) or a snake- or camel-case
// identifier ending in a credential word (`McpServer_AUTH_TOKEN`, `apiKey`), as
// in Codex's `env_http_headers`.
function isVariableName(value: string): boolean {
  if (/^[A-Z][A-Z0-9]*(?:_[A-Z][A-Z0-9]*)+$/.test(value) && /[A-Z]{3,}/.test(value)) return true;
  return (
    /^[A-Za-z_][A-Za-z0-9_]*$/.test(value) &&
    /_|[a-z][A-Z]/.test(value) &&
    CREDENTIAL_NAME.test(value)
  );
}

function credentialValue(raw: string): string | null {
  const singleQuoted = /^\\?'/.test(raw);
  const value = raw.replace(/^\\?["']/, "").replace(/\\?["']$/, "");
  if (value.length < 3) return null;
  if (PLACEHOLDER_VALUE.test(value) || PLACEHOLDER_PART.test(value) || PROSE.test(value)) {
    return null;
  }
  // Shell single quotes keep `$` literal; anywhere else it is an expansion.
  if (value.includes("${") || (!singleQuoted && value.startsWith("$"))) return null;
  if (isVariableName(value) || REFERENCE_VALUE.test(value)) return null;
  return value;
}

// Basic auth is base64 of `user:pass`; judge the password, so a scaffolded
// `admin:admin` stays a dev default rather than a strong-looking base64 run.
function decodedBasicPassword(value: string): string | null {
  try {
    const decoded = atob(value);
    const colon = decoded.indexOf(":");
    return colon === -1 ? null : decoded.slice(colon + 1);
  } catch {
    return null;
  }
}

function strongValue(value: string): boolean {
  const classes = [/[a-z]/, /[A-Z]/, /\d/, /[^A-Za-z0-9]/].filter((cls) => cls.test(value)).length;
  return value.length >= 12 && (classes >= 3 || (value.length >= 24 && classes >= 2));
}

interface InlineCredential {
  /** Offsets of the credential text itself, quotes excluded. */
  start: number;
  end: number;
  /** Identifies the credential across releases. */
  value: string;
  strong: boolean;
  line: number;
}

// Bounds the memory a match-dense hostile file can cost. A file past the cap is
// already reported; credentials beyond it only miss line attribution and
// redaction, and fail open to release delta on the baseline side.
const MAX_CREDENTIALS = 256;

function scanCredentials(text: string, limit = MAX_CREDENTIALS): InlineCredential[] {
  const found: Array<Omit<InlineCredential, "line">> = [];
  const taken = new Set<number>();
  scan: for (const { regex, nameGroup, valueGroup, basicGroup } of PATTERNS) {
    regex.lastIndex = 0;
    for (const match of text.matchAll(regex)) {
      if (found.length >= limit) break scan;
      if (nameGroup !== undefined) {
        const name = match[nameGroup] ?? "";
        if (!CREDENTIAL_NAME.test(name) || NON_CREDENTIAL_NAME.test(name)) continue;
      }
      const raw = match[valueGroup] ?? "";
      const span = match.indices?.[valueGroup];
      if (!span) continue;
      const basic = basicGroup !== undefined && /^basic$/i.test(match[basicGroup] ?? "");
      const judged = basic ? decodedBasicPassword(raw) : raw;
      const value = judged === null ? null : credentialValue(judged);
      if (value === null) continue;
      const lead = /^\\?["']/.exec(raw)?.[0].length ?? 0;
      const trail = /\\?["']$/.exec(raw)?.[0].length ?? 0;
      const start = span[0] + lead;
      if (taken.has(start)) continue;
      taken.add(start);
      found.push({
        start,
        end: span[1] - trail,
        value: basic ? raw : value,
        strong: strongValue(value),
      });
    }
  }
  found.sort((a, b) => a.start - b.start);
  // One pass over the text for every line number: no per-line index array, so a
  // newline-dense file costs no more memory than a sparse one.
  let line = 1;
  let cursor = 0;
  return found.map((credential) => {
    for (
      let next = text.indexOf("\n", cursor);
      next !== -1 && next < credential.start;
      next = text.indexOf("\n", next + 1)
    ) {
      line += 1;
      cursor = next + 1;
    }
    return { ...credential, line };
  });
}

// Masks the credentials this rule finds before a sample is stored, shown in a
// public diff or handed to AI review. Returns the same string when nothing
// matched, so redaction keeps sharing the raw text for clean files.
export function redactAgentConfigCredentials(path: string, text: string): string {
  if (!agentConfigFor(path)) return text;
  const credentials = scanCredentials(text, 4096);
  if (credentials.length === 0) return text;
  let out = "";
  let cursor = 0;
  for (const { start, end } of credentials) {
    if (start < cursor) continue;
    out += `${text.slice(cursor, start)}[REDACTED_CREDENTIAL]`;
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
        .flatMap((file) => scanCredentials(file.textSample!).map(({ value }) => value)),
    );
    return baselineValues;
  };

  for (const file of ctx.files) {
    const config = agentConfigFor(file.path);
    if (!config) continue;
    const changed = ctx.diffByPath.get(file.path)?.status;
    if (changed === "removed") continue;
    const fresh = changed === "added" || changed === "modified";
    const credentials = scanCredentials(file.textSample || "");
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
