import { describe, expect, test, vi } from "vitest";
import {
  PyPiSessionError,
  createPyPiSessionGateway,
  evaluatePyPiSessionRequest,
  openPyPiSession,
  parseSessionSnapshot,
  sessionBindingProblems,
} from "../server/lib/ecosystems/pypi/session-gateway";
import {
  inspectPyPiTokenScope,
  pyPiTokenProblem,
  sealPyPiToken,
} from "../server/lib/ecosystems/pypi/project-token";
import {
  FAKE_SESSION_TOKEN,
  buildFakeUploadSession,
  fakePyPiToken,
  sha256HexOf,
} from "./helpers/pep694-fake";

const STAGE = "https://pypi.org/stage/stgtok-1/";
const SESSION = `https://upload.pypi.org/2.0/sessions/${FAKE_SESSION_TOKEN}`;
const WHEEL = "demo_package-1.2.0-py3-none-any.whl";
const TOKEN = fakePyPiToken(["demo-package"]);

function routedFetch(routes: Record<string, (request: Request) => Response | Promise<Response>>) {
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(input, init);
    for (const [prefix, handler] of Object.entries(routes)) {
      if (request.url.startsWith(prefix)) return handler(request);
    }
    throw new Error(`unexpected fetch: ${request.url}`);
  });
}

describe("evaluatePyPiSessionRequest", () => {
  test.each([
    ["GET", SESSION, "https://pypi.org"],
    ["DELETE", SESSION, "https://pypi.org"],
    ["POST", `${SESSION}/publish`, "https://pypi.org"],
    ["GET", "https://test.pypi.org/2.0/sessions/abc", "https://test.pypi.org"],
    ["POST", "https://upload.pypi.org/2.0/", "https://pypi.org"],
  ])("allows %s %s for %s", (method, url, index) => {
    expect(evaluatePyPiSessionRequest(url, method, index).allowed).toBe(true);
  });

  test.each([
    ["http scheme", "http://upload.pypi.org/2.0/sessions/abc", "GET", "https://pypi.org"],
    ["foreign host", "https://evil.example/2.0/sessions/abc", "GET", "https://pypi.org"],
    ["suffix host", "https://upload.pypi.org.evil.example/s/abc", "GET", "https://pypi.org"],
    ["explicit port", "https://upload.pypi.org:8443/2.0/sessions/abc", "GET", "https://pypi.org"],
    ["credentials", "https://user:pw@upload.pypi.org/2.0/sessions/abc", "GET", "https://pypi.org"],
    ["query", `${SESSION}?next=https://evil.example`, "GET", "https://pypi.org"],
    ["fragment", `${SESSION}#x`, "GET", "https://pypi.org"],
    ["other index's origin", "https://test.pypi.org/2.0/sessions/abc", "GET", "https://pypi.org"],
    ["unknown index", SESSION, "GET", "https://evil.example"],
    ["unsupported method", SESSION, "PUT", "https://pypi.org"],
    [
      "a path outside the Upload 2.0 root",
      "https://pypi.org/legacy/",
      "DELETE",
      "https://pypi.org",
    ],
    ["GET on the bare root", "https://upload.pypi.org/2.0/", "GET", "https://pypi.org"],
    ["DELETE on the bare root", "https://upload.pypi.org/2.0/", "DELETE", "https://pypi.org"],
    ["a dot-segment escape", "https://pypi.org/2.0/../legacy/", "GET", "https://pypi.org"],
    ["an encoded escape", "https://pypi.org/2.0/%2e%2e/legacy/", "GET", "https://pypi.org"],
    ["an encoded slash", "https://pypi.org/2.0/x%2F..%2Flegacy", "GET", "https://pypi.org"],
    ["not a URL", "upload.pypi.org/2.0/sessions/abc", "GET", "https://pypi.org"],
  ])("refuses %s", (_label, url, method, index) => {
    expect(evaluatePyPiSessionRequest(url, method, index).allowed).toBe(false);
  });
});

describe("PyPiSessionGateway", () => {
  test("refuses a disallowed session URL before any request", () => {
    expect(() =>
      createPyPiSessionGateway({
        token: TOKEN,
        indexOrigin: "https://pypi.org",
        sessionUrl: "https://evil.example/2.0/sessions/abc",
        fetchImpl: vi.fn(),
      }),
    ).toThrow(PyPiSessionError);
  });

  test("never follows a redirect and never re-sends the token", async () => {
    const fetchImpl = routedFetch({
      [SESSION]: () =>
        new Response(null, { status: 302, headers: { location: "https://evil.example/steal" } }),
    });
    const gateway = createPyPiSessionGateway({
      token: TOKEN,
      indexOrigin: "https://pypi.org",
      sessionUrl: SESSION,
      fetchImpl,
    });
    await expect(gateway.status()).rejects.toMatchObject({ code: "session_redirect_refused" });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [, init] = fetchImpl.mock.calls[0];
    expect(init?.redirect).toBe("manual");
  });

  test("refuses a publish link the index points off the session's origin", async () => {
    const session = buildFakeUploadSession({
      stageUrl: STAGE,
      filenames: [WHEEL],
      links: { publish: "https://pypi.org/2.0/sessions/other/publish" },
    });
    const fetchImpl = routedFetch(session.routes);
    const gateway = createPyPiSessionGateway({
      token: TOKEN,
      indexOrigin: "https://pypi.org",
      sessionUrl: session.sessionUrl,
      fetchImpl,
    });
    const snapshot = await gateway.status();
    await expect(gateway.publish(snapshot)).rejects.toMatchObject({ code: "session_url_refused" });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  test("attaches the bearer token only to the session's own requests", async () => {
    const session = buildFakeUploadSession({ stageUrl: STAGE, filenames: [WHEEL], publish: 202 });
    const gateway = createPyPiSessionGateway({
      token: TOKEN,
      indexOrigin: "https://pypi.org",
      sessionUrl: session.sessionUrl,
      fetchImpl: routedFetch(session.routes),
    });
    const snapshot = await gateway.status();
    expect(await gateway.publish(snapshot)).toEqual({ status: 202 });
    expect(session.requests.map((request) => [request.method, request.url])).toEqual([
      ["GET", session.sessionUrl],
      ["POST", `${session.sessionUrl}/publish`],
    ]);
    for (const request of session.requests) expect(request.authorization).toBe(`Bearer ${TOKEN}`);
  });

  test("maps 404 to session_not_found and 409 to session_conflict", async () => {
    const session = buildFakeUploadSession({ stageUrl: STAGE, filenames: [WHEEL], publish: 409 });
    const gateway = createPyPiSessionGateway({
      token: TOKEN,
      indexOrigin: "https://pypi.org",
      sessionUrl: session.sessionUrl,
      fetchImpl: routedFetch(session.routes),
    });
    const snapshot = await gateway.status();
    await expect(gateway.publish(snapshot)).rejects.toMatchObject({ code: "session_conflict" });
    session.state.gone = true;
    await expect(gateway.status()).rejects.toMatchObject({ code: "session_not_found" });
  });

  test("error messages never carry the session URL or the token", async () => {
    const fetchImpl = routedFetch({ [SESSION]: () => new Response("boom", { status: 500 }) });
    const gateway = createPyPiSessionGateway({
      token: TOKEN,
      indexOrigin: "https://pypi.org",
      sessionUrl: SESSION,
      fetchImpl,
    });
    const error: unknown = await gateway.status().catch((err: unknown) => err);
    expect(error).toBeInstanceOf(PyPiSessionError);
    expect((error as Error).message).not.toContain(FAKE_SESSION_TOKEN);
    expect((error as Error).message).not.toContain(TOKEN);
  });
});

describe("Drydock-created sessions and uploads", () => {
  const options = (fetchImpl: typeof fetch) => ({
    token: TOKEN,
    indexOrigin: "https://pypi.org",
    fetchImpl,
    completionPollDelaysMs: [0, 0, 0],
  });

  test("creates the session at the index's Upload 2.0 root and binds to the issued URL", async () => {
    const session = buildFakeUploadSession({ stageUrl: STAGE });
    const opened = await openPyPiSession(options(routedFetch(session.routes)), {
      name: "demo-package",
      version: "1.2.0",
    });
    expect(opened.adopted).toBe(false);
    expect(opened.gateway.sessionUrl).toBe(session.sessionUrl);
    expect(session.requests).toEqual([
      { method: "POST", url: "https://upload.pypi.org/2.0/", authorization: `Bearer ${TOKEN}` },
    ]);
  });

  test("adopts the session a 409 points at, reading it before any change", async () => {
    const session = buildFakeUploadSession({ stageUrl: STAGE, adopt: true });
    const opened = await openPyPiSession(options(routedFetch(session.routes)), {
      name: "demo-package",
      version: "1.2.0",
    });
    expect(opened.adopted).toBe(true);
    expect(session.requests.map((request) => request.method)).toEqual(["POST", "GET"]);
  });

  test.each([
    ["a foreign host", "https://evil.example/2.0/sessions/x"],
    ["another allowed root's origin", "https://pypi.org/2.0/sessions/x"],
    ["the legacy upload API", "https://upload.pypi.org/legacy/"],
  ])("a 409 Location on %s never receives the token", async (_label, location) => {
    const fetchImpl = routedFetch({
      "https://upload.pypi.org/2.0/": () =>
        new Response("exists", { status: 409, headers: { location } }),
    });
    await expect(
      openPyPiSession(options(fetchImpl), { name: "demo-package", version: "1.2.0" }),
    ).rejects.toMatchObject({ code: "session_url_refused" });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  test("uploads bytes to the index's file_url and waits for processing to complete", async () => {
    const session = buildFakeUploadSession({ stageUrl: STAGE, processingReads: 2 });
    const { gateway, snapshot } = await openPyPiSession(options(routedFetch(session.routes)), {
      name: "demo-package",
      version: "1.2.0",
    });
    const bytes = new TextEncoder().encode("reviewed wheel");
    const upload = await gateway.createFileUpload(snapshot, {
      filename: WHEEL,
      size: bytes.byteLength,
      sha256: await sha256HexOf(bytes),
    });
    await gateway.uploadFileBytes(upload, bytes);
    await gateway.completeFileUpload(upload);
    expect(session.state.files.get(WHEEL)).toMatchObject({ status: "completed", bytes });
    for (const request of session.requests) expect(request.authorization).toBe(`Bearer ${TOKEN}`);
  });

  test("a file_url off the session's root is refused before the bytes or token go out", async () => {
    const session = buildFakeUploadSession({
      stageUrl: STAGE,
      fileUrl: () => "https://upload.pypi.org/legacy/",
    });
    const fetchImpl = routedFetch(session.routes);
    const { gateway, snapshot } = await openPyPiSession(options(fetchImpl), {
      name: "demo-package",
      version: "1.2.0",
    });
    const upload = await gateway.createFileUpload(snapshot, {
      filename: WHEEL,
      size: 1,
      sha256: "a".repeat(64),
    });
    const calls = fetchImpl.mock.calls.length;
    await expect(gateway.uploadFileBytes(upload, new Uint8Array(1))).rejects.toMatchObject({
      code: "session_url_refused",
    });
    expect(fetchImpl.mock.calls.length).toBe(calls);
  });

  test("a 200 from publish is reported as processing, not published", async () => {
    const session = buildFakeUploadSession({ stageUrl: STAGE, filenames: [WHEEL], publish: 200 });
    const gateway = createPyPiSessionGateway({
      ...options(routedFetch(session.routes)),
      sessionUrl: session.sessionUrl,
    });
    expect(await gateway.publish(await gateway.status())).toEqual({ status: 202 });
  });
});

describe("parseSessionSnapshot", () => {
  const valid = {
    meta: { "api-version": "2.0" },
    status: "open",
    "expires-at": "2026-11-07T00:00:00Z",
    links: { session: SESSION, publish: `${SESSION}/publish`, stage: STAGE },
    files: { [WHEEL]: { status: "completed" } },
  };

  test("reads status, expiry, links and files", () => {
    const snapshot = parseSessionSnapshot(valid);
    expect(snapshot?.status).toBe("open");
    expect(snapshot?.expiresAt?.toISOString()).toBe("2026-11-07T00:00:00.000Z");
    expect(snapshot?.links).toEqual({
      session: SESSION,
      publish: `${SESSION}/publish`,
      extend: null,
      stage: STAGE,
      upload: null,
    });
    expect([...(snapshot?.files.keys() ?? [])]).toEqual([WHEEL]);
  });

  test.each([
    ["an unknown api version", { ...valid, meta: { "api-version": "1.0" } }],
    ["an unknown status", { ...valid, status: "pending" }],
    ["no session link", { ...valid, links: { stage: STAGE } }],
    ["a malformed file entry", { ...valid, files: { [WHEEL]: "completed" } }],
  ])("rejects %s", (_label, raw) => {
    expect(parseSessionSnapshot(raw)).toBeNull();
  });
});

describe("sessionBindingProblems", () => {
  const expected = {
    project: "demo-package",
    version: "1.2.0",
    stageUrl: STAGE,
    filenames: [WHEEL],
  };
  const snapshot = (overrides: Record<string, unknown> = {}) =>
    parseSessionSnapshot({
      meta: { "api-version": "2.0" },
      status: "open",
      links: { session: SESSION, stage: STAGE },
      files: { [WHEEL]: { status: "completed" } },
      ...overrides,
    })!;

  test("an open session on the reviewed stage with the reviewed files is bound", () => {
    expect(sessionBindingProblems(snapshot(), expected)).toEqual([]);
  });

  test.each([
    [
      "a different stage",
      { links: { session: SESSION, stage: "https://pypi.org/stage/other/" } },
      /stage link/,
    ],
    ["a session that is not open", { status: "processing" }, /not open/],
    [
      "an extra file",
      { files: { [WHEEL]: { status: "completed" }, "x.whl": { status: "completed" } } },
      /x\.whl is in the session/,
    ],
    ["a missing file", { files: {} }, /reviewed but is not in the session/],
    ["an incomplete file", { files: { [WHEEL]: { status: "pending" } } }, /is pending/],
    ["another project echoed", { name: "other-package" }, /project other-package/],
    ["another version echoed", { version: "1.3.0" }, /version 1\.3\.0/],
  ])("flags %s", (_label, overrides, problem) => {
    expect(sessionBindingProblems(snapshot(overrides), expected).join("; ")).toMatch(problem);
  });

  test("an echoed name that normalizes to the project is accepted", () => {
    expect(
      sessionBindingProblems(snapshot({ name: "Demo_Package", version: "1.2.0" }), expected),
    ).toEqual([]);
  });
});

describe("PyPI project tokens", () => {
  test("reads the project caveat from a macaroon-shaped token", () => {
    expect(inspectPyPiTokenScope(TOKEN)).toEqual({ kind: "project", projects: ["demo-package"] });
    expect(inspectPyPiTokenScope(fakePyPiToken("user"))).toEqual({ kind: "user" });
    expect(inspectPyPiTokenScope("pypi-not-base64!!")).toEqual({ kind: "unknown" });
  });

  test("accepts only a token scoped to exactly the bound project", () => {
    expect(pyPiTokenProblem(TOKEN, "Demo_Package")).toBeNull();
    expect(pyPiTokenProblem(fakePyPiToken(["other-package"]), "demo-package")).toMatch(
      /other-package/,
    );
    expect(pyPiTokenProblem(fakePyPiToken(["demo-package", "other"]), "demo-package")).toMatch(
      /scoped to/,
    );
    expect(pyPiTokenProblem(fakePyPiToken("user"), "demo-package")).toMatch(/account/);
    expect(pyPiTokenProblem(`pypi-${"A".repeat(40)}`, "demo-package")).toMatch(/could not confirm/);
    expect(pyPiTokenProblem("ghp_notapypitoken000000000000000000", "demo-package")).toMatch(
      /starts with pypi-/,
    );
  });

  test("sealing keeps only ciphertext, a fingerprint and the last four characters", async () => {
    const sealed = await sealPyPiToken(
      { NPM_CONNECTIONS_ENCRYPTION_KEY: "0123456789abcdef0123456789abcdef" } as Cloudflare.Env,
      TOKEN,
    );
    expect(sealed.tokenCiphertext).not.toContain(TOKEN.slice(5, 25));
    expect(sealed.tokenFingerprint).toMatch(/^[0-9a-f]{16}$/);
    expect(sealed.tokenLast4).toBe(TOKEN.slice(-4));
  });
});
