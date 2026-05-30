import { describe, expect, test } from "vitest";
import { GITHUB_APP_UI_ALLOWLIST, isGithubAppUiEnabled } from "../src/lib/github-app-ui";

describe("GitHub App UI allowlist", () => {
  test("includes only the organizations approved for production testing", () => {
    expect([...GITHUB_APP_UI_ALLOWLIST]).toEqual(["personal:vMEkEjmZLH960ddSJzfT6N8Jxw2jTuHQ"]);
  });

  test("allowlisted organization can use the GitHub App UI", () => {
    expect(isGithubAppUiEnabled("personal:vMEkEjmZLH960ddSJzfT6N8Jxw2jTuHQ")).toBe(true);
  });

  test("a non-allowlisted organization is not in the allowlist", () => {
    expect(GITHUB_APP_UI_ALLOWLIST.has("personal:someone-else")).toBe(false);
  });
});
