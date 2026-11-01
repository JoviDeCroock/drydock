import { afterEach, describe, expect, test, vi } from "vitest";
import {
  PyPiProjectTokensModel,
  type PyPiProjectToken,
} from "../src/pages/Dashboard/Settings/PyPiProjectTokensSection";
import { jsonResponse, stubFetchRoutes } from "./helpers/fetch-stub";

function token(overrides: Partial<PyPiProjectToken> = {}): PyPiProjectToken {
  return {
    id: "tok-1",
    projectName: "demo-package",
    indexOrigin: "https://pypi.org",
    repositoryId: 42,
    repositoryFullName: "octo/release",
    tokenFingerprint: "fp",
    tokenLast4: "abcd",
    validatedAt: 1,
    lastUsedAt: null,
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

describe("PyPiProjectTokensModel", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  test("adds a token without keeping the secret and reports a member's 403", async () => {
    let denied = false;
    const fetchMock = stubFetchRoutes({
      "/api/v1/pypi-project-tokens": (_url, init) => {
        if (init?.method !== "POST") {
          return jsonResponse({
            tokens: [],
            indexes: ["https://pypi.org"],
            repositories: [{ repositoryId: 42, repositoryFullName: "octo/release" }],
          });
        }
        if (denied) return jsonResponse({ error: "forbidden" }, 403);
        return jsonResponse({ token: token() }, 201);
      },
    });
    const model = new PyPiProjectTokensModel();
    await model.load();
    expect(model.loaded.value).toBe(true);
    expect(model.repositories.value).toEqual([
      { repositoryId: 42, repositoryFullName: "octo/release" },
    ]);

    expect(await model.add(" demo-package ", "https://pypi.org", 42, " pypi-secret ")).toEqual({
      ok: true,
    });
    const body = JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body));
    expect(body).toEqual({
      project: "demo-package",
      index: "https://pypi.org",
      repositoryId: 42,
      token: "pypi-secret",
    });
    expect(JSON.stringify(model.tokens.value)).not.toContain("pypi-secret");

    denied = true;
    expect(await model.add("other", "https://pypi.org", 42, "pypi-x")).toEqual({
      ok: false,
      message: "forbidden",
    });
    expect(model.busy.value).toBe(false);
  });

  test("a failed check surfaces the server reason and refreshes the row", async () => {
    stubFetchRoutes({
      "/validate": () =>
        jsonResponse({
          token: token({ validatedAt: null }),
          ok: false,
          error: "token is not project-scoped",
        }),
      "/api/v1/pypi-project-tokens": () =>
        jsonResponse({ tokens: [token()], indexes: ["https://pypi.org"] }),
    });
    const model = new PyPiProjectTokensModel();
    await model.load();
    expect(await model.validate("tok-1")).toEqual({
      ok: false,
      message: "token is not project-scoped",
    });
    expect(model.tokens.value[0]?.validatedAt).toBeNull();
  });
});
