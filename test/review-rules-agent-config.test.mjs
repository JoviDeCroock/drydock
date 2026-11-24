import { describe, expect, test } from "vitest";
import {
  annotateFindingsWithDiffStatus,
  createPackageDiff,
  deterministicFindings,
  redactFileRecords,
} from "../server/lib/review";
import { computeScanRiskBreakdown } from "../server/lib/review/risk";

function file(path, textSample) {
  return { path, size: textSample.length, sha256: `${path}:${textSample}`, flags: [], textSample };
}

function settingsWith(allow) {
  return JSON.stringify({ permissions: { allow } }, null, 2);
}

function agentFindings(files, baseline) {
  const diff = baseline ? createPackageDiff(baseline, files) : [];
  return deterministicFindings(files, diff, null, { previousFiles: baseline ?? [] }).filter(
    (finding) => finding.ruleId === "file.agent-config",
  );
}

function addedLocalSettings(command) {
  const [finding] = agentFindings(
    [file(".claude/settings.local.json", settingsWith(["Bash(npm test)", command]))],
    [],
  );
  return finding;
}

describe("file.agent-config", () => {
  test.each([
    ["env assignment", "Bash(NPM_TOKEN=fixtureonlytoken npm publish)"],
    ["exported env", "Bash(export OPENAI_API_KEY=fixtureonlykey && node run.js)"],
    ["lowercase npm auth", "Bash(npm_config__authToken=fixtureonlytoken npm whoami)"],
    ["password flag", "Bash(mysql --password=fixtureonlypass -h db.example.invalid)"],
    ["prefixed flag", "Bash(deploy-cli --db-password fixtureonlypass)"],
    ["token flag", "Bash(deploy-cli --github-token fixtureonlytoken)"],
    [
      "authorization header",
      'Bash(curl -H "Authorization: Bearer fixtureonlytoken" https://api.example.invalid)',
    ],
    ["api key header", 'Bash(curl -H "X-API-Key: fixtureonlykey" https://api.example.invalid)'],
    ["gitlab header", 'Bash(curl -H "PRIVATE-TOKEN: fixtureonlytoken" https://x.example.invalid)'],
    ["curl basic auth", "Bash(curl --user deploy:fixtureonly https://api.example.invalid)"],
    ["mysql glued password", "Bash(mysql -u root -pFixtureOnly1 app)"],
    ["sshpass", "Bash(sshpass -p fixtureonlypass ssh deploy@host.example.invalid)"],
    ["docker login", "Bash(docker login -u deploy -p fixtureonlypass registry.example.invalid)"],
    ["twine upload", "Bash(twine upload -u __token__ -p fixtureonlypass dist/*)"],
    ["redis-cli", "Bash(redis-cli -h cache.example.invalid -a fixtureonlypass ping)"],
    ["quoted mysql password", "Bash(mysql -u root -p'FixtureOnly1' app)"],
    ["dollar in quoted value", "Bash(PGPASSWORD='fixture$$only!' psql -h db.example.invalid)"],
    ["pwd suffix", "Bash(MYSQL_PWD=fixtureonlypass mysql -h db.example.invalid)"],
    ["personal access token", "Bash(GITHUB_PAT=fixtureonlytoken gh api user)"],
    [
      "password starting with a slash",
      "Bash(AWS_SECRET_ACCESS_KEY=/k9Xq+Rz2PwLm8vT3bYc1NdF6gHj4sAe7uIo0EwQ aws s3 ls)",
    ],
    ["password starting with a dash", "Bash(PGPASSWORD=-Xy9#kP2!mQ psql -h db.example.invalid)"],
    ["password starting with a dot", "Bash(PGPASSWORD=.Hk29!xPq psql -h db.example.invalid)"],
    ["password starting with a tilde", "Bash(PGPASSWORD=~Pq83!zX psql -h db.example.invalid)"],
    [
      "base64 basic auth",
      'Bash(curl -H "Authorization: Basic Zml4dHVyZTpvbmx5cGFzcw==" https://x.invalid)',
    ],
  ])("lifts new local settings to critical on an inline credential: %s", (_label, command) => {
    const finding = addedLocalSettings(command);
    expect(finding).toMatchObject({ severity: "critical", line: 5 });
    expect(finding.evidence).toContain("with an inline credential");
  });

  test.each([
    ["env reference", "Bash(NPM_TOKEN=$NPM_TOKEN npm publish)"],
    ["braced reference", 'Bash(curl -H "Authorization: Bearer ${API_TOKEN}" https://x.invalid)'],
    ["angle placeholder", "Bash(deploy-cli --token <your-token>)"],
    ["word placeholder", "Bash(deploy-cli --password=changeme)"],
    ["elided key", "Bash(OPENAI_API_KEY=sk-... node run.js)"],
    ["replace-me", "Bash(API_KEY=REPLACE_ME npm start)"],
    ["dev default", "Bash(PGPASSWORD=postgres psql -h localhost)"],
    ["wildcard rule", "Bash(export API_KEY=:*)"],
    ["flag as value", "Bash(gh auth login --token --hostname github.example.invalid)"],
    ["token count", "Bash(CLAUDE_CODE_MAX_OUTPUT_TOKENS=32000 claude)"],
    ["token file path", "Bash(AWS_WEB_IDENTITY_TOKEN_FILE=/var/run/token aws sts)"],
    ["stdin password", "Bash(docker login --password-stdin registry.example.invalid)"],
    ["docker uid", "Bash(docker run -u 1000:1000 image)"],
    ["short value", "Bash(DEBUG_TOKEN=1 npm test)"],
    ["docker build secret mount", "Bash(docker build --secret id=npmrc,src=.npmrc .)"],
    [
      "chained port after docker login",
      "Bash(docker login ghcr.io && docker run -p 3000:3000 app)",
    ],
    ["chained flag after mysql", "Bash(mysql -e 'select 1' && find . -print0)"],
    ["doc credential pair", "Bash(curl -u user:pass https://httpbin.example.invalid)"],
    ["pagination token", "Bash(api-cli --page-token CAESBggDEAEYAQ)"],
    ["grep for a credential name", "Bash(grep -rn 'PASSWORD=' . | grep -v 'test')"],
    ["rg for a credential name", "Bash(rg 'API_KEY=' --glob '!*.md')"],
    ["path value", "Bash(GOOGLE_API_KEY=./keys/dev.key node run.js)"],
  ])("keeps new local settings at medium without a literal credential: %s", (_label, command) => {
    const finding = addedLocalSettings(command);
    expect(finding.severity).toBe("medium");
    expect(finding.evidence).not.toContain("inline credential");
  });

  test.each([
    ["header object", { headers: { Authorization: "Bearer Fx9-only-Token-0001" } }],
    ["args array", { command: "docs-mcp", args: ["--api-key", "Fx9-only-Key-0001"] }],
    ["env object", { command: "docs-mcp", env: { DOCS_API_KEY: "Fx9-only-Key-0001" } }],
    ["secret key", { command: "docs-mcp", env: { SECRET_KEY: "Fx9-only-Secret-0001" } }],
    [
      "service role key",
      { command: "db-mcp", env: { SUPABASE_SERVICE_ROLE_KEY: "fx9onlyrolekey0001fx9onlyrolekey" } },
    ],
  ])("reads MCP server credentials written as JSON: %s", (_label, server) => {
    const text = JSON.stringify({ mcpServers: { docs: server } }, null, 2);
    const [finding] = agentFindings([file(".mcp.json", text)], []);
    expect(finding.severity).toBe("critical");
  });

  test.each([
    ["fill-in suffix", { API_KEY: "API_KEY_HERE" }],
    ["prefixed fill-in", { GITHUB_TOKEN: "ghp_your_token_here" }],
    ["README example", { SLACK_BOT_TOKEN: "xoxb-your-bot-token" }],
    ["masked test key", { STRIPE_API_KEY: "sk_test_xxxxxxxx" }],
    ["elided project key", { OPENAI_API_KEY: "sk-proj-..." }],
    ["masked groups", { LICENSE_KEY_TOKEN: "xxxx-xxxx-xxxx" }],
    ["variable name", { GITHUB_TOKEN: "GITHUB_TOKEN" }],
    ["env reference", { AUTH_TOKEN: "env:MY_TOKEN" }],
    ["my- stand-in", { API_KEY: "my-api-key" }],
    ["my_ stand-in", { SECRET_TOKEN: "my_secret_token" }],
    ["sequential stand-in", { OPENAI_API_KEY: "sk-1234567890abcdef" }],
    ["uppercase fill-in", { GITHUB_TOKEN: "ghp_YOURTOKEN" }],
    ["fetch credentials mode", { credentials: "include" }],
  ])("keeps MCP template placeholders at low: %s", (_label, env) => {
    const text = JSON.stringify({ mcpServers: { docs: { command: "docs-mcp", env } } }, null, 2);
    const [finding] = agentFindings([file(".mcp.json", text)], []);
    expect(finding.severity).toBe("low");
  });

  test.each([
    ["stand-in", { DB_PASSWORD: "password123" }],
    ["short stand-in", { APP_SECRET: "supersecret" }],
    ["human password", { POSTGRES_PASSWORD: "S3cretPass" }],
    ["passphrase", { POSTGRES_PASSWORD: "correcthorsebattery" }],
  ])("reports weak shared-config values at medium, never enough to hold: %s", (_l, env) => {
    const text = JSON.stringify({ mcpServers: { db: { command: "db-mcp", env } } }, null, 2);
    const [finding] = agentFindings([file(".mcp.json", text)], []);
    expect(finding).toMatchObject({ severity: "medium", line: 6 });
    expect(finding.evidence).toContain("with an inline credential");
  });

  test("grades a longstanding credential high when the same line changed elsewhere", () => {
    const before = file(
      ".claude/settings.local.json",
      settingsWith(["Bash(curl -u deploy:fixtureonly https://api.example.invalid/v1)"]),
    );
    const after = file(
      ".claude/settings.local.json",
      settingsWith(["Bash(curl -s -u deploy:fixtureonly https://api.example.invalid/v2)"]),
    );
    const [finding] = agentFindings([after], [before]);
    expect(finding.severity).toBe("high");
  });

  test("grades a longstanding credential high when only another line changed", () => {
    const before = file(
      ".claude/settings.local.json",
      settingsWith(["Bash(NPM_TOKEN=fixtureonlytoken npm publish)"]),
    );
    const after = file(
      ".claude/settings.local.json",
      settingsWith(["Bash(NPM_TOKEN=fixtureonlytoken npm publish)", "Bash(npm run lint)"]),
    );
    const [finding] = agentFindings([after], [before]);
    expect(finding.severity).toBe("high");
  });

  test("points at the credential's own line", () => {
    const [finding] = agentFindings(
      [file("CLAUDE.local.md", "# notes\n\nNPM_TOKEN=fixtureonlytoken\n")],
      [],
    );
    expect(finding).toMatchObject({ severity: "critical", line: 3 });
  });

  test("grades tiers by release delta and credential content", () => {
    const local = file(".claude/settings.local.json", settingsWith(["Bash(npm test)"]));
    const shared = file(".claude/settings.json", settingsWith(["Bash(npm test)"]));
    const emptyStore = file(".claude/.credentials.json", '{"claudeAiOauth":null}');
    const store = file(".codex/auth.json", '{"tokens":{"refresh_token":"fixture-only-0000"}}');
    const files = [local, shared, emptyStore, store];
    expect(agentFindings(files, files).map((finding) => [finding.file, finding.severity])).toEqual([
      [".claude/settings.local.json", "low"],
      [".claude/settings.json", "low"],
      [".claude/.credentials.json", "low"],
      [".codex/auth.json", "high"],
    ]);
  });

  test("matches agent config at any depth but not look-alike names", () => {
    const findings = agentFindings(
      [
        file("templates/app/.mcp.json", "{}"),
        file("CLAUDE.local.md", "notes"),
        file("docs/claude-settings.json", "{}"),
        file("src/.claude/commands/review.md", "review"),
        file("mcp.json", "{}"),
      ],
      [],
    );
    expect(findings.map((finding) => [finding.file, finding.severity])).toEqual([
      ["templates/app/.mcp.json", "low"],
      ["CLAUDE.local.md", "medium"],
    ]);
  });

  test.each([
    ["credential-word runs", `"${"-TOKEN".repeat(170_000)}"`],
    ["repeated curl flags", `"${"curl -u ".repeat(130_000)}"`],
    ["repeated curl redirections", `"${"curl 2>&1 ".repeat(100_000)}"`],
    ["curl words in one argument", `"${"curl/".repeat(200_000)}"`],
    ["repeated mysql", `"${"mysql ".repeat(170_000)}"`],
    ["long identifiers", `${"A".repeat(1_000_000)}=x`],
  ])("scans a megabyte of hostile config in linear time: %s", (_label, text) => {
    const started = performance.now();
    agentFindings([file(".mcp.json", text)], []);
    expect(performance.now() - started).toBeLessThan(15_000);
  });

  // The scan pipeline runs rules on raw bytes but annotates release scope over
  // redacted samples; these cases go through that same path.
  function releaseView(staged, baseline) {
    const diff = createPackageDiff(baseline, staged);
    const findings = deterministicFindings(staged, diff, null, { previousFiles: baseline }).filter(
      (finding) => finding.ruleId === "file.agent-config",
    );
    const annotated = annotateFindingsWithDiffStatus(findings, diff, {
      previousFiles: redactFileRecords(baseline),
      stagedFiles: redactFileRecords(staged),
    });
    const { releaseRisk } = computeScanRiskBreakdown(annotated, {
      status: "unavailable",
      risk: "low",
      releaseAssessment: "not_assessed",
      summary: "AI review is disabled.",
      findings: [],
      requiresManualReview: false,
      model: null,
      reviewerVersion: null,
    });
    return {
      releaseRisk,
      findings: annotated.map((f) => [f.file, f.severity, f.releaseDelta]),
    };
  }

  test("a rotated credential is release delta even though redaction makes both lines read the same", () => {
    const view = releaseView(
      [file("CLAUDE.local.md", "notes\nNPM_TOKEN=fixtureoneonly\n")],
      [file("CLAUDE.local.md", "notes\nNPM_TOKEN=fixturetwoonly\n")],
    );
    expect(view).toEqual({
      releaseRisk: "critical",
      findings: [["CLAUDE.local.md", "critical", true]],
    });
  });

  test("a credential written into an empty baseline file is release delta", () => {
    const view = releaseView(
      [
        file(
          ".claude/settings.local.json",
          settingsWith(["Bash(PGPASSWORD=violetlane psql -h db.example.invalid)"]),
        ),
      ],
      [{ path: ".claude/settings.local.json", size: 0, sha256: "empty", flags: [] }],
    );
    expect(view.releaseRisk).toBe("critical");
  });

  test("an edit on a longstanding credential's line stays package context", () => {
    const view = releaseView(
      [
        file(
          ".claude/settings.local.json",
          settingsWith(["Bash(curl -s -u deploy:fixtureonly https://x.invalid/v2)"]),
        ),
      ],
      [
        file(
          ".claude/settings.local.json",
          settingsWith(["Bash(curl -u deploy:fixtureonly https://x.invalid/v1)"]),
        ),
      ],
    );
    expect(view).toEqual({
      releaseRisk: "low",
      findings: [[".claude/settings.local.json", "high", false]],
    });
  });

  test("a weak new value beside a longstanding strong one scores the release medium", () => {
    const mcp = (env) =>
      JSON.stringify({ mcpServers: { db: { command: "db-mcp", env } } }, null, 2);
    const view = releaseView(
      [file(".mcp.json", mcp({ AUTH_TOKEN: "Fx9-only-Token-0001", DB_PASSWORD: "password123" }))],
      [file(".mcp.json", mcp({ AUTH_TOKEN: "Fx9-only-Token-0001" }))],
    );
    expect(view).toEqual({
      releaseRisk: "medium",
      findings: [
        [".mcp.json", "medium", true],
        [".mcp.json", "high", false],
      ],
    });
  });

  test("a moved config keeps its credential's previous-release status", () => {
    const text = JSON.stringify({ mcpServers: { db: { env: { PGPASSWORD: "RavenStone349!" } } } });
    const view = releaseView(
      [file("templates/new/.mcp.json", text)],
      [file("templates/old/.mcp.json", text)],
    );
    expect(view.findings).toEqual([["templates/new/.mcp.json", "high", false]]);
  });

  test("redaction masks the credentials the rule finds, only in agent config", () => {
    const local = file(
      ".claude/settings.local.json",
      settingsWith([
        "Bash(PGPASSWORD=correcthorsebatterystaple psql)",
        "Bash(curl -u deploy:fixtureonlypass https://x.invalid)",
      ]),
    );
    const readme = file("README.md", "PGPASSWORD=correcthorsebatterystaple\n");
    const clean = file(".mcp.json", JSON.stringify({ mcpServers: {} }));
    const [redactedLocal, redactedReadme, redactedClean] = redactFileRecords([
      local,
      readme,
      clean,
    ]);
    expect(redactedLocal.textSample).not.toContain("correcthorsebatterystaple");
    expect(redactedLocal.textSample).not.toContain("fixtureonlypass");
    expect(redactedLocal.textSample).toContain("PGPASSWORD=[REDACTED_CREDENTIAL]");
    expect(redactedReadme.textSample).toBe(readme.textSample);
    expect(redactedClean.textSample).toBe(clean.textSample);
  });

  test.each([
    [
      "one-line permission entries",
      ".claude/settings.json",
      JSON.stringify({
        permissions: {
          allow: [
            "Bash(docker login ghcr.io)",
            "Bash(docker run -p 127.0.0.1:5432:5432/tcp my-app)",
          ],
        },
      }),
    ],
    [
      "regex search for a credential",
      ".claude/settings.json",
      settingsWith(["Bash(rg 'PASSWORD=[A-Za-z0-9_+/=-]{16}' src)"]),
    ],
    [
      "Codex env header names",
      ".codex/config.toml",
      '[mcp_servers.docs]\nenv_http_headers = { "X-API-Key" = "McpServer_Container_AUTH_TOKEN" }\n',
    ],
    [
      "base64 dev default",
      ".mcp.json",
      JSON.stringify({
        mcpServers: { local: { headers: { Authorization: "Basic YWRtaW46YWRtaW4=" } } },
      }),
    ],
  ])("stays below a credential grade: %s", (_label, path, text) => {
    const findings = agentFindings([file(path, text)], []);
    expect(findings.map((finding) => finding.severity)).toEqual(["low"]);
  });

  test.each([
    [
      "quoted URL with & before -u",
      ".claude/settings.local.json",
      settingsWith(["Bash(curl 'https://x.invalid/?a=1&b=2' -u deploy:fixtureonly)"]),
    ],
    [
      "Codex static Authorization header",
      ".codex/config.toml",
      '[mcp_servers.docs]\nhttp_headers = { "Authorization" = "Bearer Fx9-Only-Token-3487" }\n',
    ],
    [
      "flag after an ordinary flag",
      ".mcp.json",
      JSON.stringify({ mcpServers: { d: { args: ["--verbose", "--token=Fx9-Only-Token-3487"] } } }),
    ],
    [
      "JSON value with spaces",
      ".mcp.json",
      JSON.stringify({ mcpServers: { d: { env: { PGPASSWORD: "One Two More 547!" } } } }),
    ],
    ["wide gap after the colon", ".mcp.json", '{"API_KEY":     "Ravenstone11!"}'],
    [
      "single-quoted dollar",
      ".claude/settings.local.json",
      settingsWith(["Bash(PGPASSWORD='$violetlane!' psql)"]),
    ],
    [
      "generated underscore groups",
      ".mcp.json",
      JSON.stringify({ env: { PGPASSWORD: "P9V0_5N7J_K4Q2_D6R8" } }),
    ],
    [
      "plugin mcp.json",
      "mcp.json",
      JSON.stringify({
        mcpServers: { d: { headers: { Authorization: "Bearer Fx9-Only-Token-3487" } } },
      }),
    ],
  ])("finds the credential: %s", (_label, path, text) => {
    const [finding] = agentFindings([file(path, text)], []);
    expect(finding.severity).toBe("critical");
  });

  test("a rotation past the first 256 characters of a long token is new", () => {
    const token = (tail) => `Fx9-${"a1B2".repeat(80)}${tail}`;
    const text = (tail) => JSON.stringify({ env: { REFRESH_TOKEN: token(tail) } });
    const [finding] = agentFindings(
      [file(".mcp.json", text("-two"))],
      [file(".mcp.json", text("-one"))],
    );
    expect(finding.severity).toBe("critical");
  });

  test("line attribution in a newline-dense file stays cheap and exact", () => {
    const text = `${"\n".repeat(2_000_000)}NPM_TOKEN=fixtureonlytoken\n`;
    const started = performance.now();
    const [finding] = agentFindings([file("CLAUDE.local.md", text)], []);
    expect(performance.now() - started).toBeLessThan(15_000);
    expect(finding.line).toBe(2_000_001);
  });

  test("an alternate comparison baseline re-judges release scope by line diff", () => {
    const text = settingsWith(["Bash(PGPASSWORD=correcthorsebatterystaple psql)"]);
    const staged = [file(".claude/settings.local.json", text)];
    const [finding] = deterministicFindings(staged, createPackageDiff([], staged), null, {
      previousFiles: [],
    });
    const [annotated] = annotateFindingsWithDiffStatus(
      [finding],
      createPackageDiff(staged, staged),
      {
        previousFiles: redactFileRecords(staged),
        stagedFiles: redactFileRecords(staged),
        findingsMatchBaseline: false,
      },
    );
    expect(annotated).toMatchObject({ severity: "critical", releaseDelta: false });
  });

  test("an alternate comparison baseline leaves dynamic-load release scope to its severity", () => {
    const finding = {
      ruleId: "code.dynamic-load",
      severity: "high",
      file: "index.js",
      line: 1,
      evidence: "Module._extensions",
      reason: "loader",
      source: "deterministic",
    };
    const staged = [file("index.js", "Module._extensions['.ext'] = Module._extensions['.js'];")];
    const [annotated] = annotateFindingsWithDiffStatus(
      [finding],
      createPackageDiff(staged, staged),
      {
        previousFiles: staged,
        stagedFiles: staged,
        findingsMatchBaseline: false,
      },
    );
    expect(annotated.releaseDelta).toBe(true);
  });

  test("a generic secret rotation inside a credential span stays a visible change", () => {
    const text = (secret) => settingsWith([`Bash(curl -u deploy:${secret} https://x.invalid)`]);
    const [before] = redactFileRecords([file(".claude/settings.json", text("VioletBay82!"))]);
    const [after] = redactFileRecords([
      file(".claude/settings.json", text("npm_Q8zr4JkBwY6P2sFgT9hR5Tq-tail")),
    ]);
    expect(before.textSample).toContain("deploy:[REDACTED_CREDENTIAL]");
    expect(after.textSample).toContain("deploy:[REDACTED_NPM_TOKEN][REDACTED_CREDENTIAL]");
  });

  test("a value the generic redactor only partly recognises is masked whole", () => {
    const text = settingsWith(["Bash(PGPASSWORD=sk_live_9Fr68QnD3PPvB6mr-Arbor74! psql)"]);
    const [redacted] = redactFileRecords([file(".claude/settings.local.json", text)]);
    expect(redacted.textSample).toContain(
      "PGPASSWORD=[REDACTED_STRIPE_KEY][REDACTED_CREDENTIAL] psql",
    );
    expect(redacted.textSample).not.toContain("Arbor74");
  });

  test.each([
    ["a redirection before the flag", "Bash(curl 2>&1 -u deploy:CedarKite74! https://x.invalid)"],
    ["an &> redirection", "Bash(curl &>/dev/null -u deploy:CedarKite74! https://x.invalid)"],
    [
      "a long URL before the flag",
      `Bash(curl https://x.invalid/${"segment/".repeat(40)} -u deploy:CedarKite74!)`,
    ],
  ])("reads a curl password past %s", (_label, command) => {
    const text = settingsWith([command]);
    const [finding] = agentFindings([file(".claude/settings.json", text)], []);
    expect(finding.severity).toBe("critical");
    const [redacted] = redactFileRecords([file(".claude/settings.json", text)]);
    expect(redacted.textSample).not.toContain("CedarKite74");
  });

  test("a background & still ends the command", () => {
    const text = settingsWith(["Bash(curl https://x.invalid & docker run -u deploy:CedarKite74!)"]);
    const [finding] = agentFindings([file(".claude/settings.json", text)], []);
    expect(finding.severity).toBe("low");
  });

  test.each([
    [
      "a generated key with digit-led segments",
      '{"headers":{"X-API-Key":"KMR4_7A9X_B2Q8"}}',
      "critical",
    ],
    [
      "an env name with a numeric suffix",
      '{"headers":{"X-API-Key":"OPENROUTER_API_KEY_2"}}',
      "low",
    ],
  ])("grades %s in shared MCP config", (_label, text, severity) => {
    const [finding] = agentFindings([file(".mcp.json", text)], []);
    expect(finding.severity).toBe(severity);
  });

  test.each([
    [
      "a regex search for a token shape",
      "Bash(grep -E 'TOKEN=gh[pousr]_[A-Za-z0-9]+' sample.env)",
      "low",
    ],
    ["a negated class", "Bash(grep -E 'TOKEN=[^ ]+' sample.env)", "low"],
    [
      "a password with a bracketed literal",
      "Bash(PGPASSWORD=RainNightingale7![part2] psql)",
      "critical",
    ],
  ])("grades %s", (_label, command, severity) => {
    const [finding] = agentFindings([file(".claude/settings.json", settingsWith([command]))], []);
    expect(finding.severity).toBe(severity);
  });

  test("a value made of credential-name runs is read once", () => {
    const text = JSON.stringify({ note: "DBTOKEN=".repeat(500_000) });
    const started = performance.now();
    redactFileRecords([file(".mcp.json", text)]);
    agentFindings([file(".mcp.json", text)], []);
    expect(performance.now() - started).toBeLessThan(15_000);
  });

  test("redaction keeps a generic secret's own marker so its rotation still shows", () => {
    const mcp = (value) => JSON.stringify({ env: { AWS_ACCESS_KEY: value } }, null, 2);
    const [before] = redactFileRecords([file(".mcp.json", mcp("ArborVault!92"))]);
    const [after] = redactFileRecords([file(".mcp.json", mcp("AKIAAZ47HDC04YNM6VRS"))]);
    expect(before.textSample).toContain("[REDACTED_CREDENTIAL]");
    expect(after.textSample).toContain("[REDACTED_AWS_ACCESS_KEY]");
  });

  test("a rotation after a bracket in the password is new and fully masked", () => {
    const local = (value) =>
      file(".claude/settings.local.json", settingsWith([`Bash(PGPASSWORD=${value} psql)`]));
    const [finding] = agentFindings(
      [local("RainNightingale7![part2]")],
      [local("RainNightingale7![part1]")],
    );
    expect(finding.severity).toBe("critical");
    const [redacted] = redactFileRecords([local("RainNightingale7![part2]")]);
    expect(redacted.textSample).not.toContain("part2");
  });

  test("a long token is masked whole", () => {
    const tail = "Zq9".repeat(150);
    const token = `Fx9-${"a1B2".repeat(300)}${tail}`;
    const [redacted] = redactFileRecords([
      file(".mcp.json", JSON.stringify({ env: { ACCESS_TOKEN: token } })),
    ]);
    expect(redacted.textSample).not.toContain(tail);
  });

  test("repeats of an old credential do not crowd out a new one", () => {
    const old = Array.from(
      { length: 300 },
      (_, i) => `Bash(PGPASSWORD=orchidlantern psql -c 'select ${i}')`,
    );
    const before = file(".claude/settings.local.json", settingsWith(old));
    const after = file(
      ".claude/settings.local.json",
      settingsWith([...old, "Bash(PGPASSWORD=embermeadow psql)"]),
    );
    const findings = agentFindings([after], [before]);
    expect(findings.map((finding) => finding.severity)).toEqual(["critical"]);
  });

  test("a credential inside a hook command is found and masked", () => {
    const text = JSON.stringify({
      hooks: {
        SessionStart: [
          { hooks: [{ type: "command", command: "env PGPASSWORD=CedarKite74! psql" }] },
        ],
      },
    });
    const [finding] = agentFindings([file(".claude/settings.json", text)], []);
    expect(finding.severity).toBe("critical");
    const [redacted] = redactFileRecords([file(".claude/settings.json", text)]);
    expect(redacted.textSample).not.toContain("CedarKite74!");
  });

  test.each([
    [
      "background operator",
      "Bash(docker login ghcr.io & docker run -p 127.0.0.1:8432:8432/tcp demo)",
    ],
    ["shell-expanded double quotes", 'Bash(PGPASSWORD="db-$DB_PASS" psql)'],
  ])("reads no credential in local settings: %s", (_label, command) => {
    expect(addedLocalSettings(command)).toMatchObject({ severity: "medium" });
  });

  test.each([
    [
      "quoted argument with a parenthesis",
      "Bash(curl -A 'CI (Linux)' -u deploy:orchidlantern https://x.invalid)",
    ],
    ["single-quoted passphrase", "Bash(PGPASSWORD='birch zebra leaf moon' psql)"],
  ])("finds the credential in local settings: %s", (_label, command) => {
    expect(addedLocalSettings(command)).toMatchObject({ severity: "critical" });
  });

  test.each([
    [
      "Basic header with the key as username",
      ".mcp.json",
      JSON.stringify({ headers: { Authorization: `Basic ${btoa("Svrkey-5hPNvD73K6bQ:")}` } }),
      "critical",
    ],
    [
      "flag bound to a dash-leading password",
      ".mcp.json",
      JSON.stringify({ args: ["--db-password=-6tF7n95S3D!Px"] }),
      "critical",
    ],
    [
      "numbered env header name",
      ".codex/config.toml",
      '[mcp_servers.x]\nenv_http_headers = { "X-API-Key" = "OPENROUTER_API_KEY_2" }\n',
      "low",
    ],
  ])("grades %s", (_label, path, text, severity) => {
    const [finding] = agentFindings([file(path, text)], []);
    expect(finding.severity).toBe(severity);
  });

  test("many credentials on one minified line stay linear", () => {
    const line = Array.from({ length: 40_000 }, (_, i) => `"K${i}_TOKEN":"Fx9-only-${i}-Tk"`).join(
      ",",
    );
    const started = performance.now();
    redactFileRecords([file(".mcp.json", `{${line}}`)]);
    agentFindings([file(".mcp.json", `{${line}}`)], []);
    expect(performance.now() - started).toBeLessThan(15_000);
  });
});
