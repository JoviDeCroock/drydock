import { describe, expect, test } from "vitest";
import { createPackageDiff, deterministicFindings } from "../server/lib/review";

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
    ["repeated mysql", `"${"mysql ".repeat(170_000)}"`],
    ["long identifiers", `${"A".repeat(1_000_000)}=x`],
  ])("scans a megabyte of hostile config in linear time: %s", (_label, text) => {
    const started = performance.now();
    agentFindings([file(".mcp.json", text)], []);
    expect(performance.now() - started).toBeLessThan(5_000);
  });
});
